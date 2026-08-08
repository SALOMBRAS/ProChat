import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SessionStatus } from '@chatpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteDatabase } from '../persistence/database.js';
import type { StoredWebhook } from './waha-webhook.service.js';
import { normalizeWhatsAppIdentifier } from './whatsapp-identifier.js';
import { gowaConversationKind, normalizeGowaEvent, type CanonicalWhatsAppEvent } from './gowa-normalizer.js';

const supportedEvents = ['message', 'message.ack', 'call.offer', 'session.connected', 'session.disconnected'] as const;

/**
 * `session_id` is GOWA's stable application device slot (created by POST
 * /devices).  `device_id`, in contrast, is the WhatsApp JID and must never be
 * used as the local key or stored by this ingress.
 *
 * The two session event names are deliberately isolated here. Current GOWA
 * releases document message and receipt webhooks, but do not emit connection
 * transitions as webhooks. They make the normalizer ready for a compatible
 * GOWA bridge without pretending that normal GOWA traffic provides them.
 */
const webhookSchema = z.object({
  event: z.enum(supportedEvents),
  device_id: z.string().trim().min(1).max(512),
  session_id: z.string().trim().min(1).max(200),
  timestamp: z.string().datetime().optional(),
  payload: z.record(z.unknown()),
}).passthrough();

export type GowaWebhookEvent = z.infer<typeof webhookSchema>;
export type GowaWebhookSession = {
  workspaceId: string;
  sessionId: string;
  /** Row id of whatsapp_provider_sessions — the durable, provider-scoped key. */
  providerSessionId: string;
  providerDeviceId: string;
  providerStatus: string;
  chatproStatus: SessionStatus;
};

/** Delivery states, ordered. A late `delivered` must never undo a `read`. */
export type GowaAckStatus = 'sent' | 'delivered' | 'read';
const ACK_RANK: Record<string, number> = { sending: 0, received: 0, sent: 1, delivered: 2, read: 3 };

export type GowaWebhookSessionStore = {
  findByProviderDeviceId(providerDeviceId: string): Promise<GowaWebhookSession | undefined>;
  updateStatus(input: { workspaceId: string; sessionId: string; providerStatus: string; chatproStatus: SessionStatus; reconciledAt: string }): Promise<void>;
  /**
   * Persist a delivery receipt. Scoped by providerSessionId — never by
   * workspace + externalMessageId alone: `WAHA vendas/msg-123` and
   * `GOWA vendas/msg-123` are different messages, and writing a receipt on the
   * wrong one is silent corruption. Legacy rows have no providerSessionId yet,
   * so the session id is accepted as fallback during the transition.
   *
   * Returns whether a row actually moved forward, so a retry is a no-op and
   * realtime is not re-published for nothing.
   */
  recordAck(input: { workspaceId: string; providerSessionId: string; sessionId: string; messageId: string; status: GowaAckStatus }): Promise<boolean>;
};

export type GowaNormalizedEvent =
  | { kind: 'session.updated'; providerStatus: string; chatproStatus: SessionStatus; occurredAt: string }
  | { kind: 'message.status.updated'; messageId: string; status: 'sent' | 'delivered' | 'read'; occurredAt: string }
  | { kind: 'ignored' };

/** A text-only GOWA message translated to the existing Inbox persistence envelope. */
export type GowaInboundInboxMessage = {
  event: StoredWebhook;
  identity: { whatsappId: string; canonicalWhatsappId: string; phone: string | null; name: string | null; pushName: string | null; shortName: string | null; profilePictureUrl: string | null } | null;
};

/**
 * Why an inbound GOWA message did not reach the Inbox. This phase still only
 * ingests text, so a discard is expected — but it must be observable, not
 * silent: the sender got an HTTP 202 for a message ChatPro never stored.
 *
 * Every field here is deliberately non-identifying. No chatId, no participant,
 * no body/caption, no media URL, no device id: `chatKind` replaces the JID and
 * `hasMediaField` replaces the URL, so the log answers "what are we losing and
 * how often" without carrying anything the dashboard rules forbid.
 */
export type GowaInboundDiscardReason = 'unsupported_media' | 'unsupported_type' | 'invalid_envelope';
export type GowaInboundDiscard = {
  reason: GowaInboundDiscardReason;
  declaredType: string | null;
  mediaMimeType: string | null;
  hasMediaField: boolean;
  chatKind: 'direct' | 'group' | 'unknown';
};

export class GowaWebhookValidationError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 503, message: string) { super(message); this.name = 'GowaWebhookValidationError'; }
}

