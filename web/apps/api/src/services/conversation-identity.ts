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
 */
const technicalMessageTypes: ReadonlySet<string> = new Set(['ack', 'receipt', 'reaction', 'status', 'protocol', 'revoked', 'e2e_notification', 'notification_template', 'gp2', 'ciphertext', 'biz_content_placeholder']);
export function isTechnicalMessageType(value: string | null | undefined): boolean { const type = value?.trim().toLowerCase(); return Boolean(type && technicalMessageTypes.has(type)); }

function isTechnicalInput(input: ConversationIdentityInput): boolean {
  if (isTechnicalMessageType(input.messageType)) return true;
  return [input.chatId, input.from, input.to, input.remoteJid].some(value => value === 'status@broadcast' || (typeof value === 'string' && (value.endsWith('@broadcast') || value.endsWith('@newsletter'))));
}

function isOwnChatId(chatId: string, ownWhatsappNumbers: readonly string[] | undefined): boolean {
  const number = chatId.split('@', 1)[0].replace(/\D/g, '');
  return Boolean(number) && (ownWhatsappNumbers ?? []).some(value => value.replace(/\D/g, '') === number);
}
import { normalizeWhatsAppIdentifier } from './whatsapp-identifier.js';
