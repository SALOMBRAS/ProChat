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
  const chatId = input.chatId;
  if (isGroupChatId(chatId)) return { conversationChatId: chatId, deliveryChatId: chatId, conversationType: 'group' };
  return isDirectChatId(chatId) && !isOwnChatId(chatId, input.ownWhatsappNumbers) ? { conversationChatId: chatId, deliveryChatId: chatId, conversationType: 'direct' } : undefined;
}

export function isGroupChatId(value: unknown): value is string { return typeof value === 'string' && value.endsWith('@g.us'); }
export function isDirectChatId(value: unknown): value is string { return typeof value === 'string' && (value.endsWith('@c.us') || value.endsWith('@lid')); }
export function isConversationChatId(value: unknown): value is string { return isGroupChatId(value) || isDirectChatId(value); }

function isTechnicalInput(input: ConversationIdentityInput): boolean {
  const type = input.messageType?.trim().toLowerCase();
  if (type && ['ack', 'receipt', 'reaction', 'status', 'protocol', 'revoked'].includes(type)) return true;
  return [input.chatId, input.from, input.to, input.remoteJid].some(value => value === 'status@broadcast' || (typeof value === 'string' && (value.endsWith('@broadcast') || value.endsWith('@newsletter'))));
}

function isOwnChatId(chatId: string, ownWhatsappNumbers: readonly string[] | undefined): boolean {
  const number = chatId.split('@', 1)[0].replace(/\D/g, '');
  return Boolean(number) && (ownWhatsappNumbers ?? []).some(value => value.replace(/\D/g, '') === number);
}
