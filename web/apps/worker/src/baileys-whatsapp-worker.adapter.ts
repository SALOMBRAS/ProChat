import type { RequestContext } from '@chatpro/contracts';
import { WorkerOperationError, type WhatsAppWorkerPort, type WorkerCommand } from './ports.js';
import type { WhatsAppSessionManager } from './whatsapp-session-manager.js';

export class BaileysWhatsAppWorkerAdapter implements WhatsAppWorkerPort {
  constructor(private readonly manager: WhatsAppSessionManager) {}
  async execute(context: RequestContext, command: WorkerCommand) {
    if (command.type === 'listSessions') return this.manager.listSessions(context.workspaceId);
    if (command.type === 'createSession') return this.manager.createSession(context, command.sessionId, command.input);
    if (command.type === 'connectSession') return this.manager.connectSession(context, command.sessionId);
    if (command.type === 'disconnectSession') return this.manager.disconnectSession(context, command.sessionId);
    if (command.type === 'logoutSession') return this.manager.logoutSession(context, command.sessionId);
    if (command.type === 'getSession') {
      const session = this.manager.getSession(context.workspaceId, command.sessionId);
      if (!session) throw new WorkerOperationError('NOT_FOUND', 'Session not found', context.correlationId);
      return session;
    }
    if (command.type === 'getQr') return this.manager.getQr(context, command.sessionId);
    return this.manager.removeSession(context, command.sessionId);
  }
}
