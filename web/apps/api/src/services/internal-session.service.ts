import { randomUUID } from 'node:crypto';
import type { CreateSessionRequest, RequestContext, SessionQr, SessionSummary, WhatsAppSession } from '@chatpro/contracts';
import { AppError } from '../errors.js';
import { InternalWorkerClient } from '../internal-worker-client.js';
import type { SessionServicePort } from '../ports/catalog.ports.js';

const statusFor = (code: string): number => ({ VALIDATION_ERROR: 400, NOT_FOUND: 404, CONFLICT: 409, TIMEOUT: 504, SERVICE_UNAVAILABLE: 503 }[code] ?? 503);

export class InternalSessionService implements SessionServicePort {
  /** Telefone próprio → nomes WAHA que já o usaram (mensagens outbound
   *  gravadas). Alimenta a adoção por número: nomes históricos do mesmo
   *  telefone viram aliases da sessão viva. Ligado pelo app.ts quando o store
   *  de webhooks existe. */
  sessionPhoneHistory?: (workspaceId: string) => Promise<Map<string, string[]>>;

  constructor(private readonly worker: InternalWorkerClient) {}

  async list(context: RequestContext): Promise<SessionSummary[]> {
    const sessions = await this.data(context, { type: 'session.list', payload: {} }, 'sessions') as SessionSummary[];
    await this.adoptHistoricalAliases(context, sessions);
    return sessions;
  }

  /** Cross-máquina: o registry do worker é local, então uma reinstalação não
   *  conhece os nomes WAHA antigos do mesmo número. A memória está no banco
   *  (outbound `from`); os nomes encontrados viram aliases da sessão viva.
   *  Best-effort: a listagem nunca falha por causa da adoção. */
  private async adoptHistoricalAliases(context: RequestContext, sessions: SessionSummary[]): Promise<void> {
    if (!this.sessionPhoneHistory) return;
    let history: Map<string, string[]>;
    try { history = await this.sessionPhoneHistory(context.workspaceId); } catch { return; }
    for (const session of sessions) {
      if (!session.phone || session.managed === false) continue;
      const known = history.get(session.phone);
      if (!known) continue;
      const missing = known.filter(name => name !== session.wahaName && !(session.aliases ?? []).includes(name));
      if (!missing.length) continue;
      try {
        await this.data(context, { type: 'session.mergeAliases', payload: { sessionId: session.id, aliases: missing } }, 'completed');
        session.aliases = [...(session.aliases ?? []), ...missing];
      } catch { /* o próximo list tenta de novo */ }
    }
  }

  async create(context: RequestContext, input: CreateSessionRequest): Promise<WhatsAppSession> {
    // A stable id makes POST retries safe even when WAHA accepted the first
    // request after the browser/API connection timed out.
    const sessionId = input.clientRequestId ?? randomUUID();
    return await this.data(context, { type: 'session.create', payload: { sessionId, name: input.name } }, 'session') as WhatsAppSession;
  }
  async get(context: RequestContext, sessionId: string): Promise<WhatsAppSession> { return await this.data(context, { type: 'session.status', payload: { sessionId } }, 'session') as WhatsAppSession; }
  async qr(context: RequestContext, sessionId: string): Promise<SessionQr> { return await this.data(context, { type: 'session.qr', payload: { sessionId } }, 'qr') as SessionQr; }
  async connect(context: RequestContext, sessionId: string): Promise<void> { await this.complete(context, 'session.connect', sessionId); }
  async disconnect(context: RequestContext, sessionId: string): Promise<void> { await this.complete(context, 'session.stop', sessionId); }
  async logout(context: RequestContext, sessionId: string): Promise<void> { await this.complete(context, 'session.logout', sessionId); }
  async remove(context: RequestContext, sessionId: string): Promise<void> { await this.complete(context, 'session.remove', sessionId); }

  private async complete(context: RequestContext, type: 'session.connect' | 'session.stop' | 'session.logout' | 'session.remove', sessionId: string): Promise<void> { await this.data(context, { type, payload: { sessionId } }, 'completed'); }
  private async data(context: RequestContext, command: Parameters<InternalWorkerClient['send']>[0]['command'], field: string): Promise<unknown> {
    const response = await this.worker.send({ correlationId: context.correlationId, workspaceId: context.workspaceId, command });
    if (!response.success) throw new AppError(statusFor(response.error.code), response.error.code, response.error.message, response.error.details);
    const value = response.data as Record<string, unknown>;
    if (!(field in value) && !(field === 'completed' && 'removed' in value)) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Internal worker returned an invalid response');
    return value[field] ?? value.removed;
  }
}
