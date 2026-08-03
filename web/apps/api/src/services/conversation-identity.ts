export type ConversationIdentityInput = {
  direction: 'inbound' | 'outbound';
  chatId?: string | null;
  from?: string | null;
  to?: string | null;
  remoteJid?: string | null;
  participant?: string | null;
  messageType?: string | null;
  ownWhatsappNumbers?: readonly string[];
};

export type ResolvedConversationIdentity = {
  conversationChatId: string;
  deliveryChatId: string;
  conversationType: 'direct' | 'group';
};

/** The WAHA chatId is the only authority for choosing a conversation identity.
 *
 * `participant`, `from`, `to`, and `remoteJid` describe actors or transport
 * details. They must never become an Inbox conversation, notably for group
 * messages where a participant can be an @lid alias.
 */
export function resolveConversationIdentity(input: ConversationIdentityInput): ResolvedConversationIdentity | undefined {
  if (isTechnicalInput(input)) return undefined;
  const chatId = normalizeWhatsAppIdentifier(input.chatId);
  if (isGroupChatId(chatId)) return { conversationChatId: chatId, deliveryChatId: chatId, conversationType: 'group' };
  return isDirectChatId(chatId) && !isOwnChatId(chatId, input.ownWhatsappNumbers) ? { conversationChatId: chatId, deliveryChatId: chatId, conversationType: 'direct' } : undefined;
}

export function isGroupChatId(value: unknown): value is string { return typeof value === 'string' && value.toLowerCase().endsWith('@g.us'); }
export function isDirectChatId(value: unknown): value is string { return typeof value === 'string' && (value.toLowerCase().endsWith('@c.us') || value.toLowerCase().endsWith('@lid') || value.toLowerCase().endsWith('@s.whatsapp.net')); }
export function isConversationChatId(value: unknown): value is string { return isGroupChatId(value) || isDirectChatId(value); }

/** WhatsApp reports its own housekeeping through the same channel as real
 * conversation, and those events carry no body: nobody wrote them and nobody
 * answers them. They must never open a conversation, mark it unread or start an
 * SLA clock.
 *
 * `e2e_notification` is the security-code change, `notification_template` the
 * business-account notices, `gp2` a group membership change and `ciphertext` a
 * message WhatsApp has not decrypted yet. `biz_content_placeholder` is the
 * business-account stand-in for content the account cannot deliver: measured on
 * the live base it appeared 12 times, always with empty body and no media, and
 * in all 12 it was the only non-technical message of its chat — twelve
 * conversations that exist because of it and nothing else.
 *
 * `call_log` is deliberately absent: a missed call is operational information,
 * and whether it demands a reply is a product decision rather than a
 * normalization one. `unknown` is absent for the opposite reason: it is the
 * parser's own fallback, so silencing it would also silence every real message
 * WhatsApp ships a new type for.
 *
 * Three more joined in 2026-08, each because it is a marker about content rather
 * than content itself, and each measured on the live base before being added:
 *
 * - `album` (19 rows) is the header WhatsApp emits when someone sends several
 *   photos at once. The photos arrive as their own messages and keep arriving
 *   after this change; the header carries no body, no media and no mime, so
 *   dropping it loses nothing and removes an empty bubble that always sat right
 *   before a batch of real photos.
 * - `pinned_message` (1 row) announces that somebody pinned a message in a
 *   group. Measured: no useful field anywhere, neither at the root nor in
 *   `_data`. It is the same family as `gp2`, which was already here.
 * - `group-history` (1 row, `subtype: message_history_bundle`) is a bundle of
 *   group history — a transport artefact, not anyone's message. It was reaching
 *   the Inbox classified as `document` because `hasMedia` is true while no mime
 *   exists, which is the one shape `mediaType` cannot tell apart from a file.
 *
 * All three are judged on one row or nineteen, which is thin evidence, and the
 * product owner made the call knowing that. What makes it safe is the direction
 * of the error: none of the three carries text, so a wrong call here hides an
 * empty bubble rather than a message.
 */
const technicalMessageTypes: ReadonlySet<string> = new Set(['ack', 'receipt', 'reaction', 'status', 'protocol', 'revoked', 'e2e_notification', 'notification_template', 'gp2', 'ciphertext', 'biz_content_placeholder', 'album', 'pinned_message', 'group-history']);
export function isTechnicalMessageType(value: string | null | undefined): boolean { const type = value?.trim().toLowerCase(); return Boolean(type && technicalMessageTypes.has(type)); }

/** The real WhatsApp message type, from wherever the payload happens to carry it.
 *
 * WAHA/WEBJS does not put `type` at the payload root — it lives in `_data.type`.
 * Measured on the live base: the root is filled in 13 of 4 638 messages, and all
 * 13 are Inbox sends, whose synthetic payload (`outboundRecord`) carries `type`
 * at the root and no `_data` at all. So the root has to be read first, and
 * `_data.type` is the fallback that answers for every inbound.
 *
 * Reading only the root is what made `messageType` null for the whole WAHA
 * traffic; every consumer that classifies a message must come through here. */
export function wahaMessageType(payload: unknown): string | undefined {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
  const nested = record?._data && typeof record._data === 'object' ? (record._data as Record<string, unknown>).type : undefined;
  return firstNonEmpty(record?.type, nested);
}
function firstNonEmpty(...values: unknown[]): string | undefined { return values.find(value => typeof value === 'string' && value.length > 0) as string | undefined; }

function isTechnicalInput(input: ConversationIdentityInput): boolean {
  if (isTechnicalMessageType(input.messageType)) return true;
  return [input.chatId, input.from, input.to, input.remoteJid].some(value => value === 'status@broadcast' || (typeof value === 'string' && (value.endsWith('@broadcast') || value.endsWith('@newsletter'))));
}

function isOwnChatId(chatId: string, ownWhatsappNumbers: readonly string[] | undefined): boolean {
  const number = chatId.split('@', 1)[0].replace(/\D/g, '');
  return Boolean(number) && (ownWhatsappNumbers ?? []).some(value => value.replace(/\D/g, '') === number);
}
import { normalizeWhatsAppIdentifier } from './whatsapp-identifier.js';
