import type { RealtimeHub } from '../realtime.js';
import { conversationAudience } from '../realtime.js';
import type { DomainService } from './domain.service.js';
import type { ConversationStore } from './waha-webhook.service.js';

/** Ator gravado em `conversation_events` quando a atribuição nasce de um
 *  webhook: não existe usuário por trás. A coluna não tem FK para
 *  `workspace_users`, então o marcador textual é seguro nos dois bancos. */
const systemActor = 'system:department-assignment';

/** Auto-atribuição instância→departamento: o vínculo mora nos settings do
 *  workspace (`operational['instanceTeam:<wahaSession>'] = teamId`) e vale só
 *  para conversa recém-criada ainda sem departamento — transferência manual
 *  continua sendo só trocar `assignedTeamId`, e este serviço nunca a sobrepõe. */
export class DepartmentAssignmentService {
  constructor(private readonly domain: Pick<DomainService, 'settings'>, private readonly conversations: Pick<ConversationStore, 'getConversation' | 'setTeamAssignment'>, private readonly realtime: RealtimeHub) {}

  async onConversationCreated(workspaceId: string, wahaSession: string, conversationId: string): Promise<void> {
    const stored = await this.domain.settings(workspaceId) as { settings?: { operational?: Record<string, unknown> } } | undefined;
    const raw = stored?.settings?.operational?.[`instanceTeam:${wahaSession}`];
    if (typeof raw !== 'string' || !raw) return;
    // Suporta múltiplos departamentos separados por vírgula (o primeiro é o
    // departamento de atribuição automática; os demais são apenas vínculo visual).
    const teamId = raw.split(',')[0]!.trim();
    if (!teamId) return;
    const conversation = await this.conversations.getConversation(workspaceId, conversationId);
    if (!conversation || conversation.assignedTeamId) return;
    const event = await this.conversations.setTeamAssignment(workspaceId, conversationId, teamId, systemActor);
    if (!event) return;
    // Mesmo evento realtime do `assignTeam` manual: quem ouve
    // `conversation.management.updated` não distingue os dois caminhos.
    const updated = await this.conversations.getConversation(workspaceId, conversationId);
    this.realtime.publish(workspaceId, 'conversation.management.updated', { conversationId, conversation: updated, event }, updated ? conversationAudience(updated) : { conversationTeamId: null });
  }
}
