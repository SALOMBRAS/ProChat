import type { RequestContext } from '@chatpro/contracts';
import { AppError } from '../errors.js';
import type { RealtimeHub } from '../realtime.js';
import type { ConversationEvent, ConversationPriority, ConversationStatus, ConversationStore, ConversationSummary } from './waha-webhook.service.js';
import type { WorkspaceDirectoryService } from './workspace-directory.service.js';

const transitions: Record<ConversationStatus, ConversationStatus[]> = {
  open: ['in_progress', 'archived'],
  in_progress: ['waiting_customer', 'resolved', 'archived'],
  waiting_customer: ['in_progress', 'resolved'],
  resolved: ['archived', 'in_progress'],
  archived: ['open'],
};

export class ConversationManagementService {
  constructor(private readonly conversations: ConversationStore, private readonly realtime: RealtimeHub, private readonly directory: WorkspaceDirectoryService) {}

  async assign(context: RequestContext, conversationId: string, assignedUserId: string | null) {
    await this.directory.requireAssignableUser(context, assignedUserId);
    const current = await this.requireConversation(context.workspaceId, conversationId);
    const event = await this.conversations.setAssignment(context.workspaceId, conversationId, assignedUserId, this.actor(context));
    return this.publish(context, conversationId, current, event);
  }

  async assignTeam(context: RequestContext, conversationId: string, assignedTeamId: string | null) {
    await this.directory.requireAssignableTeam(context, assignedTeamId);
    const current = await this.requireConversation(context.workspaceId, conversationId);
    const event = await this.conversations.setTeamAssignment(context.workspaceId, conversationId, assignedTeamId, this.actor(context));
    return this.publish(context, conversationId, current, event);
  }

  async setStatus(context: RequestContext, conversationId: string, status: ConversationStatus) {
    const current = await this.requireConversation(context.workspaceId, conversationId);
    if (current.status !== status && !transitions[current.status].includes(status)) throw new AppError(409, 'CONFLICT', `Invalid status transition from ${current.status} to ${status}`);
    const event = await this.conversations.setStatus(context.workspaceId, conversationId, status, this.actor(context));
    return this.publish(context, conversationId, current, event);
  }

  async setPriority(context: RequestContext, conversationId: string, priority: ConversationPriority) {
    const current = await this.requireConversation(context.workspaceId, conversationId);
    const event = await this.conversations.setPriority(context.workspaceId, conversationId, priority, this.actor(context));
    return this.publish(context, conversationId, current, event);
  }

  async activity(workspaceId: string, conversationId: string) {
    const activity = await this.conversations.listActivity(workspaceId, conversationId);
    if (!activity) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    return activity;
  }

  private async requireConversation(workspaceId: string, conversationId: string) {
    const current = await this.conversations.getConversation(workspaceId, conversationId);
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    return current;
  }

  private actor(context: RequestContext): NonNullable<RequestContext['userId']> {
    if (!context.userId) throw new AppError(401, 'UNAUTHORIZED', 'A user identifier is required for conversation management');
    return context.userId;
  }

  private async publish(context: RequestContext, conversationId: string, current: ConversationSummary, event: ConversationEvent | undefined) {
    const conversation = await this.requireConversation(context.workspaceId, conversationId);
    if (event) this.realtime.publish(context.workspaceId, 'conversation.management.updated', { conversationId, conversation, event });
    return { conversation, event, changed: current.updatedAt !== conversation.updatedAt };
  }
}
