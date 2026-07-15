import type { RequestContext } from '@chatpro/contracts';
import type { WhatsAppWorkerPort, WorkerCommand } from './ports.js';
import type { WhatsAppSessionManager } from './whatsapp-session-manager.js';

export class BaileysWhatsAppWorkerAdapter implements WhatsAppWorkerPort {
  constructor(private readonly manager: WhatsAppSessionManager) {}
  async execute(context: RequestContext, command: WorkerCommand) {
    if (command.type === 'createSession') return this.manager.createSession(context, command.sessionId, command.input);
    if (command.type === 'connectSession') return this.manager.connectSession(context, command.sessionId);
    if (command.type === 'disconnectSession') return this.manager.disconnectSession(context, command.sessionId);
    return this.manager.removeSession(context, command.sessionId);
  }
}
