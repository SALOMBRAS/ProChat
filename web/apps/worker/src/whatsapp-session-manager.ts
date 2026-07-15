import { randomUUID } from 'node:crypto';
import {
  createSessionRequestSchema,
  requestContextSchema,
  whatsAppSessionSchema,
  type EventEnvelope,
  type RequestContext,
  type SessionStatus,
  type WhatsAppSession,
} from '@chatpro/contracts';
import type { WorkerConfig } from './config.js';
import { assertSafeIdentifier } from './identifiers.js';
import type { LogSink } from './logging.js';
import { log } from './logging.js';
import type { CredentialStorePort, EventPublisherPort } from './ports.js';
import { WorkerOperationError } from './ports.js';
import { SessionRuntimeRegistry, type RuntimeEntry } from './session-runtime-registry.js';
import type { ConnectionUpdate, WhatsAppSocket, WhatsAppSocketFactory } from './whatsapp-socket.js';

const LOGGED_OUT_REASON = 401;

function disconnectCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { output?: { statusCode?: unknown }; data?: { statusCode?: unknown }; statusCode?: unknown };
  const code = value.output?.statusCode ?? value.data?.statusCode ?? value.statusCode;
  return typeof code === 'number' ? code : undefined;
}

export class WhatsAppSessionManager {
  private readonly sessions = new Map<string, WhatsAppSession>();

  constructor(
    private readonly config: WorkerConfig,
    private readonly credentials: CredentialStorePort,
    private readonly sockets: WhatsAppSocketFactory,
    private readonly events: EventPublisherPort,
    readonly registry = new SessionRuntimeRegistry(),
    private readonly logger: LogSink = log,
  ) {}

  private key(workspaceId: string, sessionId: string): string { return this.registry.key(workspaceId, sessionId); }

  async restorePersistedSessions(): Promise<WhatsAppSession[]> {
    const restored: WhatsAppSession[] = [];
    for (const item of await this.credentials.discoverSessions()) {
      const now = new Date().toISOString();
      const session = whatsAppSessionSchema.parse({ id: item.sessionId, workspaceId: item.workspaceId, name: item.sessionId, status: 'disconnected', createdAt: now, updatedAt: now });
      this.sessions.set(this.key(item.workspaceId, item.sessionId), session);
      this.registry.set({ workspaceId: item.workspaceId, sessionId: item.sessionId, status: 'disconnected', reconnectAttempt: 0, createdAt: now, statusChangedAt: now, manualStop: false, explicitLogout: false });
      restored.push(session);
    }
    return restored;
  }

  listSessions(workspaceId: string): WhatsAppSession[] {
    return [...this.sessions.values()].filter(session => session.workspaceId === workspaceId);
  }

  getSession(workspaceId: string, sessionId: string): WhatsAppSession | undefined {
    return this.sessions.get(this.key(workspaceId, sessionId));
  }

  async createSession(context: RequestContext, sessionId: string, input: { name: string }): Promise<WhatsAppSession> {
    const validContext = requestContextSchema.parse(context);
    const id = assertSafeIdentifier(sessionId, 'sessionId', context.correlationId);
    const body = createSessionRequestSchema.parse(input);
    const key = this.key(validContext.workspaceId, id);
    if (this.sessions.has(key) || await this.credentials.hasAuthDirectory(validContext.workspaceId, id)) throw new WorkerOperationError('CONFLICT', 'Session already exists', context.correlationId);
    const now = new Date().toISOString();
    const session = whatsAppSessionSchema.parse({ id, workspaceId: validContext.workspaceId, name: body.name, status: 'disconnected', createdAt: now, updatedAt: now });
    this.sessions.set(key, session);
    this.registry.set({ workspaceId: validContext.workspaceId, sessionId: id, status: 'disconnected', reconnectAttempt: 0, createdAt: now, statusChangedAt: now, manualStop: false, explicitLogout: false });
    return session;
  }

