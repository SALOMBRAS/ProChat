import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteDatabase } from '../persistence/database.js';

const acceptedEvents = ['message', 'message.any', 'session.status'] as const;
const sensitiveKey = /(api[_-]?key|authorization|credential|token|secret|password|cookie|auth)/i;
const webhookSchema = z.object({ id: z.string().min(1).max(200), timestamp: z.number().int().nonnegative(), event: z.enum(acceptedEvents), session: z.string().min(1).max(200), payload: z.record(z.unknown()) }).passthrough();
export type WahaWebhookEvent = z.infer<typeof webhookSchema>;
type StoredWebhook = { workspaceId: string; wahaSession: string; externalEventId: string; eventType: WahaWebhookEvent['event']; occurredAt: string; payload: Record<string, unknown>; receivedAt: string };
type StoredMessage = StoredWebhook & { externalMessageId: string; chatId: string; direction: 'inbound' | 'outbound'; messageType: string; body: string | null };
export interface WahaWebhookStore { ingest(event: StoredWebhook): Promise<{ duplicate: boolean }>; }
export function parseWebhook(value: unknown): WahaWebhookEvent { return webhookSchema.parse(value); }

export function verifyWahaWebhook(rawBody: Buffer, headers: { hmac?: string; algorithm?: string; timestamp?: string }, key?: string): void {
  if (!key) throw new WahaWebhookValidationError(503, 'WAHA webhook authentication is not configured');
  if (headers.algorithm?.toLowerCase() !== 'sha512' || !headers.hmac || !/^[a-f0-9]{128}$/i.test(headers.hmac)) throw new WahaWebhookValidationError(401, 'WAHA webhook signature is invalid');
  const expected = createHmac('sha512', key).update(rawBody).digest(); const provided = Buffer.from(headers.hmac, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new WahaWebhookValidationError(401, 'WAHA webhook signature is invalid');
  const sentAt = Number(headers.timestamp);
  if (!Number.isInteger(sentAt) || Math.abs(Date.now() - sentAt) > 10 * 60_000) throw new WahaWebhookValidationError(401, 'WAHA webhook timestamp is invalid');
}
export class WahaWebhookValidationError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = 'WahaWebhookValidationError'; } }

export class SqliteWahaWebhookStore implements WahaWebhookStore {
  constructor(private readonly database: SqliteDatabase) {}
  async ingest(event: StoredWebhook): Promise<{ duplicate: boolean }> {
    const payloadJson = JSON.stringify(sanitize(event.payload));
    try {
      this.database.transaction(() => {
        this.database.prepare('INSERT INTO waha_webhook_events (workspaceId, wahaSession, externalEventId, eventType, occurredAt, payloadJson, receivedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(event.workspaceId, event.wahaSession, event.externalEventId, event.eventType, event.occurredAt, payloadJson, event.receivedAt);
        const message = messageFrom(event); if (message) this.database.prepare('INSERT OR IGNORE INTO whatsapp_messages (workspaceId, wahaSession, externalMessageId, externalEventId, chatId, direction, messageType, body, occurredAt, payloadJson, receivedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(message.workspaceId, message.wahaSession, message.externalMessageId, message.externalEventId, message.chatId, message.direction, message.messageType, message.body, message.occurredAt, JSON.stringify(sanitize(message.payload)), message.receivedAt);
      })();
      return { duplicate: false };
    } catch (error) { if (isUniqueError(error)) return { duplicate: true }; throw error; }
  }
}
export class SupabaseWahaWebhookStore implements WahaWebhookStore {
  constructor(private readonly client: SupabaseClient) {}
  async ingest(event: StoredWebhook): Promise<{ duplicate: boolean }> {
    const { error } = await this.client.from('waha_webhook_events').insert({ workspace_id: event.workspaceId, waha_session: event.wahaSession, external_event_id: event.externalEventId, event_type: event.eventType, occurred_at: event.occurredAt, payload_json: sanitize(event.payload), received_at: event.receivedAt });
    if (error) { if (error.code === '23505') return { duplicate: true }; throw error; }
    const message = messageFrom(event); if (!message) return { duplicate: false };
    const { error: messageError } = await this.client.from('whatsapp_messages').insert({ workspace_id: message.workspaceId, waha_session: message.wahaSession, external_message_id: message.externalMessageId, external_event_id: message.externalEventId, chat_id: message.chatId, direction: message.direction, message_type: message.messageType, body: message.body, occurred_at: message.occurredAt, payload_json: sanitize(message.payload), received_at: message.receivedAt });
    if (messageError && messageError.code !== '23505') throw messageError; return { duplicate: false };
  }
}
export function webhookRecord(event: WahaWebhookEvent, workspaceId: string): StoredWebhook { return { workspaceId, wahaSession: event.session, externalEventId: event.id, eventType: event.event, occurredAt: new Date(event.timestamp).toISOString(), payload: event.payload, receivedAt: new Date().toISOString() }; }
function messageFrom(event: StoredWebhook): StoredMessage | undefined { if (event.eventType !== 'message' && event.eventType !== 'message.any') return undefined; const value = event.payload; const id = text(value.id) ?? text(nested(value, 'key', 'id')); const chatId = text(value.chatId) ?? text(value.from) ?? text(nested(value, 'key', 'remoteJid')); if (!id || !chatId) return undefined; return { ...event, externalMessageId: id, chatId, direction: value.fromMe === true ? 'outbound' : 'inbound', messageType: text(value.type) ?? 'text', body: text(value.body) ?? text(value.text) ?? null }; }
function nested(value: Record<string, unknown>, key: string, child: string): unknown { const parent = value[key]; return parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[child] : undefined; }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value.slice(0, 20_000) : undefined; }
function isUniqueError(error: unknown): boolean { return error instanceof Error && /unique|constraint/i.test(error.message); }
function sanitize(value: unknown, depth = 0): unknown { if (depth > 12) return '[TRUNCATED]'; if (typeof value === 'string') return value.length > 20_000 ? `${value.slice(0, 20_000)}[TRUNCATED]` : value; if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1)); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : sanitize(item, depth + 1)])); }
