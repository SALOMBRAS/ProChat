import { isConversationChatId, isGroupChatId } from './conversation-identity.js';
import { normalizeWhatsAppIdentifier } from './whatsapp-identifier.js';
import { phoneFromIdentifier } from './contact-identity-resolver.service.js';

/**
 * The single place that reads a raw GOWA payload.
 *
 * Nothing downstream — controller, store, Inbox, SLA — may touch
 * `payload.chat_id`, `payload.from`, `payload.from_lid`, `payload.body` or
 * `payload.type` directly. This is the same discipline CLAUDE.md rule 7 imposes
 * on WAHA `_data`, applied before GOWA has a chance to repeat the history: four
 * incidents in seven days came from four files each re-reading the payload its
 * own way.
 *
 * Two invariants hold for every event here:
 *
 *   chat_id decides the conversation. `from` is only ever the author.
 *   A @lid is an opaque id — its digits are never a phone number.
 */

export type CanonicalAuthor = {
  /** Canonical @c.us / @g.us / @lid identifier of whoever produced the event. */
  whatsappId: string;
  /** Companion @lid when GOWA reports both. Alias evidence, never a phone. */
  lid: string | null;
  /** Only ever derived from a real phone JID, never from @lid digits. */
  phone: string | null;
  displayName: string | null;
  pushName: string | null;
};

export type CanonicalMediaKind = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
export type CanonicalMedia = {
  kind: CanonicalMediaKind;
  /** Remote URL when GOWA published one. `null` means the media has to be
   * fetched through GET /message/:id/download — never through file_path. */
  url: string | null;
  mimeType: string | null;
  filename: string | null;
  caption: string | null;
  size: number | null;
};

export type CanonicalConversation = {
  chatId: string;
  type: 'direct' | 'group';
};

export type CanonicalWhatsAppEvent =
  | { kind: 'message'; conversation: CanonicalConversation; author: CanonicalAuthor; messageId: string; fromMe: boolean; occurredAt: string; body: string | null; media: CanonicalMedia | null; location: { latitude: number; longitude: number; title: string | null } | null; contacts: Array<{ fullName: string | null; phoneNumber: string | null; vcard: string | null }> | null; quotedMessageId: string | null }
  | { kind: 'reaction'; conversation: CanonicalConversation; author: CanonicalAuthor; messageId: string; emoji: string; occurredAt: string }
  | { kind: 'ack'; conversation: CanonicalConversation | null; messageIds: string[]; status: 'delivered' | 'read'; occurredAt: string }
  | { kind: 'message.revoked'; conversation: CanonicalConversation; messageId: string; occurredAt: string }
  | { kind: 'message.edited'; conversation: CanonicalConversation; messageId: string; body: string | null; occurredAt: string }
  | { kind: 'call'; conversation: CanonicalConversation; author: CanonicalAuthor; callId: string | null; occurredAt: string }
  | { kind: 'session.status'; status: 'connected' | 'disconnected'; occurredAt: string }
  | { kind: 'ignored'; reason: CanonicalIgnoreReason };

export type CanonicalIgnoreReason = 'unsupported_event' | 'own_message' | 'invalid_chat' | 'empty' | 'unmappable_media';

const MEDIA_KEYS: ReadonlyArray<[string, CanonicalMediaKind]> = [
  ['image', 'image'], ['video', 'video'], ['audio', 'audio'], ['document', 'document'], ['file', 'document'], ['sticker', 'sticker'],
];

/** Entry point. Always returns a list so one raw event can fan out (an ack
 * carries many message ids) without the caller special-casing anything. */
export function normalizeGowaEvent(event: { event: string; payload: Record<string, unknown>; timestamp?: string }): CanonicalWhatsAppEvent[] {
  const occurredAt = timestamp(event.timestamp);
  switch (event.event) {
    case 'session.connected': return [{ kind: 'session.status', status: 'connected', occurredAt }];
    case 'session.disconnected': return [{ kind: 'session.status', status: 'disconnected', occurredAt }];
    case 'message': return [message(event.payload, occurredAt)];
    case 'message.reaction': return [reaction(event.payload, occurredAt)];
    case 'message.ack': return [ack(event.payload, occurredAt)];
    case 'message.revoked':
    case 'message.deleted': return [revoked(event.payload, occurredAt)];
    case 'message.edited': return [edited(event.payload, occurredAt)];
    case 'call.offer': return [call(event.payload, occurredAt)];
    default: return [{ kind: 'ignored', reason: 'unsupported_event' }];
  }
}

