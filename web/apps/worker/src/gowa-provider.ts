import { createSessionRequestSchema, requestContextSchema, whatsAppSessionSchema, type RequestContext, type SessionStatus, type WhatsAppSession } from '@chatpro/contracts';
import { GowaClientError, type GowaClientPort, type GowaDevice } from './gowa-client.js';
import { assertSafeIdentifier } from './identifiers.js';
import { WorkerOperationError, type WhatsAppProvider, type WorkerCommand } from './ports.js';
import { GowaSessionRegistry } from './gowa-session-registry.js';
import { InMemoryGowaSessionStore, newGowaSessionLink, type GowaReconciliationState, type GowaSessionLink, type GowaSessionStore } from './gowa-session-store.js';

type StoredSession = WhatsAppSession & { deviceId: string; providerStatus: string; reconciliationState: GowaReconciliationState; qr?: { value: string; expiresAt: string } };

/**
 * GOWA session adapter. The durable mapping is deliberately provider-neutral:
 * GOWA device IDs stay in the worker and are never part of dashboard contracts.
 */
export class GowaProvider implements WhatsAppProvider {
  readonly provider = 'gowa' as const;
  readonly capabilities = ['health', 'sessions', 'status', 'sendMessage'] as const;
  private readonly sessions = new Map<string, StoredSession>();
  private restored = false;

  constructor(private readonly client: GowaClientPort, private readonly registry = new GowaSessionRegistry(), private readonly store: GowaSessionStore = new InMemoryGowaSessionStore()) {}

  health(): Promise<void> { return this.client.health(); }

  /** Rebuilds the runtime registry without deleting any remote or local record. */
  async restore(): Promise<WhatsAppSession[]> {
    if (this.restored) return [...this.sessions.values()].map(session => this.summary(session));
    const links = await this.store.list();
    this.registry.restore(links.map(link => ({ workspaceId: link.workspaceId, sessionId: link.sessionId, deviceId: link.providerDeviceId })));
    for (const link of links) this.sessions.set(this.key(link.workspaceId, link.sessionId), this.fromLink(link));
    try {
      const remote = await this.client.listDevices();
      const byId = new Map(remote.map(device => [device.id, device]));
      for (const link of links) await this.reconcile(link, byId.get(link.providerDeviceId));
    } catch (error) {
      // A transport outage proves nothing about an individual device. Keep the
      // previously persisted status and wait for a later successful refresh.
      if (!(error instanceof GowaClientError) || (error.kind !== 'unavailable' && error.kind !== 'timeout')) throw error;
    }
    this.restored = true;
    return [...this.sessions.values()].map(session => this.summary(session));
  }

  async execute(context: RequestContext, command: WorkerCommand) {
    const valid = requestContextSchema.parse(context);
    if (command.type === 'listSessions') return this.list(valid);
    if (command.type === 'createSession') return this.create(valid, command.sessionId, command.input);
    if (command.type === 'sendMessage') return this.sendText(valid, command.wahaSession, command.chatId, command.text, command.mentions, command.linkPreview);
    if (command.type === 'getSession') return this.refresh(valid, this.require(valid, command.sessionId));
    if (command.type === 'connectSession') { await this.requestQRCode(valid, this.require(valid, command.sessionId)); return; }
    if (command.type === 'getQr') return this.qr(valid, this.require(valid, command.sessionId));
    if (command.type === 'logoutSession') { await this.logout(valid, this.require(valid, command.sessionId)); return; }
    throw new WorkerOperationError('NOT_IMPLEMENTED', 'This GOWA operation is not implemented in the session phase', valid.correlationId, { provider: this.provider, command: command.type });
  }

  async shutdown(): Promise<void> {
    // GOWA owns remote sessions. Stopping the ChatPro worker must not log out a device.
  }