/** GOWA signs the exact JSON request body with HMAC-SHA256. */
export function verifyGowaWebhook(rawBody: Buffer, signature: string | undefined, secret: string | undefined): void {
  if (!secret) throw new GowaWebhookValidationError(503, 'GOWA webhook authentication is not configured');
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signature ?? '');
  if (!match) throw new GowaWebhookValidationError(401, 'GOWA webhook signature is invalid');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(match[1], 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new GowaWebhookValidationError(401, 'GOWA webhook signature is invalid');
}

export function parseGowaWebhook(value: unknown): GowaWebhookEvent {
  try { return webhookSchema.parse(value); }
  catch { throw new GowaWebhookValidationError(400, 'GOWA webhook payload is invalid'); }
}

/** Convert only the small Phase 4B subset into provider-neutral internal events. */
export function normalizeGowaWebhook(event: GowaWebhookEvent): GowaNormalizedEvent[] {
  const occurredAt = event.timestamp ?? new Date().toISOString();
  if (event.event === 'session.connected') return [{ kind: 'session.updated', providerStatus: 'connected', chatproStatus: 'connected', occurredAt }];
  if (event.event === 'session.disconnected') return [{ kind: 'session.updated', providerStatus: 'disconnected', chatproStatus: 'disconnected', occurredAt }];
  // A call that did not become a call_log — a group as caller, say — is
  // ignored, not an error: the sender must not be told its webhook was bad.
  if (event.event === 'call.offer') return [{ kind: 'ignored' }];
  if (event.event === 'message') {
    if (event.payload.is_from_me !== true) return [{ kind: 'ignored' }];
    const messageId = text(event.payload.id);
    if (!messageId) throw new GowaWebhookValidationError(400, 'GOWA sent-message webhook is invalid');
    return [{ kind: 'message.status.updated', messageId, status: 'sent', occurredAt }];
  }
  const receiptType = text(event.payload.receipt_type);
  const status = receiptType === 'delivered' ? 'delivered' : receiptType === 'read' || receiptType === 'read_self' ? 'read' : undefined;
  const ids = Array.isArray(event.payload.ids) ? event.payload.ids.map(text).filter((value): value is string => Boolean(value)) : [];
  if (!status || !ids.length) throw new GowaWebhookValidationError(400, 'GOWA receipt webhook is invalid');
  return ids.map(messageId => ({ kind: 'message.status.updated', messageId, status, occurredAt }));
}

/**
 * This is intentionally an adapter, not a second Inbox implementation. It
 * keeps the GOWA-specific payload at the boundary, then hands the existing
 * message/contact/conversation store a provider-neutral text envelope.
 *
 * `chat_id` is mandatory. We never infer a conversation from `from`: in a
 * group, `from` is the participant and using it would create a false private
 * conversation. GOWA's `@s.whatsapp.net` is normalized to ChatPro's canonical
 * `@c.us` before it crosses the Inbox boundary.
 */
export function gowaInboundInboxMessage(event: GowaWebhookEvent, input: { workspaceId: string; sessionId: string; providerSessionId: string }): GowaInboundInboxMessage | undefined {
  const classified = classifyGowaInbound(event, input);
  return classified?.kind === 'message' ? classified.message : undefined;
}

/**
 * The discard view of the same classification. Both exports read the payload
 * through `classifyGowaInbound` on purpose: a second function re-deciding
 * "is this media?" on its own would drift from the ingestion rule, and a log
 * that disagrees with the code it describes is worse than no log.
 */
export function gowaInboundDiscard(event: GowaWebhookEvent, input: { workspaceId: string; sessionId: string; providerSessionId: string }): GowaInboundDiscard | undefined {
  const classified = classifyGowaInbound(event, input);
  return classified?.kind === 'discard' ? classified.discard : undefined;
}

type GowaInboundClassification = { kind: 'message'; message: GowaInboundInboxMessage } | { kind: 'discard'; discard: GowaInboundDiscard };

/** Returns undefined when the event is not an inbound message at all — that is
 * not a discard and must not be logged as one. */
