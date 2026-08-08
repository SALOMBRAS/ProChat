import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@chatpro/contracts';
import { GowaClientError } from '../src/gowa-client.js';
import { GowaProvider } from '../src/gowa-provider.js';
import { gowaClientStub } from './support/gowa-client.stub.js';

const context: RequestContext = { workspaceId: 'workspace-a', correlationId: 'correlation-a', userId: 'user-a' };
const chatId = '5511999990001@c.us';
const media = { url: 'https://storage.invalid/signed/a.jpg', filename: 'a.jpg', mimeType: 'image/jpeg' };

/** Sessão criada e conectada, que é a pré-condição de todo envio. */
async function connected(overrides = {}) {
  const client = gowaClientStub({ getSessionStatus: vi.fn().mockResolvedValue({ isConnected: true, isLoggedIn: true }), ...overrides });
  const provider = new GowaProvider(client);
  await provider.createSession(context, 'session-a', {});
  return { client, provider };
}

describe('envio GOWA', () => {
  it('manda imagem, vídeo e documento pelo endpoint e pela URL assinada, nunca pelos bytes', async () => {
    const { client, provider } = await connected();
    const target = { sessionId: 'session-a', chatId };

    await provider.sendImage(context, target, { ...media, caption: 'legenda' });
    await provider.sendVideo(context, target, media);
    await provider.sendFile(context, target, media);

    const kinds = (client.sendMedia as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1]);
    expect(kinds).toEqual(['image', 'video', 'file']);
    const [, , , first] = (client.sendMedia as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(first).toMatchObject({ url: media.url, caption: 'legenda' });
    // O worker nunca carrega o binário: o provider recebe a URL e só.
    expect(JSON.stringify(first)).not.toContain('base64');
  });

  it('distingue nota de voz de áudio comum', async () => {
    const { client, provider } = await connected();
    const target = { sessionId: 'session-a', chatId };

    await provider.sendAudio(context, target, { ...media, voiceNote: true });
    await provider.sendAudio(context, target, { ...media, voiceNote: false });

    const calls = (client.sendMedia as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][3]).toMatchObject({ voiceNote: true });
    expect(calls[1][3]).toMatchObject({ voiceNote: false });
  });

  it('recusa localização com título em vez de descartá-lo em silêncio', async () => {
    const { client, provider } = await connected();
    const target = { sessionId: 'session-a', chatId };

    await provider.sendLocation(context, target, { latitude: -23.5, longitude: -46.6 });
    const [deviceId, phone, coordinates] = (client.sendLocation as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(coordinates).toEqual({ latitude: -23.5, longitude: -46.6 });
    // O telefone vai sem sufixo e o deviceId nunca é o chatId nem um JID.
    expect(phone).toBe('5511999990001');
    expect(deviceId).toMatch(/^chatpro-gowa-[0-9a-f]{40}$/);

    // O endpoint do GOWA não tem campo de título; perder o que o operador
    // digitou seria pior do que recusar.
    await expect(provider.sendLocation(context, target, { latitude: -23.5, longitude: -46.6, title: 'Loja' }))
      .rejects.toMatchObject({ response: { error: { code: 'NOT_IMPLEMENTED' } } });
  });

  it('manda um cartão de contato e recusa vários, para não gravar uma linha por N mensagens', async () => {
    const { client, provider } = await connected();
    const target = { sessionId: 'session-a', chatId };

    await provider.sendContact(context, target, [{ fullName: 'Ana', phoneNumber: '5511999990002' }]);
    expect(client.sendContact).toHaveBeenCalledTimes(1);
    expect((client.sendContact as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ name: 'Ana', phoneNumber: '5511999990002' });

    await expect(provider.sendContact(context, target, [{ fullName: 'Ana', phoneNumber: '1' }, { fullName: 'Bia', phoneNumber: '2' }]))
      .rejects.toMatchObject({ response: { error: { code: 'NOT_IMPLEMENTED', details: { contacts: 2 } } } });
    expect(client.sendContact).toHaveBeenCalledTimes(1);
  });

  it('reage e remove a reação com emoji vazio', async () => {
    const { client, provider } = await connected();

    await provider.execute(context, { type: 'sendReaction', wahaSession: 'session-a', chatId, messageId: 'message-a', reaction: '👍' });
    await provider.execute(context, { type: 'sendReaction', wahaSession: 'session-a', chatId, messageId: 'message-a', reaction: '' });

    const calls = (client.sendReaction as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map(call => call[3])).toEqual(['👍', '']);
    expect(calls[0][1]).toBe('message-a');
  });

  it('envia para grupo com o JID inteiro, nunca só os dígitos', async () => {
    // Comprovado no fonte do GOWA (commit be8155c5): ValidateJidWithLogin ->
    // IsOnWhatsapp pula a validação de conta para JID que não é de usuário.
    const { client, provider } = await connected();
    const group = '120363000000000001@g.us';

    await provider.sendText(context, { sessionId: 'session-a', chatId: group }, 'oi');
    await provider.sendImage(context, { sessionId: 'session-a', chatId: group }, media);

    // Os dígitos sozinhos perderiam o servidor e endereçariam o chat errado.
    expect((client.sendText as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(group);
    expect((client.sendMedia as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(group);
  });

  it('recusa chatId que não é conversa', async () => {
    const { client, provider } = await connected();

    await expect(provider.sendImage(context, { sessionId: 'session-a', chatId: 'status@broadcast' }, media))
      .rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });
    expect(client.sendMedia).not.toHaveBeenCalled();
  });

  it('recusa enviar por sessão desconectada antes de chamar o fornecedor', async () => {
    const client = gowaClientStub({ getSessionStatus: vi.fn().mockResolvedValue({ isConnected: false, isLoggedIn: false }) });
    const provider = new GowaProvider(client);
    await provider.createSession(context, 'session-a', {});

    await expect(provider.sendImage(context, { sessionId: 'session-a', chatId }, media))
      .rejects.toMatchObject({ response: { error: { code: 'CONFLICT' } } });
    expect(client.sendMedia).not.toHaveBeenCalled();
  });

  it('traduz indisponibilidade e timeout do GOWA sem vazar corpo de resposta', async () => {
    for (const [kind, code] of [['unavailable', 'SERVICE_UNAVAILABLE'], ['timeout', 'TIMEOUT'], ['contract', 'PROVIDER_CONTRACT_ERROR']] as const) {
      const { provider } = await connected({ sendMedia: vi.fn().mockRejectedValue(new GowaClientError(kind)) });
      await expect(provider.sendImage(context, { sessionId: 'session-a', chatId }, media))
        .rejects.toMatchObject({ response: { error: { code } } });
    }
  });
});

describe('histórico e contatos GOWA', () => {
  it('lista chats quando não há chatId e mensagens quando há', async () => {
    const { client, provider } = await connected({
      listChats: vi.fn().mockResolvedValue({ items: [{ jid: 'a' }], hasMore: true }),
      listMessages: vi.fn().mockResolvedValue({ items: [{ id: 'm1' }], hasMore: false }),
    });

    const chats = await provider.listChats(context, { sessionId: 'session-a' }, { offset: 0, limit: 25 });
    const messages = await provider.listMessages(context, { sessionId: 'session-a', chatId }, { offset: 100, limit: 50 });

    expect(chats).toMatchObject({ kind: 'chats', hasMore: true });
    expect(messages).toMatchObject({ kind: 'messages', hasMore: false });
    expect((client.listMessages as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ offset: 100, limit: 50 });
  });

  it('pagina contatos preservando offset e limit', async () => {
    const { client, provider } = await connected({ listContacts: vi.fn().mockResolvedValue({ items: [{ jid: 'a' }], hasMore: true }) });

    const page = await provider.getContacts(context, { sessionId: 'session-a' }, { offset: 50, limit: 25 });

    expect(page).toMatchObject({ hasMore: true, unsupported: [] });
    expect((client.listContacts as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ offset: 50, limit: 25 });
  });

  it('resolve avatar por telefone e e declara a capability de grupo', async () => {
    const { client, provider } = await connected({ getAvatar: vi.fn().mockResolvedValue('https://gowa.invalid/avatar.jpg') });

    const avatar = await provider.getAvatar(context, { sessionId: 'session-a', chatId });
    expect(avatar).toBe('https://gowa.invalid/avatar.jpg');
    expect((client.getAvatar as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('5511999990001');

    // Metadado de grupo agora é mapeado; o adaptador tem teste próprio.
    expect(provider.supports('groups')).toBe(true);
  });

  it('isola workspace: sessão de outro workspace não é alcançável', async () => {
    const { provider } = await connected();
    const outro: RequestContext = { workspaceId: 'workspace-b', correlationId: 'correlation-b', userId: 'user-b' };

    await expect(provider.listChats(outro, { sessionId: 'session-a' }, { offset: 0, limit: 25 }))
      .rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
  });
});
