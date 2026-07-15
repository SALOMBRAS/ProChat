import type { RequestContext } from '@chatpro/contracts';
import { WorkerUnavailableError, type WhatsAppWorkerPort, type WorkerCommand } from './ports.js';
export class UnavailableWhatsAppWorkerAdapter implements WhatsAppWorkerPort { async execute(context: RequestContext, _command: WorkerCommand): Promise<never> { throw new WorkerUnavailableError(context.correlationId); } }