function classifyGowaInbound(event: GowaWebhookEvent, input: { workspaceId: string; sessionId: string; providerSessionId: string }): GowaInboundClassification | undefined {
  if (event.event === 'call.offer') return callLog(event, input);
  if (event.event !== 'message' || event.payload.is_from_me !== false) return undefined;
  // Every field below comes from the canonical normalizer. This function used
  // to read chat_id/from/body itself, which is exactly how the WAHA payload
  // ended up being re-read four different ways in four different files.
  const [canonical] = normalizeGowaEvent(event);
  // The conversation kind is read once, by the normalizer, and survives a
  // discard — a log that cannot say "this was a group" is much less useful.
  const observed = { declaredType: declaredMessageType(event.payload), mediaMimeType: mimeFromGowa(event.payload), hasMediaField: hasMediaField(event.payload), chatKind: gowaConversationKind(event.payload) };
  if (canonical.kind !== 'message') return { kind: 'discard', discard: { ...observed, reason: 'invalid_envelope' } };
  // Defensive net: the payload carries a media shape the normalizer does not
  // type yet. Without this it would fall through to the text branch and a
  // photo would be persisted as a text message with its caption as the body —
  // the message would look delivered while the picture silently vanished.
  if (observed.hasMediaField && !canonical.media) return { kind: 'discard', discard: { ...observed, reason: 'unsupported_media' } };
  const payload = inboxPayload(canonical);
  if (!payload) {
    // Reaching here means the event carried a media shape the normalizer does
    // not type yet — still a drop, but a named and counted one.
    return { kind: 'discard', discard: { ...observed, reason: observed.hasMediaField ? 'unsupported_media' : 'invalid_envelope' } };
  }
  const chatId = canonical.conversation.chatId;
  const conversationType = canonical.conversation.type;
  const occurredAt = canonical.occurredAt;
  // The author only ever travels as `participant`; it never decides the chat.
  if (conversationType === 'group') payload.participant = canonical.author.whatsappId;
  return {
    kind: 'message',
    message: {
      event: {
        workspaceId: input.workspaceId,
        // These legacy column names now carry the ChatPro public session id for
        // both providers; no GOWA device id or JID is stored in this field.
        wahaSession: input.sessionId,
        // A chave durável: novos registros GOWA deixam de nascer com NULL.
        providerSessionId: input.providerSessionId,
        externalEventId: `gowa:${canonical.messageId}`,
        eventType: 'message',
        occurredAt,
        payload,
        receivedAt: new Date().toISOString(),
      },
      // Names and phone already passed the normalizer's safety rules: a JID or
      // a bare phone never survives as a display name, and a @lid never yields
      // a phone.
      identity: conversationType === 'direct' ? {
        whatsappId: chatId,
        canonicalWhatsappId: chatId,
        phone: canonical.author.phone,
        name: canonical.author.displayName,
        pushName: canonical.author.pushName,
        shortName: null,
        profilePictureUrl: null,
      } : null,
    },
  };
}

/**
 * GOWA has no webhook event id. A bounded, process-local fingerprint prevents
 * retry side effects while preserving the existing no-migration scope. A later
 * durable event ledger can replace this without changing the controller.
 */
export class GowaWebhookReplayGuard {
  private readonly entries = new Map<string, number>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly limit = 10_000) {}
  claim(rawBody: Buffer): { duplicate: boolean; fingerprint?: string } {
    this.prune();
    const fingerprint = createHash('sha256').update(rawBody).digest('hex');
    if (this.entries.has(fingerprint)) return { duplicate: true };
    this.entries.set(fingerprint, Date.now() + this.ttlMs);
    return { duplicate: false, fingerprint };
  }
  release(fingerprint: string | undefined): void { if (fingerprint) this.entries.delete(fingerprint); }
  private prune(): void {
    const now = Date.now();
    for (const [fingerprint, expiresAt] of this.entries) if (expiresAt <= now || this.entries.size > this.limit) this.entries.delete(fingerprint);
  }
}

export class SqliteGowaWebhookSessionStore implements GowaWebhookSessionStore {
  constructor(private readonly database: SqliteDatabase) {}
  async findByProviderDeviceId(providerDeviceId: string): Promise<GowaWebhookSession | undefined> {
    const row = this.database.prepare("SELECT id providerSessionId,workspaceId,sessionId,providerDeviceId,providerStatus,chatproStatus FROM whatsapp_provider_sessions WHERE provider='gowa' AND providerDeviceId=?").get(providerDeviceId) as GowaWebhookSession | undefined;
    return row;
  }
  async recordAck(input: { workspaceId: string; providerSessionId: string; sessionId: string; messageId: string; status: GowaAckStatus }): Promise<boolean> {
    const row = this.database.prepare('SELECT status FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=? AND (providerSessionId=? OR (providerSessionId IS NULL AND wahaSession=?))').get(input.workspaceId, input.messageId, input.providerSessionId, input.sessionId) as { status: string } | undefined;
    if (!row || (ACK_RANK[input.status] ?? 0) <= (ACK_RANK[row.status] ?? 0)) return false;
    const result = this.database.prepare('UPDATE whatsapp_messages SET status=? WHERE workspaceId=? AND externalMessageId=? AND (providerSessionId=? OR (providerSessionId IS NULL AND wahaSession=?))').run(input.status, input.workspaceId, input.messageId, input.providerSessionId, input.sessionId);
    return result.changes > 0;
  }
  async updateStatus(input: { workspaceId: string; sessionId: string; providerStatus: string; chatproStatus: SessionStatus; reconciledAt: string }): Promise<void> {
    this.database.prepare("UPDATE whatsapp_provider_sessions SET providerStatus=?,chatproStatus=?,reconciliationState='healthy',lastReconciledAt=?,updatedAt=? WHERE workspaceId=? AND provider='gowa' AND sessionId=?").run(input.providerStatus, input.chatproStatus, input.reconciledAt, new Date().toISOString(), input.workspaceId, input.sessionId);
  }
}

