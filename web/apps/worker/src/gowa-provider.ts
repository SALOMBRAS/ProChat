import { createSessionRequestSchema, requestContextSchema, whatsAppSessionSchema, type RequestContext, type SendableContent, type SessionStatus, type WhatsAppSession } from '@chatpro/contracts';
import { GowaClientError, type GowaClientPort, type GowaDevice } from './gowa-client.js';
import { assertSafeIdentifier } from './identifiers.js';
import { WorkerOperationError, type WorkerCommand } from './ports.js';
import { CommandBackedWhatsAppProvider } from './provider-operations.js';
import { gowaHistoryChat, gowaHistoryMessage, unmapped } from './gowa-history.adapter.js';
import { gowaContact, gowaGroup } from './gowa-contacts.adapter.js';
import { GowaSessionRegistry } from './gowa-session-registry.js';
import { InMemoryGowaSessionStore, newGowaSessionLink, type GowaReconciliationState, type GowaSessionLink, type GowaSessionStore } from './gowa-session-store.js';

type StoredSession = WhatsAppSession & { deviceId: string; providerStatus: string; reconciliationState: GowaReconciliationState; qr?: { value: string; expiresAt: string } };

/**
 * GOWA session adapter. The durable mapping is deliberately provider-neutral:
 * GOWA device IDs stay in the worker and are never part of dashboard contracts.
 */
export class GowaProvider extends CommandBackedWhatsAppProvider {
  readonly provider = 'gowa' as const;
  // Deliberately narrow. GOWA upstream exposes media, groups and history, but
  // this worker has not implemented them: capability describes what is wired,
  // not what the vendor could do.
  readonly capabilities = ['health', 'sessions', 'status', 'sendMessage', 'sendMedia', 'sendContent', 'reactions', 'contacts', 'history', 'groups'] as const;
  private readonly sessions = new Map<string, StoredSession>();
  private restored = false;

  constructor(private readonly client: GowaClientPort, private readonly registry = new GowaSessionRegistry(), private readonly store: GowaSessionStore = new InMemoryGowaSessionStore()) { super(); }

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
    if (command.type === 'sendMessage') return this.sendTextCommand(valid, command.wahaSession, command.chatId, command.text, command.mentions, command.linkPreview);
    if (command.type === 'getSession') return this.refresh(valid, this.require(valid, command.sessionId));
    if (command.type === 'connectSession') { await this.requestQRCode(valid, this.require(valid, command.sessionId)); return; }
    if (command.type === 'getQr') return this.qr(valid, this.require(valid, command.sessionId));
    if (command.type === 'logoutSession') { await this.logout(valid, this.require(valid, command.sessionId)); return; }
    if (command.type === 'removeSession') { await this.remove(valid, this.require(valid, command.sessionId)); return; }
    if (command.type === 'sendAttachment') return this.sendMediaCommand(valid, command.wahaSession, command.chatId, command.attachment);
    if (command.type === 'sendContent') return this.sendContentCommand(valid, command.wahaSession, command.chatId, command.content);
    if (command.type === 'sendReaction') return this.sendReactionCommand(valid, command.wahaSession, command.chatId, command.messageId, command.reaction);
    if (command.type === 'contactsPage') return this.contactsPageCommand(valid, command.wahaSession, command.offset, command.limit);
    if (command.type === 'syncIdentity') return this.syncIdentityCommand(valid, command.wahaSession, command.chatId, command.refreshGroup);
    if (command.type === 'historyPage') return this.historyPageCommand(valid, command.wahaSession, command.chatId, command.offset, command.limit);
    throw new WorkerOperationError('NOT_IMPLEMENTED', 'This GOWA operation is not implemented', valid.correlationId, { provider: this.provider, command: command.type });
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

