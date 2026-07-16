import { randomUUID } from 'node:crypto';
import type { CreateSessionRequest, RequestContext, SessionQr, SessionSummary, WhatsAppSession } from '@chatpro/contracts';
import { AppError } from '../errors.js';
import { InternalWorkerClient } from '../internal-worker-client.js';
import type { SessionServicePort } from '../ports/catalog.ports.js';

const statusFor = (code: string): number => ({ VALIDATION_ERROR: 400, NOT_FOUND: 404, CONFLICT: 409, TIMEOUT: 504, SERVICE_UNAVAILABLE: 503 }[code] ?? 503);

export class InternalSessionService implements SessionServicePort {
  constructor(private readonly worker: InternalWorkerClient) {}

  async list(context: RequestContext): Promise<SessionSummary[]> { return await this.data(context, { type: 'session.list', payload: {} }, 'sessions') as SessionSummary[]; }
  async create(context: RequestContext, input: CreateSessionRequest): Promise<WhatsAppSession> { return await this.data(context, { type: 'session.create', payload: { sessionId: randomUUID(), name: input.name } }, 'session') as WhatsAppSession; }
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
