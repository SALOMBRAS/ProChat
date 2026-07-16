import type { RequestContext } from '@chatpro/contracts';
import { AppError } from '../errors.js';
import { InternalWorkerClient } from '../internal-worker-client.js';
import type { ConversationStore, InboxMessage } from './waha-webhook.service.js';

const statusFor = (code: string): number => ({ VALIDATION_ERROR: 400, NOT_FOUND: 404, CONFLICT: 409, TIMEOUT: 504, SERVICE_UNAVAILABLE: 503 }[code] ?? 503);

export class InternalInboxService {
  constructor(private readonly worker: InternalWorkerClient, private readonly conversations: ConversationStore) {}
  async send(context: RequestContext, conversationId: string, text: string): Promise<InboxMessage> {
    const conversation = await this.conversations.getConversation(context.workspaceId, conversationId);
    if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    const response = await this.worker.send({ correlationId: context.correlationId, workspaceId: context.workspaceId, command: { type: 'message.send', payload: { wahaSession: conversation.whatsappSessionId, chatId: conversation.chatId, text } } });
    if (!response.success) throw new AppError(statusFor(response.error.code), response.error.code, response.error.message, response.error.details);
    const sent = response.data as { sentMessage?: { id: string; timestamp: string } };
    if (!sent.sentMessage) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Internal worker returned an invalid response');
    return this.conversations.recordOutbound({ workspaceId: context.workspaceId, wahaSession: conversation.whatsappSessionId, chatId: conversation.chatId, externalMessageId: sent.sentMessage.id, text, occurredAt: sent.sentMessage.timestamp });
  }
}
