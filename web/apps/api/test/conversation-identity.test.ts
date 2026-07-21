import { describe, expect, it } from 'vitest';
import { resolveConversationIdentity } from '../src/services/conversation-identity.js';

describe('resolveConversationIdentity', () => {
  it('keeps inbound group messages in the group and never selects participant', () => {
    expect(resolveConversationIdentity({ direction: 'inbound', chatId: '120363000000@g.us', from: '5511999999999@c.us', participant: '5511888888888@c.us' })).toEqual({ conversationChatId: '120363000000@g.us', deliveryChatId: '120363000000@g.us', conversationType: 'group' });
  });
  it('keeps outbound group messages in the group', () => {
    expect(resolveConversationIdentity({ direction: 'outbound', to: '120363000000@g.us', participant: '5511999999999@c.us' })?.conversationChatId).toBe('120363000000@g.us');
  });
  it('uses an outbound direct recipient and supports lid aliases', () => {
    expect(resolveConversationIdentity({ direction: 'outbound', to: '123@lid', participant: '999@c.us' })).toMatchObject({ conversationChatId: '123@lid', conversationType: 'direct' });
  });
  it('rejects technical and participant-only identities', () => {
    expect(resolveConversationIdentity({ direction: 'inbound', chatId: 'status@broadcast', participant: '5511999999999@c.us' })).toBeUndefined();
    expect(resolveConversationIdentity({ direction: 'inbound', participant: '5511999999999@c.us' })).toBeUndefined();
    expect(resolveConversationIdentity({ direction: 'inbound', from: '5511999999999@c.us', participant: '5511999999999@c.us' })).toBeUndefined();
  });
});