export class SupabaseGowaWebhookSessionStore implements GowaWebhookSessionStore {
  constructor(private readonly client: SupabaseClient) {}
  async findByProviderDeviceId(providerDeviceId: string): Promise<GowaWebhookSession | undefined> {
    const { data, error } = await this.client.from('whatsapp_provider_sessions').select('id,workspace_id,session_id,provider_device_id,provider_status,chatpro_status').eq('provider', 'gowa').eq('provider_device_id', providerDeviceId).maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    return { providerSessionId: data.id, workspaceId: data.workspace_id, sessionId: data.session_id, providerDeviceId: data.provider_device_id, providerStatus: data.provider_status, chatproStatus: data.chatpro_status as SessionStatus };
  }
  async recordAck(input: { workspaceId: string; providerSessionId: string; sessionId: string; messageId: string; status: GowaAckStatus }): Promise<boolean> {
    const { data, error } = await this.client.from('whatsapp_messages').select('status,provider_session_id,waha_session').eq('workspace_id', input.workspaceId).eq('external_message_id', input.messageId);
    if (error) throw error;
    // PostgREST has no OR-with-IS-NULL that reads well here; the row set for a
    // single external id is tiny, so the scope is applied in code.
    const row = (data ?? []).find(candidate => candidate.provider_session_id === input.providerSessionId || (candidate.provider_session_id === null && candidate.waha_session === input.sessionId));
    if (!row || (ACK_RANK[input.status] ?? 0) <= (ACK_RANK[row.status as string] ?? 0)) return false;
    const update = this.client.from('whatsapp_messages').update({ status: input.status }).eq('workspace_id', input.workspaceId).eq('external_message_id', input.messageId);
    const { error: updateError } = await (row.provider_session_id === null ? update.eq('waha_session', input.sessionId) : update.eq('provider_session_id', input.providerSessionId));
    if (updateError) throw updateError;
    return true;
  }
  async updateStatus(input: { workspaceId: string; sessionId: string; providerStatus: string; chatproStatus: SessionStatus; reconciledAt: string }): Promise<void> {
    const { error } = await this.client.from('whatsapp_provider_sessions').update({ provider_status: input.providerStatus, chatpro_status: input.chatproStatus, reconciliation_state: 'healthy', last_reconciled_at: input.reconciledAt, updated_at: new Date().toISOString() }).eq('workspace_id', input.workspaceId).eq('provider', 'gowa').eq('session_id', input.sessionId);
    if (error) throw error;
  }
}

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() && value.length <= 512 ? value : undefined; }
function messageBody(value: unknown): string | undefined { return typeof value === 'string' && value.trim() && value.length <= 20_000 ? value : undefined; }
function safeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, 240);
  if (!name || normalizeWhatsAppIdentifier(name) || !/[^\d()\s+.\-]/u.test(name)) return null;
  return name;
}
/**
 * `call.offer` becomes the same `call_log` message WAHA already produces.
 *
 * That is a closed product decision (docs/call-log-na-inbox.md, 28/07/2026):
 * `call_log` is deliberately absent from `technicalMessageTypes`, so a missed
 * call opens or updates the conversation, counts as unread and starts the SLA
 * clock. A missed call is a customer trying to reach the company and failing —
 * migrating provider must not quietly delete that.
 */
