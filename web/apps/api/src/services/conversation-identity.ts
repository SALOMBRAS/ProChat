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

/** The only authority for choosing a conversation identity. participant is deliberately not read. */
export function resolveConversationIdentity(input: ConversationIdentityInput): ResolvedConversationIdentity | undefined {
  if (isTechnicalInput(input)) return undefined;
  const participant = input.participant ?? undefined;
  const values = [input.chatId, input.from, input.to, input.remoteJid].filter(value => value !== participant && isConversationChatId(value));
  const groupId = values.find(isGroupChatId);
  if (groupId) return { conversationChatId: groupId, deliveryChatId: groupId, conversationType: 'group' };

  const preferred = input.direction === 'outbound'
    ? [input.to, input.chatId, input.remoteJid, input.from]
    : [input.chatId, input.from, input.remoteJid, input.to];
  const directId = preferred.find(value => value !== participant && isDirectChatId(value));
  return directId && !isOwnChatId(directId, input.ownWhatsappNumbers) ? { conversationChatId: directId, deliveryChatId: directId, conversationType: 'direct' } : undefined;
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