function message(payload: Record<string, unknown>, occurredAt: string): CanonicalWhatsAppEvent {
  if (payload.is_from_me === true) return { kind: 'ignored', reason: 'own_message' };
  const conversation = conversationOf(payload);
  const messageId = text(payload.id);
  if (!conversation || !messageId) return { kind: 'ignored', reason: 'invalid_chat' };
  const media = mediaOf(payload);
  const location = locationOf(payload);
  const contacts = contactsOf(payload);
  const body = text(payload.body, 20_000) ?? null;
  if (!media && !location && !contacts && !body) return { kind: 'ignored', reason: 'empty' };
  return {
    kind: 'message', conversation, author: authorOf(payload, conversation), messageId, fromMe: false, occurredAt,
    body, media, location, contacts, quotedMessageId: text(payload.quoted_message_id) ?? text(payload.reply_message_id) ?? null,
  };
}

function reaction(payload: Record<string, unknown>, occurredAt: string): CanonicalWhatsAppEvent {
  const conversation = conversationOf(payload);
  // GOWA points the reaction at the message it reacts to, not at its own id.
  const messageId = text(payload.reacted_message_id) ?? text(payload.message_id) ?? text(payload.id);
  if (!conversation || !messageId) return { kind: 'ignored', reason: 'invalid_chat' };
  return { kind: 'reaction', conversation, author: authorOf(payload, conversation), messageId, emoji: text(payload.emoji, 64) ?? '', occurredAt };
}

function ack(payload: Record<string, unknown>, occurredAt: string): CanonicalWhatsAppEvent {
  const receipt = text(payload.receipt_type)?.toLowerCase();
  const status = receipt === 'delivered' ? 'delivered' as const : receipt === 'read' || receipt === 'read_self' ? 'read' as const : undefined;
  const messageIds = Array.isArray(payload.ids) ? payload.ids.map(value => text(value)).filter((value): value is string => Boolean(value)) : [];
  if (!status || !messageIds.length) return { kind: 'ignored', reason: 'unsupported_event' };
  return { kind: 'ack', conversation: conversationOf(payload), messageIds, status, occurredAt };
}

function revoked(payload: Record<string, unknown>, occurredAt: string): CanonicalWhatsAppEvent {
  const conversation = conversationOf(payload);
  const messageId = text(payload.revoked_message_id) ?? text(payload.message_id) ?? text(payload.id);
  if (!conversation || !messageId) return { kind: 'ignored', reason: 'invalid_chat' };
  return { kind: 'message.revoked', conversation, messageId, occurredAt };
}

function edited(payload: Record<string, unknown>, occurredAt: string): CanonicalWhatsAppEvent {
  const conversation = conversationOf(payload);
  const messageId = text(payload.edited_message_id) ?? text(payload.message_id) ?? text(payload.id);
  if (!conversation || !messageId) return { kind: 'ignored', reason: 'invalid_chat' };
  return { kind: 'message.edited', conversation, messageId, body: text(payload.body, 20_000) ?? null, occurredAt };
}

function call(payload: Record<string, unknown>, occurredAt: string): CanonicalWhatsAppEvent {
  // A call has no chat_id: the conversation is the caller. Only a real phone
  // JID or LID may open it — a group can never place a call.
  const conversation = conversationOf(payload) ?? directFrom(payload);
  if (!conversation || conversation.type === 'group') return { kind: 'ignored', reason: 'invalid_chat' };
  return { kind: 'call', conversation, author: authorOf(payload, conversation), callId: text(payload.call_id) ?? text(payload.id) ?? null, occurredAt };
}

/** Conversation kind for observability, available even when the event itself
 * is discarded. Exported so a caller never re-reads `chat_id` to label a log. */
export function gowaConversationKind(payload: Record<string, unknown>): 'direct' | 'group' | 'unknown' {
  return conversationOf(payload)?.type ?? 'unknown';
}

