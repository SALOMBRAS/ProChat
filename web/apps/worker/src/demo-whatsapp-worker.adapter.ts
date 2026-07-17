import type { RequestContext, WhatsAppSession } from '@chatpro/contracts';
import { createSessionRequestSchema, requestContextSchema, whatsAppSessionSchema } from '@chatpro/contracts';
import { assertSafeIdentifier } from './identifiers.js';
import { WorkerOperationError, type WhatsAppWorkerPort, type WorkerCommand } from './ports.js';

const QR_TTL_MS = 120_000;
const CONNECTING_DELAY_MS = 350;

type DemoSession = WhatsAppSession & { qr?: { value: string; expiresAt: string }; transition?: ReturnType<typeof setTimeout> };

/** In-memory, non-network simulation of the normalized session contract. */
export class DemoWhatsAppWorkerAdapter implements WhatsAppWorkerPort {
  private readonly sessions = new Map<string, DemoSession>();
  private key(workspaceId: string, sessionId: string) { return `${workspaceId}:${sessionId}`; }

  async execute(context: RequestContext, command: WorkerCommand) {
    const validContext = requestContextSchema.parse(context);
    if (command.type === 'listSessions') return [...this.sessions.values()].filter(session => session.workspaceId === validContext.workspaceId).map(({ qr: _qr, transition: _transition, ...session }) => session);
    if (command.type === 'createSession') return this.create(validContext, command.sessionId, command.input);
    if (command.type === 'sendMessage') throw new WorkerOperationError('NOT_IMPLEMENTED', 'Manual messaging is unavailable in demo mode', context.correlationId);
    if (command.type === 'syncIdentity') throw new WorkerOperationError('NOT_IMPLEMENTED', 'Identity synchronization is unavailable in demo mode', context.correlationId);
    const session = this.require(validContext, command.sessionId);
    if (command.type === 'getSession') return this.public(session);
    if (command.type === 'getQr') return this.qr(validContext, session);
    if (command.type === 'connectSession') return this.connect(validContext, session);
    if (command.type === 'disconnectSession') return this.stop(session);
    if (command.type === 'logoutSession') return this.logout(session);
    return this.remove(validContext, session);
  }

  shutdown(): void { for (const session of this.sessions.values()) if (session.transition) clearTimeout(session.transition); this.sessions.clear(); }

  private create(context: RequestContext, sessionId: string, input: { name?: string }) {
    const id = assertSafeIdentifier(sessionId, 'sessionId', context.correlationId);
    const body = createSessionRequestSchema.parse(input);
    const key = this.key(context.workspaceId, id);
    if (this.sessions.has(key)) throw new WorkerOperationError('CONFLICT', 'Session already exists', context.correlationId);
    const now = new Date().toISOString();
    const session = whatsAppSessionSchema.parse({ id, workspaceId: context.workspaceId, name: body.name ?? id, status: 'disconnected', createdAt: now, updatedAt: now });
    this.sessions.set(key, session);
    return session;
  }

  private connect(context: RequestContext, session: DemoSession): void {
    if (session.status === 'waiting_qr') { this.clearQr(session); this.setStatus(session, 'connected'); return; }
    if (session.status === 'connecting' || session.status === 'connected') throw new WorkerOperationError('CONFLICT', 'Session is already connecting or connected', context.correlationId);
    this.setStatus(session, 'connecting');
    session.transition = setTimeout(() => {
      session.transition = undefined;
      if (session.status !== 'connecting') return;
      const expiresAt = new Date(Date.now() + QR_TTL_MS).toISOString();
      session.qr = { value: `CHATPRO_DEMONSTRACAO_SEM_CREDENCIAL:${session.id}`, expiresAt };
      this.setStatus(session, 'waiting_qr');
    }, CONNECTING_DELAY_MS);
  }

  private stop(session: DemoSession): void { this.clearQr(session); this.setStatus(session, 'stopped'); }
  private logout(session: DemoSession): void { this.clearQr(session); this.setStatus(session, 'disconnected'); }
  private remove(context: RequestContext, session: DemoSession): void { this.clearQr(session); this.sessions.delete(this.key(context.workspaceId, session.id)); }
  private qr(context: RequestContext, session: DemoSession) {
    if (!session.qr || Date.parse(session.qr.expiresAt) <= Date.now()) { this.clearQr(session); throw new WorkerOperationError('NOT_FOUND', 'Temporary demo QR code not found', context.correlationId); }
    return { sessionId: session.id, workspaceId: session.workspaceId, qr: session.qr.value, expiresAt: session.qr.expiresAt };
  }
  private require(context: RequestContext, sessionId: string): DemoSession { const id = assertSafeIdentifier(sessionId, 'sessionId', context.correlationId); const session = this.sessions.get(this.key(context.workspaceId, id)); if (!session) throw new WorkerOperationError('NOT_FOUND', 'Session not found', context.correlationId); return session; }
  private public({ qr: _qr, transition: _transition, ...session }: DemoSession): WhatsAppSession { return session; }
  private clearQr(session: DemoSession): void { if (session.transition) clearTimeout(session.transition); session.transition = undefined; session.qr = undefined; }
  private setStatus(session: DemoSession, status: WhatsAppSession['status']): void { session.status = status; session.updatedAt = new Date().toISOString(); }
}
