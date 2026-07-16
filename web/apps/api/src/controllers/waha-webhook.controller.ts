import type { RequestHandler } from 'express';
import { log } from '../logging.js';
import { WahaWebhookValidationError, parseWebhook, verifyWahaWebhook, webhookRecord, type WahaWebhookStore } from '../services/waha-webhook.service.js';
import type { RealtimeHub } from '../realtime.js';
export class WahaWebhookController {
  constructor(private readonly store: WahaWebhookStore, private readonly realtime: RealtimeHub, private readonly options: { hmacKey?: string; workspaceId?: string }) {}
  receive: RequestHandler = async (req, res, next) => { try {
    verifyWahaWebhook(req.rawBody ?? Buffer.alloc(0), { hmac: req.header('x-webhook-hmac') ?? undefined, algorithm: req.header('x-webhook-hmac-algorithm') ?? undefined, timestamp: req.header('x-webhook-timestamp') ?? undefined }, this.options.hmacKey);
    if (!this.options.workspaceId) throw new WahaWebhookValidationError(503, 'WAHA webhook workspace is not configured');
    const event = parseWebhook(req.body); const result = await this.store.ingest(webhookRecord(event, this.options.workspaceId)); if (!result.duplicate) { if (event.event === 'message' || event.event === 'message.any') { const direction = event.payload.fromMe === true ? 'message.sent' : 'message.received'; this.realtime.publish(this.options.workspaceId, direction, { wahaSession: event.session, messageId: event.payload.id }); this.realtime.publish(this.options.workspaceId, 'conversation.updated', { wahaSession: event.session, chatId: event.payload.chatId ?? event.payload.from }); } if (event.event === 'session.status') this.realtime.publish(this.options.workspaceId, 'session.status.changed', { sessionId: event.session, status: event.payload.status ?? 'unknown', changedAt: new Date(event.timestamp).toISOString() }); }
    log('info', 'WAHA webhook accepted', { eventType: event.event, session: event.session, duplicate: result.duplicate }); res.status(result.duplicate ? 200 : 202).json({ accepted: true, duplicate: result.duplicate });
  } catch (error) { if (error instanceof WahaWebhookValidationError) return res.status(error.status).json({ error: { code: error.status === 401 ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE', message: error.message } }); next(error); } };
}