/**
 * chat_id is the only authority. A group chat never becomes a direct
 * conversation, no matter what `from` says.
 */
function conversationOf(payload: Record<string, unknown>): CanonicalConversation | null {
  const chatId = normalizeWhatsAppIdentifier(text(payload.chat_id));
  if (!chatId || !isConversationChatId(chatId)) return null;
  return { chatId, type: isGroupChatId(chatId) ? 'group' : 'direct' };
}

/** Fallback used only where GOWA omits chat_id by design, as in call.offer. */
function directFrom(payload: Record<string, unknown>): CanonicalConversation | null {
  const from = normalizeWhatsAppIdentifier(text(payload.from));
  if (!from || !isConversationChatId(from) || isGroupChatId(from)) return null;
  return { chatId: from, type: 'direct' };
}

/**
 * In a group the author is the participant in `from`; in a direct chat the
 * author is the chat itself. Either way the author never decides the
 * conversation — that was the false-private-conversation bug.
 */
function authorOf(payload: Record<string, unknown>, conversation: CanonicalConversation): CanonicalAuthor {
  const from = normalizeWhatsAppIdentifier(text(payload.from));
  const whatsappId = conversation.type === 'group' ? (from ?? conversation.chatId) : (from ?? conversation.chatId);
  // The LID may arrive as the companion field or *be* the author identifier
  // itself, when GOWA only knows the contact by LID. Both are the same fact.
  const companion = normalizeWhatsAppIdentifier(text(payload.from_lid));
  const lid = companion?.endsWith('@lid') ? companion : whatsappId.endsWith('@lid') ? whatsappId : null;
  return {
    whatsappId,
    lid,
    // phoneFromIdentifier refuses @lid, which is the whole point: a LID has
    // digits and none of them are a telephone number.
    phone: phoneFromIdentifier(whatsappId) ?? null,
    displayName: safeName(payload.sender_display_name),
    pushName: safeName(payload.from_name),
  };
}

function mediaOf(payload: Record<string, unknown>): CanonicalMedia | null {
  for (const [key, kind] of MEDIA_KEYS) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    const media = typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    // A bare string here is GOWA's local file path when auto-download is on.
    // It is deliberately not read: API and GOWA need not share a filesystem,
    // and a server path must never reach ChatPro storage or a browser.
    const url = text(media.url, 2_048) ?? null;
    const voice = kind === 'audio' && (media.ptt === true || payload.ptt === true);
    return {
      kind: voice ? 'voice' : kind,
      url,
      mimeType: text(media.mime_type) ?? text(media.mimetype) ?? null,
      filename: text(media.filename ?? media.file_name, 512) ?? null,
      caption: text(media.caption, 20_000) ?? text(payload.caption, 20_000) ?? null,
      size: typeof media.file_size === 'number' && Number.isFinite(media.file_size) ? media.file_size : null,
    };
  }
  return null;
}

function locationOf(payload: Record<string, unknown>): { latitude: number; longitude: number; title: string | null } | null {
  const value = payload.location;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const location = value as Record<string, unknown>;
  const latitude = coordinate(location.latitude);
  const longitude = coordinate(location.longitude);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude, title: text(location.name) ?? text(location.title) ?? null };
}

function contactsOf(payload: Record<string, unknown>): Array<{ fullName: string | null; phoneNumber: string | null; vcard: string | null }> | null {
  const value = payload.contacts ?? payload.contact;
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const cards = list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map(item => ({ fullName: safeName(item.name ?? item.display_name), phoneNumber: text(item.phone ?? item.phone_number, 32) ?? null, vcard: text(item.vcard, 20_000) ?? null }));
  return cards.length ? cards : null;
}

/** GOWA types coordinates as strings on the way out; accept both on the way in. */
function coordinate(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value: string | undefined): string {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function text(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : undefined;
}

/** A name that is really an identifier, or just a phone number, is not a name.
 * Rendering either would put a JID/LID in front of the operator. */
function safeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, 240);
  if (!name || normalizeWhatsAppIdentifier(name) || !/[^\d()\s+.\-]/u.test(name)) return null;
  return name;
}
