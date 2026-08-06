import type { RequestHandler } from 'express';
import { log } from '../logging.js';
import { WahaWebhookValidationError, parseWebhook, reactionFrom, verifyWahaWebhook, webhookRecord, type ConversationStore, type ReactionStore, type WahaWebhookStore } from '../services/waha-webhook.service.js';
import type { RealtimeAudience, RealtimeHub } from '../realtime.js';
import { conversationAudience } from '../realtime.js';
import type { WhatsAppIdentitySyncService } from '../services/whatsapp-identity-sync.service.js';
import type { WhatsAppMediaPersistenceService } from '../services/whatsapp-media-persistence.service.js';
import type { DepartmentAssignmentService } from '../services/department-assignment.service.js';
import { wahaMessageType } from '../services/conversation-identity.js';

export class WahaWebhookController {
  constructor(private readonly store: WahaWebhookStore & ReactionStore & Pick<ConversationStore, 'getConversation'>, private readonly realtime: RealtimeHub, private readonly options: { hmacKey?: string; workspaceId?: string }, private readonly identitySync?: WhatsAppIdentitySyncService, private readonly onOutboundMessage?: (workspaceId: string, externalMessageId: string) => Promise<void>, private readonly mediaPersistence?: WhatsAppMediaPersistenceService, private readonly departmentAssignment?: Pick<DepartmentAssignmentService, 'onConversationCreated'>) {}
  receive: RequestHandler = async (req, res, next) => { try {
    verifyWahaWebhook(req.rawBody ?? Buffer.alloc(0), { hmac: req.header('x-webhook-hmac') ?? undefined, algorithm: req.header('x-webhook-hmac-algorithm') ?? undefined, timestamp: req.header('x-webhook-timestamp') ?? undefined }, this.options.hmacKey);
    if (!this.options.workspaceId) throw new WahaWebhookValidationError(503, 'WAHA webhook workspace is not configured');
    const event = parseWebhook(req.body);
    // Reação não é mensagem: o desvio acontece antes do `ingest`, porque o
    // CHECK de `eventType` em `waha_webhook_events` não a conhece e ela
    // atualiza a mensagem-alvo em vez de criar uma linha nova.
    if (event.event === 'message.reaction') {
      const reaction = reactionFrom(webhookRecord(event, this.options.workspaceId));
      if (!reaction) return res.status(202).json({ accepted: true, duplicate: false });
      const result = await this.store.ingestReaction(reaction);
      if (result.conversationId && result.action !== 'noop' && result.action !== 'orphan') this.realtime.publish(this.options.workspaceId, 'message.reaction.updated', { conversationId: result.conversationId, messageId: result.messageId, reactions: result.reactions }, await this.audienceFor(this.options.workspaceId, result.conversationId));
      log('info', 'WAHA reaction accepted', { correlationId: event.id, eventId: event.id, session: event.session, messageId: result.messageId, action: result.action, conversationId: result.conversationId ?? null });
      return res.status(202).json({ accepted: true, duplicate: false });
    }
    const result = await this.store.ingest(webhookRecord(event, this.options.workspaceId));
    // Auto-atribuição instância→departamento: só conversa recém-criada, em
    // segundo plano — uma falha aqui é logada e nunca derruba o webhook.
    if (result.conversationCreated && result.conversationId) void this.departmentAssignment?.onConversationCreated(this.options.workspaceId, event.session, result.conversationId).catch(error => log('error', 'Department auto-assignment failed', { correlationId: event.id, eventId: event.id, session: event.session, conversationId: result.conversationId, error: error instanceof Error ? error.stack ?? error.message : String(error) }));
    if (event.event === 'message' || event.event === 'message.any') {
      const messageId = firstString(event.payload.id, nestedString(event.payload.key, 'id'));
      const media = event.payload.media as Record<string, unknown> | undefined;
      const url = firstString(media?.url, event.payload.mediaUrl);
      if (messageId && url) try { await this.mediaPersistence?.persist({ workspaceId: this.options.workspaceId, externalMessageId: messageId, url, mimeType: firstString(media?.mimetype, media?.mimeType) ?? null, filename: firstString(media?.filename, event.payload.filename) ?? null, messageType: wahaMessageType(event.payload) ?? null }); } catch { log('error', 'WAHA media persistence failed', { session: event.session, messageId }); }
      if (!result.duplicate) {
        const audience = result.conversationId ? await this.audienceFor(this.options.workspaceId, result.conversationId) : undefined;
        this.realtime.publish(this.options.workspaceId, event.payload.fromMe === true ? 'message.sent' : 'message.received', { wahaSession: event.session, messageId }, audience);
        if (result.conversationChatId) this.realtime.publish(this.options.workspaceId, 'conversation.updated', { wahaSession: event.session, chatId: result.conversationChatId }, audience);
        if (event.payload.fromMe === true && messageId) await this.onOutboundMessage?.(this.options.workspaceId, messageId);
        // For groups, synchronize only group metadata; the service suppresses participant identity resolution.
        if (result.conversationChatId) this.identitySync?.enqueue({ workspaceId: this.options.workspaceId, wahaSession: event.session, chatId: result.conversationChatId, ...(result.conversationType === 'group' && result.senderWhatsappId ? { senderWhatsappId: result.senderWhatsappId } : {}) });
      }
    }
    if (!result.duplicate && event.event === 'session.status') this.realtime.publish(this.options.workspaceId, 'session.status.changed', { sessionId: event.session, status: event.payload.status ?? 'unknown', changedAt: new Date(event.timestamp).toISOString() });
    log('info', 'WAHA webhook accepted', { correlationId: event.id, eventId: event.id, eventType: event.event, session: event.session, duplicate: result.duplicate, messageId: result.messageId ?? null, chatIdReceived: firstString(event.payload.chatId, event.payload.chat_id, event.payload.remoteJid, event.payload.remote_jid) ?? null, chatIdNormalized: result.conversationChatId ?? null, conversationId: result.conversationId ?? null, messageInserted: result.messageInserted, lastMessageAt: result.lastMessageAt ?? null, discardReason: !result.messageId && (event.event === 'message' || event.event === 'message.any') ? 'message_not_persisted' : null });
    res.status(result.duplicate ? 200 : 202).json({ accepted: true, duplicate: result.duplicate });
  } catch (error) { if (error instanceof WahaWebhookValidationError) return res.status(error.status).json({ error: { code: error.status === 401 ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE', message: error.message } }); next(error); } };
  /** Leitura pontual da conversa para rotear o evento por departamento — nunca
   *  varre listas. Conversa desconhecida vira `conversationTeamId: null`:
   *  fail-open, porque conversa sem departamento é de todos. */
  private async audienceFor(workspaceId: string, conversationId: string): Promise<RealtimeAudience> {
    const conversation = await this.store.getConversation(workspaceId, conversationId);
    return conversationAudience(conversation ?? { assignedTeamId: null, assignedUserId: null });
  }
}
function firstString(...values: unknown[]): string | undefined { return values.find(value => typeof value === 'string' && value.trim()) as string | undefined; }
function nestedString(value: unknown, key: string): string | undefined { return value && typeof value === 'object' && typeof (value as Record<string, unknown>)[key] === 'string' ? (value as Record<string, unknown>)[key] as string : undefined; }
