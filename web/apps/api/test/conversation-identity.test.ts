import { describe, expect, it } from 'vitest';
import { isTechnicalMessageType, resolveConversationIdentity } from '../src/services/conversation-identity.js';

describe('resolveConversationIdentity', () => {
  it('keeps inbound group messages in the group and never selects participant', () => {
    expect(resolveConversationIdentity({ direction: 'inbound', chatId: '120363000000@g.us', from: '5511999999999@c.us', participant: '5511888888888@c.us' })).toEqual({ conversationChatId: '120363000000@g.us', deliveryChatId: '120363000000@g.us', conversationType: 'group' });
  });
  it('uses chatId exclusively, including outbound messages', () => {
    expect(resolveConversationIdentity({ direction: 'outbound', chatId: '120363000000@g.us', to: '5511999999999@c.us', participant: '5511999999999@c.us' })?.conversationChatId).toBe('120363000000@g.us');
    expect(resolveConversationIdentity({ direction: 'outbound', to: '120363000000@g.us', participant: '5511999999999@c.us' })).toBeUndefined();
  });
  it('supports a direct lid only when it is the chatId', () => {
    expect(resolveConversationIdentity({ direction: 'outbound', chatId: '123@lid', participant: '999@c.us' })).toMatchObject({ conversationChatId: '123@lid', conversationType: 'direct' });
  });
  it('rejects technical and participant-only identities', () => {
    expect(resolveConversationIdentity({ direction: 'inbound', chatId: 'status@broadcast', participant: '5511999999999@c.us' })).toBeUndefined();
    expect(resolveConversationIdentity({ direction: 'inbound', participant: '5511999999999@c.us' })).toBeUndefined();
    expect(resolveConversationIdentity({ direction: 'inbound', from: '5511999999999@c.us', participant: '5511999999999@c.us' })).toBeUndefined();
  });
  it('rejects the WhatsApp system events that nobody writes and nobody answers', () => {
    for (const messageType of ['e2e_notification', 'notification_template', 'gp2', 'ciphertext', 'biz_content_placeholder', 'E2E_Notification']) expect(resolveConversationIdentity({ direction: 'inbound', chatId: '5511999999999@c.us', messageType })).toBeUndefined();
  });
  it('accepts the conversation types of both payload formats', () => {
    // `chat` is what WEBJS reports in _data.type for plain text; `text` is what
    // the Inbox's own synthetic payload carries at the root.
    for (const messageType of ['chat', 'text', 'image', 'ptt', 'call_log']) expect(resolveConversationIdentity({ direction: 'inbound', chatId: '5511999999999@c.us', messageType })).toMatchObject({ conversationChatId: '5511999999999@c.us', conversationType: 'direct' });
  });
  it('deixa passar o que o parser não soube classificar', () => {
    // `unknown` é o fallback do próprio WEBJS. Silenciá-lo silenciaria junto toda
    // mensagem real de um tipo que o WhatsApp ainda vai lançar. Medido: 11
    // mensagens, sem corpo e sem mídia — mas o risco de errar é assimétrico.
    expect(resolveConversationIdentity({ direction: 'inbound', chatId: '5511999999999@c.us', messageType: 'unknown' })).toMatchObject({ conversationChatId: '5511999999999@c.us' });
  });
});

describe('isTechnicalMessageType', () => {
  it('recognises the technical vocabulary regardless of casing and blank input', () => {
    expect(isTechnicalMessageType('reaction')).toBe(true);
    expect(isTechnicalMessageType(' E2E_NOTIFICATION ')).toBe(true);
    expect(isTechnicalMessageType('chat')).toBe(false);
    expect(isTechnicalMessageType(undefined)).toBe(false);
    expect(isTechnicalMessageType('')).toBe(false);
  });
});
