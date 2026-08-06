import type { RequestContext } from '@chatpro/contracts';
import type { ConversationStore, ConversationSummary, ConversationVisibilityFilter } from './waha-webhook.service.js';
import type { WorkspaceDirectoryService } from './workspace-directory.service.js';

/** Visibilidade de conversas por departamento. A regra de produto é: conversa
 *  SEM departamento é de todos; owner, admin e manager veem tudo; agent só vê
 *  conversa sem time, do time dele ou atribuída diretamente a ele. O filtro é
 *  resolvido por requisição — papel e vínculos mudam sem derrubar sessão. */
export class ConversationVisibilityService {
  constructor(private readonly directory: Pick<WorkspaceDirectoryService, 'userScope'>) {}

  /** `null` = sem filtro. Usuário fora do diretório é tratado como agent sem
   *  times: o fallback mais restritivo, nunca o mais permissivo. */
  async for(context: RequestContext): Promise<ConversationVisibilityFilter | null> {
    const scope = await this.directory.userScope(context);
    if (scope && scope.role !== 'agent') return null;
    return { teamIds: scope?.teamIds ?? [], userId: context.userId ?? '' };
  }

  /** Atalho para os handlers de leitura: resolve o filtro e já devolve a
   *  conversa quando ela está fora do escopo do agent (undefined = 404). */
  async visibleConversation(store: Pick<ConversationStore, 'getConversation'>, context: RequestContext, conversationId: string): Promise<ConversationSummary | undefined> {
    const conversation = await store.getConversation(context.workspaceId, conversationId);
    if (!conversation || !allowsConversation(await this.for(context), conversation)) return undefined;
    return conversation;
  }
}

/** A mesma regra do WHERE das stores, aplicada a uma conversa já carregada. */
export function allowsConversation(filter: ConversationVisibilityFilter | null | undefined, conversation: Pick<ConversationSummary, 'assignedTeamId' | 'assignedUserId'>): boolean {
  if (!filter) return true;
  return !conversation.assignedTeamId || filter.teamIds.includes(conversation.assignedTeamId) || conversation.assignedUserId === filter.userId;
}
