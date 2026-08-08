import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SessionStatus } from '@chatpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteDatabase } from '../persistence/database.js';
import type { StoredWebhook } from './waha-webhook.service.js';
import { isConversationChatId } from './conversation-identity.js';
import { normalizeWhatsAppIdentifier } from './whatsapp-identifier.js';
import { phoneFromIdentifier } from './contact-identity-resolver.service.js';

const supportedEvents = ['message', 'message.ack', 'session.connected', 'session.disconnected'] as const;

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
  providerDeviceId: string;
  providerStatus: string;
  chatproStatus: SessionStatus;
};

export type GowaWebhookSessionStore = {
  findByProviderDeviceId(providerDeviceId: string): Promise<GowaWebhookSession | undefined>;
  updateStatus(input: { workspaceId: string; sessionId: string; providerStatus: string; chatproStatus: SessionStatus; reconciledAt: string }): Promise<void>;
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
export function gowaInboundInboxMessage(event: GowaWebhookEvent, input: { workspaceId: string; sessionId: string }): GowaInboundInboxMessage | undefined {
  const classified = classifyGowaInbound(event, input);
  return classified?.kind === 'message' ? classified.message : undefined;
}

/**
 * The discard view of the same classification. Both exports read the payload
 * through `classifyGowaInbound` on purpose: a second function re-deciding
 * "is this media?" on its own would drift from the ingestion rule, and a log
 * that disagrees with the code it describes is worse than no log.
 */
export function gowaInboundDiscard(event: GowaWebhookEvent, input: { workspaceId: string; sessionId: string }): GowaInboundDiscard | undefined {
  const classified = classifyGowaInbound(event, input);
  return classified?.kind === 'discard' ? classified.discard : undefined;
}

type GowaInboundClassification = { kind: 'message'; message: GowaInboundInboxMessage } | { kind: 'discard'; discard: GowaInboundDiscard };

/** Returns undefined when the event is not an inbound message at all — that is
 * not a discard and must not be logged as one. */
function classifyGowaInbound(event: GowaWebhookEvent, input: { workspaceId: string; sessionId: string }): GowaInboundClassification | undefined {
  if (event.event !== 'message' || event.payload.is_from_me !== false) return undefined;
  const chatId = normalizeWhatsAppIdentifier(text(event.payload.chat_id));
  const chatKind = chatId?.endsWith('@g.us') ? 'group' as const : chatId && isConversationChatId(chatId) ? 'direct' as const : 'unknown' as const;
  const observed = { declaredType: declaredMessageType(event.payload), mediaMimeType: mimeFromGowa(event.payload), hasMediaField: hasMediaField(event.payload), chatKind };
  if (hasMediaField(event.payload)) return { kind: 'discard', discard: { ...observed, reason: 'unsupported_media' } };
  if (unsupportedMessageContent(event.payload)) return { kind: 'discard', discard: { ...observed, reason: 'unsupported_type' } };
  const messageId = text(event.payload.id);
  const body = messageBody(event.payload.body);
  if (!messageId || !body || !chatId || !isConversationChatId(chatId)) return { kind: 'discard', discard: { ...observed, reason: 'invalid_envelope' } };
  const conversationType = chatId.endsWith('@g.us') ? 'group' : 'direct';
  const participant = conversationType === 'group' ? normalizeWhatsAppIdentifier(text(event.payload.from)) : undefined;
  const occurredAt = event.timestamp ?? new Date().toISOString();
  const payload: Record<string, unknown> = { id: messageId, chatId, body, type: 'text', fromMe: false };
  if (participant) payload.participant = participant;
  return {
    kind: 'message',
    message: {
      event: {
        workspaceId: input.workspaceId,
        // These legacy column names now carry the ChatPro public session id for
        // both providers; no GOWA device id or JID is stored in this field.
        wahaSession: input.sessionId,
        externalEventId: `gowa:${messageId}`,
        eventType: 'message',
        occurredAt,
        payload,
        receivedAt: new Date().toISOString(),
      },
      identity: conversationType === 'direct' ? {
        whatsappId: chatId,
        canonicalWhatsappId: chatId,
        phone: phoneFromIdentifier(chatId) ?? null,
        name: safeDisplayName(event.payload.sender_display_name),
        pushName: safeDisplayName(event.payload.from_name),
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
    const row = this.database.prepare("SELECT workspaceId,sessionId,providerDeviceId,providerStatus,chatproStatus FROM whatsapp_provider_sessions WHERE provider='gowa' AND providerDeviceId=?").get(providerDeviceId) as GowaWebhookSession | undefined;
    return row;
  }
  async updateStatus(input: { workspaceId: string; sessionId: string; providerStatus: string; chatproStatus: SessionStatus; reconciledAt: string }): Promise<void> {
    this.database.prepare("UPDATE whatsapp_provider_sessions SET providerStatus=?,chatproStatus=?,reconciliationState='healthy',lastReconciledAt=?,updatedAt=? WHERE workspaceId=? AND provider='gowa' AND sessionId=?").run(input.providerStatus, input.chatproStatus, input.reconciledAt, new Date().toISOString(), input.workspaceId, input.sessionId);
  }
}

export class SupabaseGowaWebhookSessionStore implements GowaWebhookSessionStore {
  constructor(private readonly client: SupabaseClient) {}
  async findByProviderDeviceId(providerDeviceId: string): Promise<GowaWebhookSession | undefined> {
    const { data, error } = await this.client.from('whatsapp_provider_sessions').select('workspace_id,session_id,provider_device_id,provider_status,chatpro_status').eq('provider', 'gowa').eq('provider_device_id', providerDeviceId).maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    return { workspaceId: data.workspace_id, sessionId: data.session_id, providerDeviceId: data.provider_device_id, providerStatus: data.provider_status, chatproStatus: data.chatpro_status as SessionStatus };
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
