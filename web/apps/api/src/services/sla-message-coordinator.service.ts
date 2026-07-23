import type { SlaService } from './sla.service.js';

export type SlaMessageRequest = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  direction: 'inbound' | 'outbound';
  occurredAt: string;
  historical: boolean;
};

export type SlaMessageResult = { status: 'processed' | 'failed' };

export interface SlaMessageGateway {
  message(workspaceId: string, conversationId: string, direction: 'inbound' | 'outbound', occurredAt: string, historical: boolean): Promise<void>;
}

/** Post-persistence boundary: SLA failures must never undo a persisted Inbox message. */
export class SlaMessageCoordinator {
  constructor(private readonly sla: SlaMessageGateway | SlaService, private readonly log: Pick<Console, 'warn'> = console) {}

  async run(request: SlaMessageRequest): Promise<SlaMessageResult> {
    try {
      await this.sla.message(request.workspaceId, request.conversationId, request.direction, request.occurredAt, request.historical);
      return { status: 'processed' };
    } catch (error) {
      const value = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
      this.log.warn('SLA post-persistence update failed', {
        workspaceId: request.workspaceId,
        conversationId: request.conversationId,
        messageId: request.messageId,
        direction: request.direction,
        responsibleFunction: 'SlaMessageCoordinator.run',
        errorClass: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : typeof value?.message === 'string' ? value.message : String(error),
        errorStack: error instanceof Error ? error.stack ?? null : typeof value?.stack === 'string' ? value.stack : null,
        databaseCode: typeof value?.code === 'string' ? value.code : null,
      });
      return { status: 'failed' };
    }
  }
}