function callLog(event: GowaWebhookEvent, input: { workspaceId: string; sessionId: string; providerSessionId: string }): GowaInboundClassification | undefined {
  const [canonical] = normalizeGowaEvent(event);
  if (canonical.kind !== 'call') return undefined;
  const chatId = canonical.conversation.chatId;
  // GOWA gives no message id for a call, so the call id — or a stable
  // fingerprint of caller+instant — keeps retries idempotent.
  const messageId = canonical.callId ?? `call:${createHash('sha256').update(`${chatId} ${canonical.occurredAt}`).digest('hex').slice(0, 32)}`;
  return {
    kind: 'message',
    message: {
      event: {
        workspaceId: input.workspaceId, wahaSession: input.sessionId, providerSessionId: input.providerSessionId,
        externalEventId: `gowa:${messageId}`, eventType: 'message', occurredAt: canonical.occurredAt,
        payload: { id: messageId, chatId, type: 'call_log', fromMe: false, body: null },
        receivedAt: new Date().toISOString(),
      },
      identity: {
        whatsappId: chatId, canonicalWhatsappId: chatId, phone: canonical.author.phone,
        name: canonical.author.displayName, pushName: canonical.author.pushName, shortName: null, profilePictureUrl: null,
      },
    },
  };
}

/**
 * Canonical event -> the payload shape `messageFrom` already knows how to read.
 *
 * This is the whole point of the migration: GOWA media, location and cards go
 * through the *existing* pipeline — media persistence, proxy, storage, signed
 * URLs, quarantine — instead of a second media system. The adapter writes the
 * fields that pipeline reads (`type`, `media.url`, `media.mimetype`,
 * `hasMedia`, `location`, `vCards`) and nothing else.
 *
 * `media.url` may legitimately be absent: with WHATSAPP_AUTO_DOWNLOAD_MEDIA on,
 * GOWA reports a path on its own filesystem, which this code never reads. The
 * message is still persisted with its real type, so the conversation shows
 * "Foto" instead of nothing, and the bytes are fetched later through
 * GET /message/:id/download. Losing the bytes for now is recoverable; losing
 * the message is not.
 */
function inboxPayload(canonical: Extract<CanonicalWhatsAppEvent, { kind: 'message' }>): Record<string, unknown> | undefined {
  const base: Record<string, unknown> = { id: canonical.messageId, chatId: canonical.conversation.chatId, fromMe: false };
  if (canonical.quotedMessageId) base.replyTo = canonical.quotedMessageId;

  if (canonical.media) {
    const type = canonical.media.kind === 'voice' ? 'ptt' : canonical.media.kind;
    return {
      ...base, type, hasMedia: true,
      body: canonical.media.caption ?? canonical.body ?? null,
      media: {
        ...(canonical.media.url ? { url: canonical.media.url } : {}),
        ...(canonical.media.mimeType ? { mimetype: canonical.media.mimeType } : {}),
        ...(canonical.media.filename ? { filename: canonical.media.filename } : {}),
        ...(canonical.media.size === null ? {} : { filesize: canonical.media.size }),
      },
    };
  }

  if (canonical.location) {
    // `bodyFrom` takes the visible text of a location from `location.name`,
    // never from the root body — that root body is the base64 map thumbnail
    // in WEBJS, and copying it to a column is the incident CLAUDE.md §7 cites.
    return { ...base, type: 'location', location: { latitude: canonical.location.latitude, longitude: canonical.location.longitude, ...(canonical.location.title ? { name: canonical.location.title } : {}) } };
  }

  if (canonical.contacts) {
    // Inbound is not limited by the outbound one-contact restriction: GOWA
    // sends one per message, but it may report several in a single event.
    const vCards = canonical.contacts.map(card => card.vcard).filter((card): card is string => Boolean(card));
    return { ...base, type: 'vcard', contacts: canonical.contacts, ...(vCards.length ? { vCards } : {}) };
  }

  const body = messageBody(canonical.body);
  return body ? { ...base, type: 'text', body } : undefined;
}

/** Canonical accessors for the GOWA payload. The ingestion rule and the discard
 * log must never read these fields independently: one place decides, both read
 * the same answer. Same reasoning as the WAHA `_data` rule in CLAUDE.md §7,
 * applied to a flatter payload. */
function hasMediaField(payload: Record<string, unknown>): boolean {
  return payload.media !== undefined || payload.url !== undefined || payload.mime_type !== undefined || payload.mimetype !== undefined;
}
/** The mime alone, never the URL: a GOWA media URL can carry an access token. */
function mimeFromGowa(payload: Record<string, unknown>): string | null {
  return text(payload.mime_type)?.toLowerCase() ?? text(payload.mimetype)?.toLowerCase() ?? null;
}
function declaredMessageType(payload: Record<string, unknown>): string | null {
  return text(payload.type)?.toLowerCase() ?? null;
}
function unsupportedMessageContent(payload: Record<string, unknown>): boolean {
  if (hasMediaField(payload)) return true;
  const type = declaredMessageType(payload);
  return Boolean(type && type !== 'text' && type !== 'chat');
}
