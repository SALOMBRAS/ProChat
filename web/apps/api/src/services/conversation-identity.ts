export type ConversationIdentityInput = {
  direction: 'inbound' | 'outbound';
  chatId?: string | null;
  from?: string | null;
  to?: string | null;
  remoteJid?: string | null;
  participant?: string | null;
};

export type ResolvedConversationIdentity = {
  conversationChatId: string;
  deliveryChatId: string;
  conversationType: 'direct' | 'group';
};

/** The only authority for choosing a conversation identity. participant is deliberately not read. */
export function resolveConversationIdentity(input: ConversationIdentityInput): ResolvedConversationIdentity | undefined {
  const participant = input.participant ?? undefined;
  const values = [input.chatId, input.from, input.to, input.remoteJid].filter(value => value !== participant && isConversationChatId(value));
  const groupId = values.find(isGroupChatId);
  if (groupId) return { conversationChatId: groupId, deliveryChatId: groupId, conversationType: 'group' };

  const preferred = input.direction === 'outbound'
    ? [input.to, input.chatId, input.remoteJid, input.from]
    : [input.chatId, input.from, input.remoteJid, input.to];
  const directId = preferred.find(value => value !== participant && isDirectChatId(value));
  return directId ? { conversationChatId: directId, deliveryChatId: directId, conversationType: 'direct' } : undefined;
}

export function isGroupChatId(value: unknown): value is string { return typeof value === 'string' && value.endsWith('@g.us'); }
export function isDirectChatId(value: unknown): value is string { return typeof value === 'string' && (value.endsWith('@c.us') || value.endsWith('@lid')); }
export function isConversationChatId(value: unknown): value is string { return isGroupChatId(value) || isDirectChatId(value); }
