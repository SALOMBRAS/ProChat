export type KanbanAutomationRequest = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  direction: 'inbound' | 'outbound';
  historical?: boolean;
  imported?: boolean;
  replay?: boolean;
  visible?: boolean;
  technical?: boolean;
  quarantined?: boolean;
};

export type KanbanAutomationResult = { status: 'moved' | 'skipped' | 'failed'; reason?: string };

export interface KanbanAutomationGateway {
  automated(request: KanbanAutomationRequest): Promise<KanbanAutomationResult>;
}

/** Post-persistence boundary: Kanban failures must never replay a message or a send. */
export class KanbanAutomationCoordinator {
  constructor(private readonly kanban: KanbanAutomationGateway, private readonly log: Pick<Console, 'warn'> = console) {}

  async run(request: KanbanAutomationRequest): Promise<KanbanAutomationResult> {
    try { return await this.kanban.automated(request); }
    catch (error) {
      this.log.warn('Kanban post-persistence automation failed', { workspaceId: request.workspaceId, conversationId: request.conversationId, direction: request.direction, error: error instanceof Error ? error.name : 'unknown' });
      return { status: 'failed', reason: 'kanban_automation_error' };
    }
  }
}
