import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@chatpro/contracts';
import { gowaHistoryChat, gowaHistoryMessage } from '../src/gowa-history.adapter.js';
import { GowaProvider } from '../src/gowa-provider.js';
import { gowaClientStub } from './support/gowa-client.stub.js';

const context: RequestContext = { workspaceId: 'workspace-a', correlationId: 'correlation-a', userId: 'user-a' };
const group = '120363000000000001@g.us';
const participant = '5511999990002@s.whatsapp.net';

/** Fixtures com os nomes de campo reais do GOWA (commit be8155c5,
 *  src/domains/chat/chat.go) — não inventados. */
const chatInfo = { jid: '5511999990001@s.whatsapp.net', name: 'Ana', last_message_time: '2026-08-07T12:00:00Z', ephemeral_expiration: 0, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-07T12:00:00Z', archived: false };
const messageInfo = { id: 'm1', chat_jid: '5511999990001@s.whatsapp.net', sender_jid: '5511999990001@s.whatsapp.net', sender_display_name: 'Ana', content: 'oi', timestamp: '2026-08-07T12:00:00Z', is_from_me: false, media_type: '', filename: '', url: '', file_length: 0, created_at: '', updated_at: '' };

describe('adaptador de histórico GOWA', () => {
  it('mapeia ChatInfo para o item que o pipeline consome', () => {
    expect(gowaHistoryChat(chatInfo)).toMatchObject({ id: '5511999990001@s.whatsapp.net', name: 'Ana', conversationTimestamp: '2026-08-07T12:00:00Z' });
    // `jid` é o campo real; um item sem ele não vira chat inventado.
    expect(gowaHistoryChat({ id: 'errado' })).toBeUndefined();
  });

  it('mapeia MessageInfo de conversa direta', () => {
    const item = gowaHistoryMessage(messageInfo)!;
    expect(item).toMatchObject({ id: 'm1', chatId: '5511999990001@s.whatsapp.net', fromMe: false, body: 'oi', type: 'text' });
    // Em conversa direta não existe participante.
    expect(item.participant).toBeUndefined();
  });

  it('em grupo, o autor vai como participante e NUNCA vira a conversa', () => {
    const item = gowaHistoryMessage({ ...messageInfo, chat_jid: group, sender_jid: participant })!;

    expect(item.chatId).toBe(group);
    expect(item.participant).toBe(participant);
    // A regressão que isto trava: sender_jid virando a conversa.
    expect(item.chatId).not.toBe(participant);
  });

  it('preserva mídia, fromMe, reações e metadados de chamada', () => {
    const media = gowaHistoryMessage({ ...messageInfo, media_type: 'image', url: 'https://gowa.invalid/a.jpg', filename: 'a.jpg', file_length: 2048, is_from_me: true })!;
    expect(media).toMatchObject({ type: 'image', fromMe: true, hasMedia: true });
    expect(media.media).toMatchObject({ url: 'https://gowa.invalid/a.jpg', filename: 'a.jpg', filesize: 2048 });

    expect(gowaHistoryMessage({ ...messageInfo, media_type: 'ptt', url: 'https://gowa.invalid/v.ogg' })!.type).toBe('ptt');
    expect(gowaHistoryMessage({ ...messageInfo, reactions: [{ emoji: '👍' }] })!.reactions).toHaveLength(1);
    expect(gowaHistoryMessage({ ...messageInfo, media_type: 'call_log', call_metadata: '{"kind":"missed"}' })!.callMetadata).toBe('{"kind":"missed"}');
  });

  it('descarta item sem id ou sem chat_jid, em vez de inventar conversa', () => {
    expect(gowaHistoryMessage({ ...messageInfo, id: '' })).toBeUndefined();
    expect(gowaHistoryMessage({ ...messageInfo, chat_jid: '' })).toBeUndefined();
  });
});

describe('paginação de histórico GOWA pelo provider', () => {
  async function connected(overrides = {}) {
    const client = gowaClientStub({ getSessionStatus: vi.fn().mockResolvedValue({ isConnected: true, isLoggedIn: true }), ...overrides });
    const provider = new GowaProvider(client);
    await provider.createSession(context, 'session-a', {});
    return { client, provider };
  }

  it('devolve chats já traduzidos, com offset e limit preservados', async () => {
    const { client, provider } = await connected({ listChats: vi.fn().mockResolvedValue({ items: [chatInfo], hasMore: true }) });

    const page = await provider.listChats(context, { sessionId: 'session-a' }, { offset: 25, limit: 25 });

    expect(page).toMatchObject({ kind: 'chats', hasMore: true });
    expect(page.items[0]).toMatchObject({ id: chatInfo.jid });
    // Nenhum campo cru do GOWA atravessa a fronteira.
    expect(page.items[0].jid).toBeUndefined();
    expect((client.listChats as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ offset: 25, limit: 25 });
  });

  it('devolve mensagens traduzidas e conta o que não conseguiu mapear', async () => {
    const { provider } = await connected({ listMessages: vi.fn().mockResolvedValue({ items: [messageInfo, { id: '', chat_jid: '' }], hasMore: false }) });

    const page = await provider.listMessages(context, { sessionId: 'session-a', chatId: '5511999990001@c.us' }, { offset: 0, limit: 100 });

    expect(page.items).toHaveLength(1);
    // Um buraco silencioso no histórico é pior que um buraco contado.
    expect(page.unsupported).toEqual(['gowa:unmapped:1']);
  });
});
