import type { RequestHandler } from 'express';
import type { RealtimeHub } from '../realtime.js';
import type { ConversationStore, WahaWebhookStore } from '../services/waha-webhook.service.js';
import type { WhatsAppIdentityStore } from '../services/whatsapp-identity-sync.service.js';
import { log } from '../logging.js';
import { GowaWebhookReplayGuard, GowaWebhookValidationError, gowaInboundDiscard, gowaInboundInboxMessage, normalizeGowaWebhook, parseGowaWebhook, type GowaWebhookSessionStore, verifyGowaWebhook } from '../services/gowa-webhook.service.js';

/** Separate ingress; inbound text is adapted into the provider-neutral Inbox store. */
export class GowaWebhookController {
  constructor(private readonly store: GowaWebhookSessionStore, private readonly realtime: RealtimeHub, private readonly options: { secret?: string }, private readonly inbox: WahaWebhookStore & Pick<ConversationStore, 'getConversation'>, private readonly identities: WhatsAppIdentityStore, private readonly replay = new GowaWebhookReplayGuard()) {}

  receive: RequestHandler = async (req, res, next) => {
    let fingerprint: string | undefined;
    try {
      const rawBody = req.rawBody ?? Buffer.alloc(0);
      verifyGowaWebhook(rawBody, req.header('x-hub-signature-256') ?? undefined, this.options.secret);
      const claimed = this.replay.claim(rawBody);
      if (claimed.duplicate) return res.status(200).json({ accepted: true, duplicate: true });
      fingerprint = claimed.fingerprint;
      const event = parseGowaWebhook(req.body);
      // `session_id` is the provider slot mapped in whatsapp_provider_sessions.
      // The webhook's device_id is a JID and is intentionally not read below.
      const session = await this.store.findByProviderDeviceId(event.session_id);
      if (!session) throw new GowaWebhookValidationError(404, 'GOWA webhook session is unknown');
      const inbound = gowaInboundInboxMessage(event, { workspaceId: session.workspaceId, sessionId: session.sessionId });
      if (inbound) {
        // Persist direct-contact identity before the shared Inbox store resolves
        // its contact. This preserves profile/push name precedence and never
        // asks the WAHA worker to resolve a GOWA session.
        if (inbound.identity) await this.identities.persist({ workspaceId: session.workspaceId, wahaSession: session.sessionId, chatId: inbound.identity.whatsappId }, { identity: inbound.identity, group: null });
        const result = await this.inbox.ingest(inbound.event);
        if (result.duplicate) return res.status(200).json({ accepted: true, duplicate: true });
        if (result.messageInserted) {
          // The standard Inbox listener refreshes from these neutral events.
          // Neither provider device_id nor JID leaves this realtime payload.
          this.realtime.publish(session.workspaceId, 'message.received', { sessionId: session.sessionId, messageId: result.messageId });
          if (result.conversationId) this.realtime.publish(session.workspaceId, 'conversation.updated', { sessionId: session.sessionId, conversationId: result.conversationId });
        }
        return res.status(202).json({ accepted: true, duplicate: false });
      }
      // An inbound message that did not become Inbox data is data loss: the
      // sender already has our 202. This phase still ingests text only, so the
      // drop stays — but it stops being invisible. Counting `reason` over time
      // is what says whether GOWA media is worth implementing next.
      const discarded = gowaInboundDiscard(event, { workspaceId: session.workspaceId, sessionId: session.sessionId });
      if (discarded) log('info', 'GOWA inbound message discarded before the Inbox', { workspaceId: session.workspaceId, sessionId: session.sessionId, ...discarded });
      const normalized = normalizeGowaWebhook(event);
      for (const item of normalized) {
        if (item.kind === 'ignored') continue;
        if (item.kind === 'session.updated') {
          const previousStatus = session.chatproStatus;
          await this.store.updateStatus({ workspaceId: session.workspaceId, sessionId: session.sessionId, providerStatus: item.providerStatus, chatproStatus: item.chatproStatus, reconciledAt: item.occurredAt });
          if (previousStatus !== item.chatproStatus) this.realtime.publish(session.workspaceId, 'session.status.changed', { sessionId: session.sessionId, status: item.chatproStatus, previousStatus, changedAt: item.occurredAt });
          continue;
        }
        this.realtime.publish(session.workspaceId, 'message.status.updated', { sessionId: session.sessionId, messageId: item.messageId, status: item.status, changedAt: item.occurredAt });
      }
      return res.status(202).json({ accepted: true, duplicate: false });
    } catch (error) {
      this.replay.release(fingerprint);
      if (error instanceof GowaWebhookValidationError) return res.status(error.status).json({ error: { code: error.status === 401 ? 'UNAUTHORIZED' : error.status === 404 ? 'NOT_FOUND' : error.status === 503 ? 'SERVICE_UNAVAILABLE' : 'VALIDATION_ERROR', message: error.message } });
      next(error);
    }
  };
}
