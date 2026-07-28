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
 * message WhatsApp has not decrypted yet. `call_log` is deliberately absent:
 * a missed call is operational information, and whether it demands a reply is a
 * product decision rather than a normalization one.
 */
const technicalMessageTypes: ReadonlySet<string> = new Set(['ack', 'receipt', 'reaction', 'status', 'protocol', 'revoked', 'e2e_notification', 'notification_template', 'gp2', 'ciphertext']);
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