  async connectSession(context: RequestContext, sessionId: string): Promise<void> {
    const entry = this.requireEntry(context, sessionId);
    if (!this.config.connectionEnabled) throw new WorkerOperationError('SERVICE_UNAVAILABLE', 'WhatsApp connections are disabled', context.correlationId);
    if (!this.registry.begin(entry, 'connect')) throw new WorkerOperationError('CONFLICT', 'Another session operation is in progress', context.correlationId);
    try {
      if (entry.socket || entry.status === 'connecting' || entry.status === 'connected' || entry.status === 'reconnecting') throw new WorkerOperationError('CONFLICT', 'Session is already connecting or connected', context.correlationId);
      entry.manualStop = false;
      entry.explicitLogout = false;
      entry.reconnectAttempt = 0;
      await this.openSocket(context, entry);
    } catch (error) {
      if (error instanceof WorkerOperationError) throw error;
      await this.setStatus(context, entry, 'error');
      await this.publishError(context, entry, 'connect', error);
      throw new WorkerOperationError('SERVICE_UNAVAILABLE', 'Unable to start WhatsApp session', context.correlationId);
    } finally { this.registry.finish(entry); }
  }

  async disconnectSession(context: RequestContext, sessionId: string): Promise<void> {
    const entry = this.requireEntry(context, sessionId);
    if (!this.registry.begin(entry, 'disconnect')) throw new WorkerOperationError('CONFLICT', 'Another session operation is in progress', context.correlationId);
    try {
      entry.manualStop = true;
      this.registry.cancelTimers(entry);
      const socket = entry.socket;
      if (socket) await socket.end(new Error('Local disconnect'));
      entry.socket = undefined;
      entry.reconnectAttempt = 0;
      await this.setStatus(context, entry, 'disconnected');
    } finally { this.registry.finish(entry); }
  }

  async removeSession(context: RequestContext, sessionId: string): Promise<void> {
    requestContextSchema.parse(context);
    const id = assertSafeIdentifier(sessionId, 'sessionId', context.correlationId);
    const entry = this.registry.get(context.workspaceId, id);
    if (!entry) { await this.credentials.removeAuthDirectory(context.workspaceId, id); return; }
    if (!this.registry.begin(entry, 'remove')) throw new WorkerOperationError('CONFLICT', 'Another session operation is in progress', context.correlationId);
    try {
      entry.manualStop = true;
      entry.explicitLogout = true;
      this.registry.cancelTimers(entry);
      if (entry.socket) {
        try { await entry.socket.logout(); } catch (error) { this.logger('error', 'WhatsApp logout failed during removal', { workspaceId: entry.workspaceId, sessionId: entry.sessionId, operation: 'remove', errorClass: error instanceof Error ? error.name : 'UnknownError', correlationId: context.correlationId }); }
        try { await entry.socket.end(new Error('Session removed')); } catch { /* socket may already be closed by logout */ }
      }
      entry.socket = undefined;
      await this.setStatus(context, entry, 'logged_out');
      await this.credentials.removeAuthDirectory(entry.workspaceId, entry.sessionId);
      this.sessions.delete(this.key(entry.workspaceId, entry.sessionId));
      this.registry.delete(entry.workspaceId, entry.sessionId);
    } finally { this.registry.finish(entry); }
  }

  async shutdown(): Promise<void> {
    const operations = this.registry.values().map(async entry => {
      entry.manualStop = true;
      this.registry.cancelTimers(entry);
      if (entry.socket) {
        try { await entry.socket.end(new Error('Worker shutdown')); } catch { /* best-effort shutdown */ }
        entry.socket = undefined;
      }
      if (entry.status !== 'logged_out') {
        const context = { userId: 'worker', workspaceId: entry.workspaceId, correlationId: `shutdown-${randomUUID()}` };
        await this.setStatus(context, entry, 'disconnected');
      }
    });
    await Promise.allSettled(operations);
  }

  private requireEntry(context: RequestContext, sessionId: string): RuntimeEntry {
    const validContext = requestContextSchema.parse(context);
    const id = assertSafeIdentifier(sessionId, 'sessionId', context.correlationId);
    const entry = this.registry.get(validContext.workspaceId, id);
    if (!entry) throw new WorkerOperationError('NOT_FOUND', 'Session not found', context.correlationId);
    return entry;
  }

  private async openSocket(context: RequestContext, entry: RuntimeEntry): Promise<void> {
    if (!this.config.connectionEnabled || entry.manualStop || entry.explicitLogout) return;
    const authDirectory = await this.credentials.prepareAuthDirectory(entry.workspaceId, entry.sessionId);
    const { socket, saveCreds } = await this.sockets.create(authDirectory);
    entry.socket = socket;
    socket.ev.on('connection.update', update => { void this.handleConnectionUpdate(context, entry, socket, update); });
    socket.ev.on('creds.update', () => { void saveCreds().catch(error => this.publishError(context, entry, 'save_credentials', error)); });
    await this.setStatus(context, entry, 'connecting');
  }

