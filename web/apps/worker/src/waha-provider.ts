import { createHash } from 'node:crypto';
import { createSessionRequestSchema, linkPreviewSchema, requestContextSchema, whatsAppSessionSchema, type RequestContext, type SendableContent, type SessionStatus, type WhatsAppSession } from '@chatpro/contracts';
import { assertSafeIdentifier } from './identifiers.js'; import { WorkerOperationError, type WhatsAppWorkerPort, type WorkerCommand } from './ports.js'; import { detached } from './request-deadline.js'; import { WahaClientError, type WahaClientPort, type WahaSession } from './waha-client.js'; import type { WahaSessionRegistryEntry } from './waha-session-registry.js';
const statusMap: Record<string, SessionStatus> = { STOPPED: 'stopped', STARTING: 'connecting', AUTHENTICATED: 'connecting', SYNCING: 'connecting', SCAN_QR_CODE: 'waiting_qr', WORKING: 'connected', READY: 'connected', CONNECTED: 'connected', FAILED: 'error', LOGGED_OUT: 'disconnected' }; type StoredSession = WhatsAppSession & { wahaName: string; aliases: string[] }; type Registry = { load(): Promise<WahaSessionRegistryEntry[]>; save(entries: WahaSessionRegistryEntry[]): Promise<void> };
export class WahaProvider implements WhatsAppWorkerPort {
  private readonly sessions = new Map<string, StoredSession>(); private readonly pendingCreates = new Map<string, Promise<void>>(); private readonly orphans = new Map<string, WahaSession[]>(); private restored = false;
  constructor(private readonly client: WahaClientPort, private readonly qrTtlMs: number, private readonly registry: Registry = { load: async () => [], save: async () => undefined }) {}
  async execute(context: RequestContext, command: WorkerCommand) { await this.restore(); if (command.type === 'listSessions') { await this.reconcile(context.workspaceId); return [...[...this.sessions.values()].filter(session => session.workspaceId === context.workspaceId).map(session => this.summary(session)), ...(this.orphans.get(context.workspaceId) ?? []).map(remote => this.orphan(context.workspaceId, remote))]; } if (command.type === 'createSession') return this.create(context, command.sessionId, command.input); if (command.type === 'sendMessage') return this.sendText(context, command.wahaSession, command.chatId, command.text, command.mentions, command.linkPreview); if (command.type === 'sendAttachment') return this.sendAttachment(context, command.wahaSession, command.chatId, command.attachment); if (command.type === 'sendContent') return this.sendContent(context, command.wahaSession, command.chatId, command.content); if (command.type === 'sendReaction') return this.sendReaction(context, command.wahaSession, command.chatId, command.messageId, command.reaction); if (command.type === 'syncIdentity') return this.syncIdentity(context, command); if (command.type === 'historyPage') return this.historyPage(context, command); if (command.type === 'contactsPage') return this.contactsPage(context, command); if (command.type === 'lidsPage') return this.lidsPage(context, command); const stored = this.require(context, command.sessionId); if (command.type === 'getSession') return this.refresh(context, stored); if (command.type === 'connectSession') { await this.pendingCreates.get(this.key(context.workspaceId, stored.id)); await this.call(context, () => this.client.startSession(stored.wahaName)); await this.refresh(context, stored); return; } if (command.type === 'disconnectSession') { await this.call(context, () => this.client.stopSession(stored.wahaName)); this.setStatus(stored, 'stopped'); return; } if (command.type === 'logoutSession') { await this.call(context, () => this.client.logoutSession(stored.wahaName)); this.setStatus(stored, 'disconnected'); return; } if (command.type === 'getQr') return this.qr(context, stored); await this.call(context, () => this.client.removeSession(stored.wahaName)); this.sessions.delete(this.key(context.workspaceId, stored.id)); await this.persist(); }
  async shutdown(): Promise<void> { /* WAHA sessions are durable runtime resources; stopping the worker must not alter their remote state. */ }
  private async create(context: RequestContext, sessionId: string, input: { name?: string }): Promise<WhatsAppSession> {
    const valid = requestContextSchema.parse(context); const id = assertSafeIdentifier(sessionId, 'sessionId', context.correlationId); const body = createSessionRequestSchema.parse(input); const key = this.key(valid.workspaceId, id);
    const existing = this.sessions.get(key);
    if (existing) { this.provision(context, key, existing); return { ...existing }; }
    const now = new Date().toISOString();
    // Persist the deterministic WAHA name before making the remote call. A
    // late WAHA success can therefore always be reconciled after a restart.
    const stored: StoredSession = { ...whatsAppSessionSchema.parse({ id, workspaceId: valid.workspaceId, name: body.name ?? id, status: 'connecting', createdAt: now, updatedAt: now }), wahaName: this.wahaName(valid.workspaceId, id), aliases: [] };
    this.sessions.set(key, stored); await this.persist(); this.provision(context, key, stored); return { ...stored };
  }
  private provision(context: RequestContext, key: string, stored: StoredSession): void {
    if (this.pendingCreates.has(key)) return;
    // Provisioning continues after the command that started it has been
    // answered, and a later `connectSession` awaits this same promise, so it
    // must not run on the budget of whichever command happened to create it.
    const operation = detached(() => (async () => {
      try {
        const remote = await this.client.createSession(stored.wahaName);
        this.setStatus(stored, statusMap[remote.status.toUpperCase()] ?? 'error');
      } catch (error) {
        // POST is not safely retryable by itself: WAHA may have created the
        // session just before closing the connection. Reconcile by name.
        if (error instanceof WahaClientError && (error.interrupted || error.status === 409)) {
          try { const remote = await this.client.getSession(stored.wahaName); this.setStatus(stored, statusMap[remote.status.toUpperCase()] ?? 'error'); return; } catch { /* preserve the durable mapping for the next status/create retry */ }
        }
        this.setStatus(stored, 'error');
      } finally { this.pendingCreates.delete(key); }
    })());
    this.pendingCreates.set(key, operation);
  }
  private async restore(): Promise<void> { if (this.restored) return; for (const entry of await this.registry.load()) { const now = new Date().toISOString(); const stored: StoredSession = { ...whatsAppSessionSchema.parse({ id: entry.sessionId, workspaceId: entry.workspaceId, name: entry.name, status: 'disconnected', createdAt: now, updatedAt: now }), wahaName: entry.wahaName, aliases: entry.aliases ?? [] }; this.sessions.set(this.key(entry.workspaceId, entry.sessionId), stored); } this.restored = true; }
  private async persist(): Promise<void> { await this.registry.save([...this.sessions.values()].map(({ id, workspaceId, name, wahaName, aliases }) => ({ sessionId: id, workspaceId, name, wahaName, ...(aliases.length ? { aliases } : {}) }))); }
  private async qr(context: RequestContext, stored: StoredSession) {
    await this.refresh(context, stored);
    if (stored.status !== 'waiting_qr') throw this.qrUnavailable(context, stored);
    try {
      const qr = await this.client.getQr(stored.wahaName);
      return { sessionId: stored.id, workspaceId: stored.workspaceId, qr, expiresAt: new Date(Date.now() + this.qrTtlMs).toISOString() };
    } catch (error) {
      if (error instanceof WahaClientError && (error.interrupted || error.status === 404 || error.status === 422)) {
        await this.refresh(context, stored);
        throw this.qrUnavailable(context, stored);
      }
      throw await this.call(context, async () => { throw error; });
    }
  }
  private async sendText(context: RequestContext, wahaSession: string, chatId: string, text: string, mentions?: readonly string[], linkPreview?: boolean) { requestContextSchema.parse(context); const stored = [...this.sessions.values()].find(session => session.workspaceId === context.workspaceId && this.matchesWaha(session, wahaSession)); if (!stored) throw new WorkerOperationError('NOT_FOUND', 'WhatsApp session not found', context.correlationId); const current = await this.refresh(context, stored); if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status }); const sent = await this.call(context, () => this.client.sendText(stored.wahaName, chatId, text, mentions, linkPreview)); const parsedPreview = sent.linkPreview ? linkPreviewSchema.safeParse(sent.linkPreview) : undefined; return { ...(sent.id ? { id: sent.id } : {}), pending: sent.pending, timestamp: new Date().toISOString(), ...(parsedPreview?.success ? { linkPreview: parsedPreview.data } : {}) }; }
  private async sendAttachment(context: RequestContext, wahaSession: string, chatId: string, attachment: Extract<WorkerCommand, { type: 'sendAttachment' }>['attachment']) { requestContextSchema.parse(context); const stored = [...this.sessions.values()].find(session => session.workspaceId === context.workspaceId && this.matchesWaha(session, wahaSession)); if (!stored) throw new WorkerOperationError('NOT_FOUND', 'WhatsApp session not found', context.correlationId); const current = await this.refresh(context, stored); if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status }); const sent = await this.call(context, () => this.client.sendAttachment(stored.wahaName, chatId, attachment)); return { ...(sent.id ? { id: sent.id } : {}), pending: sent.pending, timestamp: new Date().toISOString() }; }
  /**
   * The content was already validated against the transport contract before it
   * reached here, so this only has to resolve the session and pick the provider
   * call. Each kind gets its own arm and the default is unreachable by type: a
   * new kind added to the contract fails to compile here instead of being
   * accepted and silently dropped.
   */
  private async sendContent(context: RequestContext, wahaSession: string, chatId: string, content: SendableContent) {
    requestContextSchema.parse(context);
    const stored = [...this.sessions.values()].find(session => session.workspaceId === context.workspaceId && this.matchesWaha(session, wahaSession));
    if (!stored) throw new WorkerOperationError('NOT_FOUND', 'WhatsApp session not found', context.correlationId);
    const current = await this.refresh(context, stored);
    if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status });
    switch (content.kind) {
      case 'location': {
        const sent = await this.call(context, () => this.client.sendLocation(stored.wahaName, chatId, { latitude: content.latitude, longitude: content.longitude, ...(content.title ? { title: content.title } : {}) }));
        return { ...(sent.id ? { id: sent.id } : {}), pending: sent.pending, timestamp: new Date().toISOString() };
      }
      case 'vcard': {
        const sent = await this.call(context, () => this.client.sendContactVcard(stored.wahaName, chatId, content.contacts));
        return { ...(sent.id ? { id: sent.id } : {}), pending: sent.pending, timestamp: new Date().toISOString() };
      }
      case 'poll':
        throw new WorkerOperationError('NOT_IMPLEMENTED', `Sending ${content.kind} is not implemented yet`, context.correlationId, { kind: content.kind });
      default: {
        const unreachable: never = content;
        throw new WorkerOperationError('VALIDATION_ERROR', 'Unsupported content kind', context.correlationId, { kind: (unreachable as { kind?: string }).kind });
      }
    }
  }
  private async sendReaction(context: RequestContext, wahaSession: string, chatId: string, messageId: string, reaction: string) { requestContextSchema.parse(context); const stored = [...this.sessions.values()].find(session => session.workspaceId === context.workspaceId && this.matchesWaha(session, wahaSession)); if (!stored) throw new WorkerOperationError('NOT_FOUND', 'WhatsApp session not found', context.correlationId); const current = await this.refresh(context, stored); if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status }); await this.call(context, () => this.client.sendReaction(stored.wahaName, messageId, reaction)); return { timestamp: new Date().toISOString() }; }
  private async syncIdentity(context: RequestContext, command: Extract<WorkerCommand, { type: 'syncIdentity' }>) { requestContextSchema.parse(context); const stored = [...this.sessions.values()].find(session => session.workspaceId === context.workspaceId && this.matchesWaha(session, command.wahaSession)); if (!stored) throw new WorkerOperationError('NOT_FOUND', 'WhatsApp session not found', context.correlationId); const current = await this.refresh(context, stored); if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status }); const identityId = command.senderWhatsappId ?? command.chatId; const identity = command.refreshIdentity ? await this.call(context, () => this.client.getIdentity(stored.wahaName, identityId)) : null; const group = command.refreshGroup ? await this.call(context, () => this.client.getGroup(stored.wahaName, command.chatId)) : null; return { identity, group }; }
  private async historyPage(context: RequestContext, command: Extract<WorkerCommand, { type: 'historyPage' }>) { requestContextSchema.parse(context); const stored = [...this.sessions.values()].find(session => session.workspaceId === context.workspaceId && this.matchesWaha(session, command.wahaSession)); if (!stored) throw new WorkerOperationError('NOT_FOUND', 'WhatsApp session not found', context.correlationId); const current = await this.refresh(context, stored); if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status }); const page = command.chatId ? await this.call(context, () => this.client.listMessages(stored.wahaName, command.chatId!, command.offset, command.limit)) : await this.call(context, () => this.client.listChats(stored.wahaName, command.offset, command.limit)); return { kind: command.chatId ? 'messages' as const : 'chats' as const, ...page }; }
  /** Mesmas travas do `historyPage`: a agenda só existe enquanto a sessão está
   *  conectada, e o erro precisa chegar ao job com o código (CONFLICT com o
   *  status) que o operador consegue entender — não um 500 genérico. */
  private async contactsPage(context: RequestContext, command: Extract<WorkerCommand, { type: 'contactsPage' }>) { requestContextSchema.parse(context); const stored = [...this.sessions.values()].find(session => session.workspaceId === context.workspaceId && this.matchesWaha(session, command.wahaSession)); if (!stored) throw new WorkerOperationError('NOT_FOUND', 'WhatsApp session not found', context.correlationId); const current = await this.refresh(context, stored); if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status }); return this.call(context, () => this.client.listContacts(stored.wahaName, command.offset, command.limit)); }
  /** O mapa LID → número real segue o mesmo caminho da agenda: mesma sessão,
   *  mesma exigência de conexão, mesma paginação por offset. */
  private async lidsPage(context: RequestContext, command: Extract<WorkerCommand, { type: 'lidsPage' }>) { requestContextSchema.parse(context); const stored = [...this.sessions.values()].find(session => session.workspaceId === context.workspaceId && this.matchesWaha(session, command.wahaSession)); if (!stored) throw new WorkerOperationError('NOT_FOUND', 'WhatsApp session not found', context.correlationId); const current = await this.refresh(context, stored); if (current.status !== 'connected') throw new WorkerOperationError('CONFLICT', 'WhatsApp session is not connected', context.correlationId, { status: current.status }); return this.call(context, () => this.client.listLidMappings(stored.wahaName, command.offset, command.limit)); }
  private qrUnavailable(context: RequestContext, stored: StoredSession): WorkerOperationError { return new WorkerOperationError('CONFLICT', 'QR code is not available for the current session status', context.correlationId, { status: stored.status }); }
  private async reconcile(workspaceId: string): Promise<void> {
    const remote = await this.client.listSessions(); const linked = [...this.sessions.values()].filter(session => session.workspaceId === workspaceId); const remoteByName = new Map(remote.map(session => [session.name, session])); const claimed = new Set(linked.flatMap(session => [session.wahaName, ...session.aliases])); let changed = false;
    for (const session of linked) {
      const current = remoteByName.get(session.wahaName);
      if (current) { this.setStatus(session, statusMap[current.status.toUpperCase()] ?? 'error'); continue; }
      const candidates = remote.filter(item => !claimed.has(item.name) && this.compatible(item));
      if (candidates.length !== 1) { this.setStatus(session, 'error'); continue; }
      const replacement = candidates[0]; session.aliases = [...new Set([...session.aliases, session.wahaName])]; session.wahaName = replacement.name; claimed.add(replacement.name); this.setStatus(session, statusMap[replacement.status.toUpperCase()] ?? 'error'); changed = true;
    }
    if (changed) await this.persist(); const activeNames = new Set(linked.map(session => session.wahaName)); this.orphans.set(workspaceId, remote.filter(session => !activeNames.has(session.name)));
  }
  private compatible(session: WahaSession): boolean { return ['STARTING', 'AUTHENTICATED', 'SYNCING', 'SCAN_QR_CODE', 'WORKING', 'READY', 'CONNECTED'].includes(session.status.toUpperCase()); }
  private summary(session: StoredSession): WhatsAppSession { return { ...session, managed: true }; }
  private orphan(workspaceId: string, remote: WahaSession): WhatsAppSession { const now = new Date().toISOString(); return { id: remote.name, workspaceId, name: remote.name, status: statusMap[remote.status.toUpperCase()] ?? 'error', createdAt: now, updatedAt: now, wahaName: remote.name, managed: false }; }
  private matchesWaha(session: StoredSession, name: string): boolean { return session.wahaName === name || session.aliases.includes(name); }
  private async refresh(context: RequestContext, stored: StoredSession): Promise<WhatsAppSession> { if (this.pendingCreates.has(this.key(context.workspaceId, stored.id))) return this.summary(stored); try { const external = await this.client.getSession(stored.wahaName); this.setStatus(stored, statusMap[external.status.toUpperCase()] ?? 'error'); } catch (error) { if (!(error instanceof WahaClientError) || error.status !== 404) throw await this.call(context, async () => { throw error; }); await this.reconcile(context.workspaceId); if (stored.status === 'error') throw new WorkerOperationError('NOT_FOUND', 'Linked WAHA session was not found and could not be reconciled safely', context.correlationId); } return this.summary(stored); }
  private require(context: RequestContext, id: string): StoredSession { requestContextSchema.parse(context); const session = this.sessions.get(this.key(context.workspaceId, assertSafeIdentifier(id, 'sessionId', context.correlationId))); if (!session) throw new WorkerOperationError('NOT_FOUND', 'Session not found', context.correlationId); return session; }
  private key(workspaceId: string, sessionId: string): string { return `${workspaceId}:${sessionId}`; }
  private wahaName(workspaceId: string, sessionId: string): string { return `chatpro-${createHash('sha256').update(`${workspaceId}:${sessionId}`).digest('hex').slice(0, 40)}`; }
  private setStatus(session: StoredSession, status: SessionStatus): void { session.status = status; session.updatedAt = new Date().toISOString(); }
  private async call<T>(context: RequestContext, action: () => Promise<T>): Promise<T> { try { return await action(); } catch (error) { if (error instanceof WahaClientError) { const code = error.kind === 'timeout' || error.kind === 'deadline' ? 'TIMEOUT' : error.kind === 'unavailable' || (error.status !== undefined && error.status >= 500) ? 'SERVICE_UNAVAILABLE' : error.kind === 'contract' ? 'PROVIDER_CONTRACT_ERROR' : error.status === 400 ? 'VALIDATION_ERROR' : error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'CONFLICT' : 'PROVIDER_CONTRACT_ERROR'; const message = error.kind === 'timeout' ? 'WAHA request timed out' : error.kind === 'deadline' ? 'command budget ran out before WAHA answered' : error.kind === 'unavailable' ? 'WAHA provider is unavailable' : error.kind === 'contract' ? 'WAHA response contract is invalid' : error.providerMessage ? `WAHA request failed (${error.status}): ${error.providerMessage}` : `WAHA request failed with status ${error.status ?? 'unknown'}`; throw new WorkerOperationError(code, message, context.correlationId, { ...(error.status ? { providerStatus: error.status } : {}), ...(error.providerMessage ? { providerMessage: error.providerMessage } : {}), ...error.details }); } throw error; } }
}