  private async create(context: RequestContext, sessionId: string, input: { name?: string }): Promise<WhatsAppSession> {
    const id = assertSafeIdentifier(sessionId, 'sessionId', context.correlationId);
    const body = createSessionRequestSchema.parse(input);
    const key = this.key(context.workspaceId, id);
    const existing = this.sessions.get(key);
    if (existing) return this.summary(existing);
    const mapping = this.registry.map(context.workspaceId, id);
    const now = new Date().toISOString();
    const stored: StoredSession = { ...whatsAppSessionSchema.parse({ id, workspaceId: context.workspaceId, name: body.name ?? id, status: 'connecting', createdAt: now, updatedAt: now }), deviceId: mapping.deviceId, providerStatus: 'unverified', reconciliationState: 'unverified' };
    // Persist before the remote call. If the response is lost after GOWA creates
    // the slot, startup reconciliation still knows exactly which device to check.
    await this.store.save(newGowaSessionLink({ workspaceId: stored.workspaceId, provider: 'gowa', sessionId: stored.id, sessionName: stored.name, providerDeviceId: stored.deviceId, providerStatus: stored.providerStatus, chatproStatus: stored.status, capabilities: [...this.capabilities], providerMetadata: {}, reconciliationState: 'unverified', lastReconciledAt: null }));
    this.sessions.set(key, stored);
    const device = await this.call(context, () => this.client.createDevice(mapping.deviceId));
    await this.observe(stored, device.state, this.statusFromDevice(device, false), 'healthy', new Date().toISOString());
    return this.summary(stored);
  }

  private async list(context: RequestContext): Promise<WhatsAppSession[]> {
    const remote = await this.call(context, () => this.client.listDevices());
    const byId = new Map(remote.map(device => [device.id, device]));
    for (const session of this.sessions.values()) {
      if (session.workspaceId !== context.workspaceId) continue;
      const device = byId.get(session.deviceId);
      await this.observe(session, device?.state ?? 'missing', device ? this.statusFromDevice(device, false) : 'error', device ? 'healthy' : 'missing', new Date().toISOString());
    }
    return [...this.sessions.values()].filter(session => session.workspaceId === context.workspaceId).map(session => this.summary(session));
  }

  private async refresh(context: RequestContext, stored: StoredSession): Promise<WhatsAppSession> {
    const state = await this.call(context, () => this.client.getSessionStatus(stored.deviceId));
    const providerStatus = state.isLoggedIn ? 'logged_in' : state.isConnected ? 'connected' : 'disconnected';
    await this.observe(stored, providerStatus, state.isLoggedIn ? 'connected' : stored.qr ? 'waiting_qr' : state.isConnected ? 'connecting' : 'disconnected', 'healthy', new Date().toISOString());
    if (stored.status === 'connected') stored.qr = undefined;
    return this.summary(stored);
  }

