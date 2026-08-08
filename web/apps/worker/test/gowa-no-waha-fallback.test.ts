import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@chatpro/contracts';
import { GowaProvider } from '../src/gowa-provider.js';
import { WahaProvider } from '../src/waha-provider.js';
import type { WahaClientPort } from '../src/waha-client.js';
import { gowaClientStub } from './support/gowa-client.stub.js';

const context: RequestContext = { workspaceId: 'workspace-a', correlationId: 'correlation-a', userId: 'user-a' };

/**
 * WahaClient armado: qualquer método usado explode. Se um caminho GOWA cair
 * escondido na WAHA, o teste falha nomeando o método — em vez de o defeito
 * aparecer em produção como uma mensagem enviada pela conta errada.
 */
function armedWahaClient(): WahaClientPort {
  const explode = (name: string) => () => { throw new Error(`WahaClient.${name} foi chamado num fluxo GOWA`); };
  const names = ['health', 'createSession', 'getSession', 'listSessions', 'startSession', 'stopSession', 'logoutSession', 'removeSession', 'getQr', 'sendText', 'sendAttachment', 'sendLocation', 'sendContactVcard', 'sendReaction', 'getIdentity', 'getGroup', 'listChats', 'listMessages', 'listContacts', 'listLidMappings'];
  return Object.fromEntries(names.map(name => [name, vi.fn().mockImplementation(explode(name))])) as unknown as WahaClientPort;
}

describe('provider=gowa nunca cai na WAHA', () => {
  it('nenhum método do WahaClient é chamado nos fluxos principais do GOWA', async () => {
    const waha = armedWahaClient();
    const gowa = gowaClientStub({ getSessionStatus: vi.fn().mockResolvedValue({ isConnected: true, isLoggedIn: true }) });
    const provider = new GowaProvider(gowa);
    const target = { sessionId: 'session-a', chatId: '5511999990001@c.us' };
    const media = { url: 'https://storage.invalid/a.jpg', filename: 'a.jpg', mimeType: 'image/jpeg' };

    await provider.createSession(context, 'session-a', {});
    await provider.listSessions(context);
    await provider.sessionStatus(context, target);
    await provider.sendText(context, target, 'oi');
    await provider.sendImage(context, target, media);
    await provider.sendAudio(context, target, media);
    await provider.sendFile(context, target, media);
    await provider.sendLocation(context, target, { latitude: 1, longitude: 2 });
    await provider.sendContact(context, target, [{ fullName: 'Ana', phoneNumber: '5511999990002' }]);
    await provider.getContacts(context, { sessionId: 'session-a' }, { offset: 0, limit: 10 });
    await provider.getAvatar(context, target);
    await provider.listChats(context, { sessionId: 'session-a' }, { offset: 0, limit: 10 });
    await provider.listMessages(context, target, { offset: 0, limit: 10 });
    // Fluxos novos: histórico, contatos, identidade e grupo.
    await provider.getGroupInfo(context, { sessionId: 'session-a', chatId: '120363000000000001@g.us' });
    await provider.getGroupParticipants(context, { sessionId: 'session-a', chatId: '120363000000000001@g.us' });
    await provider.sendText(context, { sessionId: 'session-a', chatId: '120363000000000001@g.us' }, 'no grupo');
    await provider.logoutSession(context, target);

    for (const [name, method] of Object.entries(waha as unknown as Record<string, ReturnType<typeof vi.fn>>)) {
      expect(method, `WahaClient.${name}`).not.toHaveBeenCalled();
    }
    // E o trabalho foi mesmo feito pelo GOWA, não silenciosamente pulado.
    expect(gowa.sendText).toHaveBeenCalled();
    expect(gowa.sendMedia).toHaveBeenCalledTimes(3);
    expect(gowa.listChats).toHaveBeenCalled();
  });

  it('capacidade ausente falha explicitamente, nunca degrada para outro provider', async () => {
    const provider = new GowaProvider(gowaClientStub());

    // A normalização de webhook não é responsabilidade do worker.
    expect(() => provider.normalizeWebhook({}, 'correlation-a')).toThrow(/does not implement normalizeWebhook/);
  });

  it('os dois providers são instâncias distintas e não compartilham cliente', () => {
    const gowa = new GowaProvider(gowaClientStub());
    const waha = new WahaProvider(armedWahaClient(), 60_000);

    expect(gowa.provider).toBe('gowa');
    expect(waha.provider).toBe('waha');
    expect(gowa).not.toBeInstanceOf(WahaProvider);
    // Os dois declaram `groups` agora, cada um com implementação própria.
    expect(waha.supports('groups')).toBe(true);
    expect(gowa.supports('groups')).toBe(true);
    // WAHA normaliza webhook na API; nenhum dos dois declara isso no worker.
    expect(waha.supports('webhookNormalization')).toBe(false);
    expect(gowa.supports('webhookNormalization')).toBe(false);
  });
});
