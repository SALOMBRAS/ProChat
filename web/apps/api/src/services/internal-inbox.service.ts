import type { RequestContext } from '@chatpro/contracts';
import { AppError } from '../errors.js';
import { InternalWorkerClient } from '../internal-worker-client.js';
import type { ConversationStore, InboxMessage } from './waha-webhook.service.js';
import type { RealtimeHub } from '../realtime.js';
import type { KanbanAutomationCoordinator } from './kanban-automation.service.js';
import { log } from '../logging.js';

const statusFor = (code: string): number => ({ VALIDATION_ERROR: 400, NOT_FOUND: 404, CONFLICT: 409, TIMEOUT: 504, SERVICE_UNAVAILABLE: 503, PROVIDER_CONTRACT_ERROR: 502 }[code] ?? 503);

export class InternalInboxService {
  constructor(private readonly worker: InternalWorkerClient, private readonly conversations: ConversationStore, private readonly realtime: RealtimeHub, private readonly automation?: KanbanAutomationCoordinator) {}
  async send(context: RequestContext, conversationId: string, text: string): Promise<InboxMessage> {
    const conversation = await this.conversations.getConversation(context.workspaceId, conversationId);
    if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    const deliveryChatId = conversation.deliveryChatId ?? conversation.chatId;
    log('info', 'Inbox message send started', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, wahaSession: conversation.whatsappSessionId, chatId: deliveryChatId });
    let response;
    try {
      response = await this.worker.send({ correlationId: context.correlationId, workspaceId: context.workspaceId, timeoutMs: 30_000, command: { type: 'message.send', payload: { wahaSession: conversation.whatsappSessionId, chatId: deliveryChatId, text } } });
    } catch (error) {
      log('error', 'Inbox outbound worker transport failed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, stage: 'worker_transport', ...errorDiagnostics(error) });
      throw error;
    }
    if (!response.success) {
      log('error', 'Inbox outbound worker rejected send', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, stage: 'worker_delivery', workerCode: response.error.code, workerMessage: response.error.message });
      throw new AppError(statusFor(response.error.code), response.error.code, response.error.message, response.error.details);
    }
    const sent = response.data as { sentMessage?: { id?: string; timestamp: string; pending?: boolean } };
    if (!sent.sentMessage) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Internal worker returned an invalid response');
    log('info', 'Inbox message send accepted', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, externalMessageId: sent.sentMessage.id ?? null, pending: sent.sentMessage.pending === true });
    if (!sent.sentMessage.id) return { id: `pending:${context.correlationId}`, direction: 'outbound', content: text, timestamp: sent.sentMessage.timestamp, status: 'sent', messageType: 'text', chatId: conversation.chatId, senderWhatsappId: conversation.chatId, metadata: { pending: true } };
    log('info', 'Inbox outbound persistence started', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, externalMessageId: sent.sentMessage.id, chatId: conversation.chatId });
    let persisted;
    try {
      persisted = await this.conversations.recordOutbound({ workspaceId: context.workspaceId, wahaSession: conversation.whatsappSessionId, chatId: conversation.chatId, externalMessageId: sent.sentMessage.id, text, occurredAt: sent.sentMessage.timestamp });
    } catch (error) {
      log('error', 'Inbox outbound persistence failed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, externalMessageId: sent.sentMessage.id, chatId: conversation.chatId, ...errorDiagnostics(error) });
      throw error;
    }
    log('info', 'Inbox outbound persistence completed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, persistedConversationId: persisted.persistence.conversationId ?? null, externalMessageId: sent.sentMessage.id, messageInserted: persisted.persistence.messageInserted, duplicate: persisted.persistence.duplicate });
    const { persistence, ...message } = persisted;
    try {
      if (persistence.messageInserted && persistence.conversationId) await this.automation?.run({ workspaceId: context.workspaceId, conversationId: persistence.conversationId, messageId: persisted.id, direction: 'outbound', replay: persistence.duplicate, visible: !persistence.quarantined, technical: persistence.technical, quarantined: persistence.quarantined });
      log('info', 'Inbox outbound automation completed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, messageId: persisted.id, automationRan: persistence.messageInserted && Boolean(persistence.conversationId) });
    } catch (error) {
      log('error', 'Inbox outbound automation failed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, messageId: persisted.id, ...errorDiagnostics(error) });
      throw error;
    }
    try {
      this.realtime.publish(context.workspaceId, 'message.sent', { conversationId, message });
      this.realtime.publish(context.workspaceId, 'conversation.updated', { conversationId });
      log('info', 'Inbox outbound realtime completed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, messageId: persisted.id });
    } catch (error) {
      log('error', 'Inbox outbound realtime failed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, messageId: persisted.id, ...errorDiagnostics(error) });
      throw error;
    }
    return message;
  }
}

function errorDiagnostics(error: unknown): Record<string, unknown> {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  return {
    errorClass: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack?.slice(0, 4_000) ?? null : null,
    databaseCode: typeof value?.code === 'string' ? value.code : null,
    databaseDetails: typeof value?.details === 'string' ? value.details.slice(0, 2_000) : null,
  };
}
