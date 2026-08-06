import type { RequestContext, LinkPreview } from '@chatpro/contracts';
import { AppError } from '../errors.js';
import { InternalWorkerClient } from '../internal-worker-client.js';
import type { ConversationStore, InboxMessage, MessageReaction, ReactionStore } from './waha-webhook.service.js';
import type { RealtimeHub } from '../realtime.js';
import { conversationAudience } from '../realtime.js';
import type { KanbanAutomationCoordinator } from './kanban-automation.service.js';
import type { SlaMessageCoordinator } from './sla-message-coordinator.service.js';
import type { WhatsAppSessionActivityService } from './whatsapp-session-activity.service.js';
import { log } from '../logging.js';

const statusFor = (code: string): number => ({ VALIDATION_ERROR: 400, NOT_FOUND: 404, CONFLICT: 409, TIMEOUT: 504, SERVICE_UNAVAILABLE: 503, PROVIDER_CONTRACT_ERROR: 502 }[code] ?? 503);

export class InternalInboxService {
  constructor(private readonly worker: InternalWorkerClient, private readonly conversations: ConversationStore & ReactionStore, private readonly realtime: RealtimeHub, private readonly automation?: KanbanAutomationCoordinator, private readonly sla?: SlaMessageCoordinator, private readonly sessionActivity?: Pick<WhatsAppSessionActivityService, 'assertActive'>) {}
  /**
   * Reação do operador. Mesma disciplina do `deliver` — conversa, sessão viva,
   * worker, persistência, realtime — mas sem criar mensagem: a reação atualiza
   * o payload da mensagem-alvo. A persistência é otimista porque o WAHA não
   * ecoa `message.reaction` para envios feitos pela API; uma reação feita no
   * telefone chega pelo webhook e reconcilia pelo `fromMe`, pois as duas são a
   * mesma conta no protocolo.
   */
  async sendReaction(context: RequestContext, conversationId: string, messageId: string, emoji: string): Promise<{ messageId: string; reactions: MessageReaction[] }> {
    const conversation = await this.conversations.getConversation(context.workspaceId, conversationId);
    if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    await this.sessionActivity?.assertActive(context, conversation.whatsappSessionId);
    const current = await this.conversations.messageReactions(context.workspaceId, conversation.whatsappSessionId, messageId);
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Message not found');
    // Toggle do WhatsApp Web: a reação "da conta" é qualquer entrada `fromMe`,
    // e reagir com o emoji que a conta já tem envia a remoção (`""`) ao WAHA.
    const mine = current.find(reaction => reaction.fromMe);
    const reaction = mine?.emoji === emoji ? '' : emoji;
    log('info', 'Inbox reaction send started', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, messageId, removal: reaction.length === 0 });
    const response = await this.worker.send({ correlationId: context.correlationId, workspaceId: context.workspaceId, command: { type: 'message.sendReaction', payload: { wahaSession: conversation.whatsappSessionId, chatId: conversation.deliveryChatId ?? conversation.chatId, messageId, reaction } } });
    if (!response.success) {
      log('error', 'Inbox reaction worker rejected send', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, messageId, workerCode: response.error.code, workerMessage: response.error.message });
      throw new AppError(statusFor(response.error.code), response.error.code, response.error.message, response.error.details);
    }
    const applied = await this.conversations.ingestReaction({ workspaceId: context.workspaceId, wahaSession: conversation.whatsappSessionId, messageId, author: `operator:${context.userId ?? 'unknown'}`, emoji: reaction, fromMe: true, reactedAt: new Date().toISOString() });
    if (applied.conversationId && applied.action !== 'noop' && applied.action !== 'orphan') this.realtime.publish(context.workspaceId, 'message.reaction.updated', { conversationId: applied.conversationId, messageId, reactions: applied.reactions }, conversationAudience(conversation));
    log('info', 'Inbox reaction applied', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, messageId, action: applied.action });
    return { messageId, reactions: applied.reactions };
  }
  /**
   * Same delivery, persistence and automation as a text send; only the worker
   * command and what gets stored differ. The message keeps `messageType`
   * `location` and the coordinates travel in the stored payload, which the
   * message reader already surfaces as `metadata` — so no column, no migration
   * and no change to either repository.
   */
  sendLocation(context: RequestContext, conversationId: string, location: { latitude: number; longitude: number; title?: string }): Promise<InboxMessage> {
    return this.deliver(context, conversationId, {
      command: session => ({ type: 'message.sendContent' as const, payload: { wahaSession: session.wahaSession, chatId: session.chatId, content: { kind: 'location' as const, latitude: location.latitude, longitude: location.longitude, ...(location.title ? { title: location.title } : {}) } } }),
      messageType: 'location',
      body: location.title ?? null,
      payload: { location: { latitude: location.latitude, longitude: location.longitude, ...(location.title ? { title: location.title } : {}) } },
    });
  }
  /**
   * `message_type` is `contact`, not `vcard`: `vcard` names WAHA's endpoint,
   * while `contact` is the value this codebase already speaks — the conversation
   * preview answered `Contato` for it before this existed. The contract keeps
   * `kind: 'vcard'` because that is the provider's vocabulary.
   */
  sendVcard(context: RequestContext, conversationId: string, contacts: ReadonlyArray<{ fullName: string; phoneNumber: string; organization?: string }>): Promise<InboxMessage> {
    return this.deliver(context, conversationId, {
      command: session => ({ type: 'message.sendContent' as const, payload: { wahaSession: session.wahaSession, chatId: session.chatId, content: { kind: 'vcard' as const, contacts } } }),
      messageType: 'contact',
      body: contacts.length === 1 ? contacts[0].fullName : `${contacts[0].fullName} e mais ${contacts.length - 1}`,
      payload: { contacts },
    });
  }
  send(context: RequestContext, conversationId: string, text: string, mentions?: string[], linkPreview?: boolean): Promise<InboxMessage> {
    return this.deliver(context, conversationId, {
      // A prévia é o padrão (como o WhatsApp); o operador só a desliga ao
      // dispensar o cartão do compositor — por isso só o `false` viaja.
      command: session => ({ type: 'message.send' as const, payload: { wahaSession: session.wahaSession, chatId: session.chatId, text, ...(mentions?.length ? { mentions } : {}), ...(linkPreview === false ? { linkPreview: false } : {}) } }),
      messageType: 'text',
      body: text,
      // A prévia nativa só existe depois que o worker envia (o WhatsApp a gera e
      // a WAHA a devolve no `sentMessage`). Texto sem URL volta sem ela — e
      // nenhum payload é gravado. `mentions` viaja no payload pelo mesmo motivo
      // do `contacts` do vCard: é o que permite o destaque das ENVIADAS depois.
      payload: sent => { const merged = { ...(sent.linkPreview ? { linkPreview: sent.linkPreview } : {}), ...(mentions?.length ? { mentions } : {}) }; return Object.keys(merged).length ? merged : undefined; },
    });
  }
  private async deliver(context: RequestContext, conversationId: string, outbound: { command: (session: { wahaSession: string; chatId: string }) => { type: 'message.send' | 'message.sendContent'; payload: Record<string, unknown> }; messageType: string; body: string | null; payload?: Record<string, unknown> | ((sent: { id?: string; timestamp: string; pending?: boolean; linkPreview?: LinkPreview }) => Record<string, unknown> | undefined) }): Promise<InboxMessage> {
    const text = outbound.body;
    const conversation = await this.conversations.getConversation(context.workspaceId, conversationId);
    if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    // O worker reconcilia nomes de sessão por alias: quando a sessão gravada na
    // conversa foi substituída por um novo pareamento, ele resolve para a sessão
    // atual e a mensagem sai de verdade — mas fica gravada na conversa antiga,
    // enquanto a resposta do cliente chega carimbada com a sessão nova e cai em
    // outra conversa. A recusa aqui é o que impede a thread de partir.
    await this.sessionActivity?.assertActive(context, conversation.whatsappSessionId);
    const deliveryChatId = conversation.deliveryChatId ?? conversation.chatId;
    log('info', 'Inbox message send started', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, wahaSession: conversation.whatsappSessionId, chatId: deliveryChatId });
    let response;
    try {
      response = await this.worker.send({ correlationId: context.correlationId, workspaceId: context.workspaceId, command: outbound.command({ wahaSession: conversation.whatsappSessionId, chatId: deliveryChatId }) as never });
    } catch (error) {
      log('error', 'Inbox outbound worker transport failed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, stage: 'worker_transport', ...errorDiagnostics(error) });
      throw error;
    }
    if (!response.success) {
      log('error', 'Inbox outbound worker rejected send', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, stage: 'worker_delivery', workerCode: response.error.code, workerMessage: response.error.message });
      throw new AppError(statusFor(response.error.code), response.error.code, response.error.message, response.error.details);
    }
    const sent = response.data as { sentMessage?: { id?: string; timestamp: string; pending?: boolean; linkPreview?: LinkPreview } };
    if (!sent.sentMessage) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Internal worker returned an invalid response');
    const payload = typeof outbound.payload === 'function' ? outbound.payload(sent.sentMessage) : outbound.payload;
    log('info', 'Inbox message send accepted', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, externalMessageId: sent.sentMessage.id ?? null, pending: sent.sentMessage.pending === true });
    if (!sent.sentMessage.id) return { id: `pending:${context.correlationId}`, direction: 'outbound', content: text, timestamp: sent.sentMessage.timestamp, status: 'sent', messageType: outbound.messageType, chatId: conversation.chatId, senderWhatsappId: conversation.chatId, metadata: { pending: true, ...(payload ?? {}) }, reactions: [] };
    log('info', 'Inbox outbound persistence started', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, externalMessageId: sent.sentMessage.id, chatId: conversation.chatId });
    let persisted;
    try {
      persisted = await this.conversations.recordOutbound({ workspaceId: context.workspaceId, wahaSession: conversation.whatsappSessionId, chatId: conversation.chatId, externalMessageId: sent.sentMessage.id, text, occurredAt: sent.sentMessage.timestamp, type: outbound.messageType, ...(payload ? { payload } : {}) });
    } catch (error) {
      log('error', 'Inbox outbound persistence failed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, externalMessageId: sent.sentMessage.id, chatId: conversation.chatId, ...errorDiagnostics(error) });
      throw error;
    }
    log('info', 'Inbox outbound persistence completed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, persistedConversationId: persisted.persistence.conversationId ?? null, externalMessageId: sent.sentMessage.id, messageInserted: persisted.persistence.messageInserted, duplicate: persisted.persistence.duplicate });
    const { persistence, ...message } = persisted;
    try {
      if (persistence.messageInserted && persistence.conversationId) await this.automation?.run({ workspaceId: context.workspaceId, conversationId: persistence.conversationId, messageId: persisted.id, direction: 'outbound', historical: Boolean(persistence.historical), replay: persistence.duplicate, visible: !persistence.quarantined, technical: persistence.technical, quarantined: persistence.quarantined });
      if (persistence.messageInserted && persistence.conversationId) await this.sla?.run({ workspaceId: context.workspaceId, conversationId: persistence.conversationId, messageId: persisted.id, direction: 'outbound', occurredAt: persisted.timestamp, historical: Boolean(persistence.historical) });
      log('info', 'Inbox outbound automation completed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, messageId: persisted.id, automationRan: persistence.messageInserted && Boolean(persistence.conversationId) });
    } catch (error) {
      log('error', 'Inbox outbound automation failed', { correlationId: context.correlationId, workspaceId: context.workspaceId, conversationId, messageId: persisted.id, ...errorDiagnostics(error) });
      throw error;
    }
    try {
      this.realtime.publish(context.workspaceId, 'message.sent', { conversationId, message }, conversationAudience(conversation));
      this.realtime.publish(context.workspaceId, 'conversation.updated', { conversationId }, conversationAudience(conversation));
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