  private async sendTextCommand(context: RequestContext, sessionId: string, chatId: string, text: string, mentions?: readonly string[], linkPreview?: boolean) {
    const stored = this.require(context, sessionId);
    const current = await this.refresh(context, stored);
    if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status });
    if (mentions?.length) throw new WorkerOperationError('NOT_IMPLEMENTED', 'GOWA text mentions are not implemented in this phase', context.correlationId, { provider: this.provider });
    if (linkPreview === false) throw new WorkerOperationError('NOT_IMPLEMENTED', 'GOWA does not expose link-preview control for text messages', context.correlationId, { provider: this.provider });
    const phone = this.directPhone(context, chatId);
    const sent = await this.call(context, () => this.client.sendText(stored.deviceId, phone, text));
    return { id: sent.id, pending: false, timestamp: new Date().toISOString() };
  }

  private async sendMediaCommand(context: RequestContext, sessionId: string, chatId: string, attachment: { type: 'image' | 'audio' | 'video' | 'document'; url: string; filename: string; mimeType: string; caption?: string; voiceNote?: boolean }) {
    const stored = await this.connected(context, sessionId);
    const kind = attachment.type === 'document' ? 'file' as const : attachment.type;
    // The URL is handed to GOWA, never the bytes — same contract ChatPro
    // already uses with WAHA, so the object stays private behind a signed URL.
    const sent = await this.call(context, () => this.client.sendMedia(stored.deviceId, kind, this.directPhone(context, chatId), { url: attachment.url, ...(attachment.caption ? { caption: attachment.caption } : {}), ...(attachment.voiceNote === undefined ? {} : { voiceNote: attachment.voiceNote }) }));
    return { id: sent.id, pending: false, timestamp: new Date().toISOString() };
  }

  private async sendContentCommand(context: RequestContext, sessionId: string, chatId: string, content: SendableContent) {
    const stored = await this.connected(context, sessionId);
    const phone = this.directPhone(context, chatId);
    if (content.kind === 'location') {
      // GOWA's /send/location has no title field. Dropping a title the operator
      // typed would be silent data loss, so it is refused instead.
      if (content.title) throw new WorkerOperationError('NOT_IMPLEMENTED', 'GOWA location messages do not carry a title', context.correlationId, { provider: this.provider });
      const sent = await this.call(context, () => this.client.sendLocation(stored.deviceId, phone, { latitude: content.latitude, longitude: content.longitude }));
      return { id: sent.id, pending: false, timestamp: new Date().toISOString() };
    }
    if (content.kind !== 'vcard') throw new WorkerOperationError('NOT_IMPLEMENTED', 'GOWA polls are not wired in this phase', context.correlationId, { provider: this.provider, kind: content.kind });
    // GOWA sends one contact per call, so N cards would become N messages and
    // ChatPro would persist a single outbound row for them. Refuse rather than
    // return an id that describes only part of what was sent.
    if (content.contacts.length !== 1) throw new WorkerOperationError('NOT_IMPLEMENTED', 'GOWA contact cards are limited to one contact per message', context.correlationId, { provider: this.provider, contacts: content.contacts.length });
    const [card] = content.contacts;
    // A raw vCard string has no name/phone pair to map onto GOWA's flat fields.
    if (!('phoneNumber' in card)) throw new WorkerOperationError('NOT_IMPLEMENTED', 'GOWA requires a structured contact, not a raw vCard', context.correlationId, { provider: this.provider });
    const sent = await this.call(context, () => this.client.sendContact(stored.deviceId, phone, { name: card.fullName, phoneNumber: card.phoneNumber }));
    return { id: sent.id, pending: false, timestamp: new Date().toISOString() };
  }

  private async sendReactionCommand(context: RequestContext, sessionId: string, chatId: string, messageId: string, reaction: string): Promise<void> {
    const stored = await this.connected(context, sessionId);
    // An empty emoji removes the reaction, which is how ChatPro already models it.
    await this.call(context, () => this.client.sendReaction(stored.deviceId, messageId, this.directPhone(context, chatId), reaction));
  }

  private async contactsPageCommand(context: RequestContext, sessionId: string, offset: number, limit: number) {
    const stored = this.require(context, sessionId);
    const page = await this.call(context, () => this.client.listContacts(stored.deviceId, { offset, limit }));
    // O contact list do GOWA só traz jid e name; o resto vem do enriquecimento.
    const items = page.items.map(gowaContact).filter((item): item is NonNullable<typeof item> => Boolean(item));
    return { items: items as unknown as Record<string, unknown>[], unsupported: unmapped(page.items.length, items.length), hasMore: page.hasMore };
  }

  /** Raw GOWA history never leaves this method: `gowa-history.adapter.ts`
   * translates every item, and `unsupported` counts what it could not map so a
   * silent gap in the history is visible instead of merely absent. */
  private async historyPageCommand(context: RequestContext, sessionId: string, chatId: string | undefined, offset: number, limit: number) {
    const stored = this.require(context, sessionId);
    if (!chatId) {
      const page = await this.call(context, () => this.client.listChats(stored.deviceId, { offset, limit }));
      const items = page.items.map(gowaHistoryChat).filter((item): item is Record<string, unknown> => Boolean(item));
      return { kind: 'chats' as const, items, unsupported: unmapped(page.items.length, items.length), hasMore: page.hasMore };
    }
    const page = await this.call(context, () => this.client.listMessages(stored.deviceId, chatId, { offset, limit }));
    const items = page.items.map(gowaHistoryMessage).filter((item): item is Record<string, unknown> => Boolean(item));
    return { kind: 'messages' as const, items, unsupported: unmapped(page.items.length, items.length), hasMore: page.hasMore };
  }

  /**
   * Identity sync is avatar-only for now. The group half is deliberately
   * refused: /group/info exists, but `openapi.yaml` names the response without
   * naming its fields, and mapping a shape we have not seen is the assumption
   * CLAUDE.md rule 7 exists to prevent. `groups` is not declared as a
   * capability for the same reason.
   */
  private async syncIdentityCommand(context: RequestContext, sessionId: string, chatId: string, refreshGroup: boolean) {
    const stored = this.require(context, sessionId);
    if (refreshGroup || chatId.toLowerCase().endsWith('@g.us')) {
      const raw = await this.call(context, () => this.client.getGroupParticipants(stored.deviceId, chatId));
      const group = gowaGroup({ group_id: chatId, participants: raw });
      if (!group) throw new WorkerOperationError('PROVIDER_CONTRACT_ERROR', 'GOWA group response is invalid', context.correlationId, { provider: this.provider });
      return { identity: null, group: { chatId: group.chatId, name: group.subject, pictureUrl: null, metadata: {}, participants: group.participants.map(p => ({ whatsappId: p.whatsappId, role: p.role })) } };
    }
    const phone = this.directPhone(context, chatId);
    const profilePictureUrl = await this.call(context, () => this.client.getAvatar(stored.deviceId, phone));
    return { identity: { whatsappId: chatId, canonicalWhatsappId: chatId, phone, name: null, pushName: null, shortName: null, profilePictureUrl }, group: null };
  }

  /** Every send goes through the same connection check the text path uses. */
  private async connected(context: RequestContext, sessionId: string): Promise<StoredSession> {
    const stored = this.require(context, sessionId);
    const current = await this.refresh(context, stored);
    if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status });
    return stored;
  }

  private async remove(context: RequestContext, stored: StoredSession): Promise<void> {
    await this.call(context, () => this.client.removeDevice(stored.deviceId));
    this.sessions.delete(this.key(stored.workspaceId, stored.id));
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

  /**
   * Recipient for GOWA's `phone` field.
   *
   * Group sending is supported, and that was established from the GOWA source
   * rather than from the OpenAPI, which only ever exemplifies user JIDs:
   * `utils.ParseJID` accepts any JID containing `@`, and
   * `utils.ValidateJidWithLogin` — the validator every `/send/*` handler calls —
   * only reaches the account check for `@s.whatsapp.net`. `utils.IsOnWhatsapp`
   * closes with "For non-user JIDs (groups, newsletters), skip validation" and
   * returns true, so a `@g.us` recipient passes untouched.
   * (pkg/utils/whatsapp.go, commit be8155c5.)
   *
   * A direct chat keeps sending bare digits, which is the shape already in use
   * and reported working; groups and LIDs send the full JID, since digits alone
   * would lose the server and address the wrong chat.
   */
  private directPhone(context: RequestContext, chatId: string): string {
    const direct = /^(\d{8,15})@c\.us$/.exec(chatId);
    if (direct) return direct[1];
    if (/^\d{5,25}@(g\.us|lid)$/.test(chatId)) return chatId;
    throw new WorkerOperationError('VALIDATION_ERROR', 'GOWA sending supports direct, group and LID chats only', context.correlationId);
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
