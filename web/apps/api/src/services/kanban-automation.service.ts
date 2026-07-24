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
      this.log.warn('Kanban post-persistence automation failed', { workspaceId: request.workspaceId, conversationId: request.conversationId, messageId: request.messageId, direction: request.direction, responsibleFunction: 'KanbanAutomationCoordinator.run', ...errorDiagnostics(error) });
      return { status: 'failed', reason: 'kanban_automation_error' };
    }
  }
}

function errorDiagnostics(error: unknown): Record<string, unknown> {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  return {
    errorClass: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : typeof value?.message === 'string' ? value.message : String(error),
    errorStack: error instanceof Error ? error.stack ?? null : typeof value?.stack === 'string' ? value.stack : null,
    databaseCode: typeof value?.code === 'string' ? value.code : null,
    databaseDetails: typeof value?.details === 'string' ? value.details : null,
    databaseHint: typeof value?.hint === 'string' ? value.hint : null,
  };
}