  private async handleConnectionUpdate(context: RequestContext, entry: RuntimeEntry, socket: WhatsAppSocket, update: ConnectionUpdate): Promise<void> {
    if (entry.socket !== socket || entry.manualStop || entry.explicitLogout) return;
    if (update.qr) {
      await this.setStatus(context, entry, 'qr_pending');
      if (entry.qrExpiryTimer) clearTimeout(entry.qrExpiryTimer);
      const expiresAt = new Date(Date.now() + this.config.qrTtlMs).toISOString();
      await this.publish(context, 'session.qr.updated', { sessionId: entry.sessionId, qr: update.qr, expiresAt });
      entry.qrExpiryTimer = setTimeout(() => { entry.qrExpiryTimer = undefined; }, this.config.qrTtlMs);
    }
    if (update.connection === 'connecting') await this.setStatus(context, entry, entry.reconnectAttempt > 0 ? 'reconnecting' : 'connecting', entry.reconnectAttempt || undefined);
    if (update.connection === 'open') {
      entry.reconnectAttempt = 0;
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      if (entry.qrExpiryTimer) clearTimeout(entry.qrExpiryTimer);
      entry.reconnectTimer = undefined;
      entry.qrExpiryTimer = undefined;
      await this.setStatus(context, entry, 'connected');
    }
    if (update.connection === 'close') {
      entry.socket = undefined;
      if (disconnectCode(update.lastDisconnect?.error) === LOGGED_OUT_REASON) {
        entry.explicitLogout = true;
        this.registry.cancelTimers(entry);
        await this.setStatus(context, entry, 'logged_out');
        return;
      }
      await this.scheduleReconnect(context, entry);
    }
  }

  private async scheduleReconnect(context: RequestContext, entry: RuntimeEntry): Promise<void> {
    if (!this.config.connectionEnabled || entry.manualStop || entry.explicitLogout || entry.reconnectTimer) return;
    const attempt = entry.reconnectAttempt + 1;
    if (attempt > this.config.maxReconnectAttempts) {
      await this.setStatus(context, entry, 'error');
      await this.publishError(context, entry, 'reconnect', new Error('Reconnect attempts exhausted'));
      return;
    }
    entry.reconnectAttempt = attempt;
    await this.setStatus(context, entry, 'reconnecting', attempt);
    const delay = this.config.reconnectBaseDelayMs * 2 ** (attempt - 1);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      if (entry.manualStop || entry.explicitLogout || !this.config.connectionEnabled) return;
      void this.openSocket(context, entry).catch(async error => {
        this.logger('error', 'WhatsApp reconnect attempt failed', { workspaceId: entry.workspaceId, sessionId: entry.sessionId, operation: 'reconnect', attempt, errorClass: error instanceof Error ? error.name : 'UnknownError', correlationId: context.correlationId });
        await this.scheduleReconnect(context, entry);
      });
    }, delay);
  }

  private async setStatus(context: RequestContext, entry: RuntimeEntry, status: SessionStatus, attempt?: number): Promise<void> {
    if (entry.status === status) return;
    const previousStatus = entry.status;
    const changedAt = new Date().toISOString();
    entry.status = status;
    entry.statusChangedAt = changedAt;
    const session = this.sessions.get(this.key(entry.workspaceId, entry.sessionId));
    if (session) this.sessions.set(this.key(entry.workspaceId, entry.sessionId), { ...session, status, updatedAt: changedAt });
    await this.publish(context, 'session.status.changed', { sessionId: entry.sessionId, status, previousStatus, changedAt, ...(attempt ? { attempt } : {}) });
  }

  private async publish(context: RequestContext, eventType: EventEnvelope['eventType'], payload: Record<string, unknown>): Promise<void> {
    await this.events.publish({ eventId: randomUUID(), eventType, workspaceId: context.workspaceId, timestamp: new Date().toISOString(), correlationId: context.correlationId, payload });
  }

  private async publishError(context: RequestContext, entry: RuntimeEntry, operation: string, error: unknown): Promise<void> {
    const errorClass = error instanceof Error ? error.name : 'UnknownError';
    await this.publish(context, 'worker.error', { sessionId: entry.sessionId, operation, code: errorClass, message: 'WhatsApp worker operation failed' });
  }
}