  private async sendText(context: RequestContext, sessionId: string, chatId: string, text: string, mentions?: readonly string[], linkPreview?: boolean) {
    const stored = this.require(context, sessionId);
    const current = await this.refresh(context, stored);
    if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status });
    if (mentions?.length) throw new WorkerOperationError('NOT_IMPLEMENTED', 'GOWA text mentions are not implemented in this phase', context.correlationId, { provider: this.provider });
    if (linkPreview === false) throw new WorkerOperationError('NOT_IMPLEMENTED', 'GOWA does not expose link-preview control for text messages', context.correlationId, { provider: this.provider });
    const phone = this.directPhone(context, chatId);
    const sent = await this.call(context, () => this.client.sendText(stored.deviceId, phone, text));
    return { id: sent.id, pending: false, timestamp: new Date().toISOString() };
  }

  private async requestQRCode(context: RequestContext, stored: StoredSession): Promise<void> {
    const login = await this.call(context, () => this.client.startLogin(stored.deviceId));
    const value = await this.call(context, () => this.client.fetchQrImage(login.qrLink));
    stored.qr = { value, expiresAt: new Date(Date.now() + login.qrDurationSeconds * 1_000).toISOString() };
    await this.observe(stored, 'connected', 'waiting_qr', 'healthy', new Date().toISOString());
  }

  private async qr(context: RequestContext, stored: StoredSession) {
    await this.refresh(context, stored);
    if (stored.status !== 'waiting_qr' || !stored.qr || new Date(stored.qr.expiresAt).getTime() <= Date.now()) {
      throw new WorkerOperationError('CONFLICT', 'QR code is not available for the current session status', context.correlationId, { status: stored.status });
    }
    // This is image data only. The GOWA URL and its device_id never leave the worker.
    return { sessionId: stored.id, workspaceId: stored.workspaceId, qr: stored.qr.value, expiresAt: stored.qr.expiresAt };
  }

  private async logout(context: RequestContext, stored: StoredSession): Promise<void> {
    await this.call(context, () => this.client.logout(stored.deviceId));
    stored.qr = undefined;
    await this.observe(stored, 'disconnected', 'disconnected', 'healthy', new Date().toISOString());
  }

  private async reconcile(link: GowaSessionLink, device: GowaDevice | undefined): Promise<void> {
    const stored = this.sessions.get(this.key(link.workspaceId, link.sessionId));
    if (!stored) return;
    await this.observe(stored, device?.state ?? 'missing', device ? this.statusFromDevice(device, false) : 'error', device ? 'healthy' : 'missing', new Date().toISOString());
  }

  private async observe(stored: StoredSession, providerStatus: string, chatproStatus: SessionStatus, reconciliationState: GowaReconciliationState, lastReconciledAt: string): Promise<void> {
    await this.store.updateObservation({ workspaceId: stored.workspaceId, sessionId: stored.id, providerStatus, chatproStatus, reconciliationState, lastReconciledAt });
    stored.providerStatus = providerStatus;
    stored.reconciliationState = reconciliationState;
    this.setStatus(stored, chatproStatus);
  }

  private require(context: RequestContext, sessionId: string): StoredSession {
    const id = assertSafeIdentifier(sessionId, 'sessionId', context.correlationId);
    const stored = this.sessions.get(this.key(context.workspaceId, id));
    if (!stored) throw new WorkerOperationError('NOT_FOUND', 'WhatsApp session not found', context.correlationId);
    return stored;
  }

  private fromLink(link: GowaSessionLink): StoredSession {
    return { ...whatsAppSessionSchema.parse({ id: link.sessionId, workspaceId: link.workspaceId, name: link.sessionName, status: link.chatproStatus, createdAt: link.createdAt, updatedAt: link.updatedAt }), deviceId: link.providerDeviceId, providerStatus: link.providerStatus, reconciliationState: link.reconciliationState };
  }

  private directPhone(context: RequestContext, chatId: string): string {
    const match = /^(\d{8,15})@c\.us$/.exec(chatId);
    if (!match) throw new WorkerOperationError('VALIDATION_ERROR', 'GOWA text sending currently supports direct @c.us chats only', context.correlationId);
    return match[1];
  }

  private statusFromDevice(device: GowaDevice, hasQr: boolean): SessionStatus {
    switch (device.state) {
      case 'logged_in': return 'connected';
      case 'connected': return hasQr ? 'waiting_qr' : 'connecting';
      case 'connecting': return 'connecting';
      case 'disconnected': return hasQr ? 'waiting_qr' : 'disconnected';
      default: return 'error';
    }
  }

  private setStatus(stored: StoredSession, status: SessionStatus): void {
    if (stored.status !== status) { stored.status = status; stored.updatedAt = new Date().toISOString(); }
  }

  private summary(stored: StoredSession): WhatsAppSession {
    const { deviceId: _deviceId, providerStatus: _providerStatus, reconciliationState: _reconciliationState, qr: _qr, ...session } = stored;
    return { ...session, managed: true };
  }

  private key(workspaceId: string, sessionId: string): string { return `${workspaceId}\u0000${sessionId}`; }

  private async call<T>(context: RequestContext, action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (!(error instanceof GowaClientError)) throw error;
      const code = error.kind === 'timeout' ? 'TIMEOUT' : error.kind === 'unavailable' || (error.status !== undefined && error.status >= 500) ? 'SERVICE_UNAVAILABLE' : error.kind === 'contract' ? 'PROVIDER_CONTRACT_ERROR' : error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'CONFLICT' : error.status === 400 ? 'VALIDATION_ERROR' : 'PROVIDER_CONTRACT_ERROR';
      const message = error.kind === 'timeout' ? 'GOWA request timed out' : error.kind === 'unavailable' ? 'GOWA provider is unavailable' : error.kind === 'contract' ? 'GOWA response contract is invalid' : `GOWA request failed with status ${error.status ?? 'unknown'}`;
      // Never include GOWA response bodies: they can contain device IDs or JIDs.
      throw new WorkerOperationError(code, message, context.correlationId, error.status ? { providerStatus: error.status } : {});
    }
  }
}
