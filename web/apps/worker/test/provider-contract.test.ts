import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@chatpro/contracts';
import { GowaProvider } from '../src/gowa-provider.js';
import type { GowaClientPort } from '../src/gowa-client.js';
import { WahaProvider } from '../src/waha-provider.js';
import type { WahaClientPort } from '../src/waha-client.js';
import { CommandBackedWhatsAppProvider } from '../src/provider-operations.js';
import { gowaClientStub } from './support/gowa-client.stub.js';
import type { WhatsAppProvider, WhatsAppProviderCapability, WorkerCommand } from '../src/ports.js';

const context = (): RequestContext => ({ workspaceId: 'workspace-a', correlationId: 'correlation-a', userId: 'user-a' });

function wahaClient(): WahaClientPort {
  return {
    health: vi.fn().mockResolvedValue(undefined), createSession: vi.fn(), getSession: vi.fn(), listSessions: vi.fn().mockResolvedValue([]),
    startSession: vi.fn(), stopSession: vi.fn(), logoutSession: vi.fn(), removeSession: vi.fn(), getQr: vi.fn(),
    sendText: vi.fn(), sendImage: vi.fn(), sendFile: vi.fn(), sendVoice: vi.fn(), sendVideo: vi.fn(), sendLocation: vi.fn(), sendContactVcard: vi.fn(),
    setReaction: vi.fn(), getContact: vi.fn(), getProfilePicture: vi.fn(), listContacts: vi.fn(), listChats: vi.fn(), listMessages: vi.fn(), listLids: vi.fn(),
  } as unknown as WahaClientPort;
}

const gowaClient = (): GowaClientPort => gowaClientStub({ listDevices: vi.fn().mockResolvedValue([]) });

/** Records the command a neutral operation produced, without a provider behind it. */
class RecordingProvider extends CommandBackedWhatsAppProvider {
  readonly provider = 'waha' as const;
  readonly commands: WorkerCommand[] = [];
  constructor(readonly capabilities: readonly WhatsAppProviderCapability[]) { super(); }
  async execute(_context: RequestContext, command: WorkerCommand) { this.commands.push(command); return undefined; }
  shutdown(): void {}
}

const every: readonly WhatsAppProviderCapability[] = ['health', 'sessions', 'status', 'sendMessage', 'sendMedia', 'sendContent', 'contacts', 'groups', 'reactions', 'history'];

describe('contrato provider-neutro', () => {
  it('carrega o provider WAHA com a interface completa', () => {
    const provider: WhatsAppProvider = new WahaProvider(wahaClient(), 60_000);

    expect(provider.provider).toBe('waha');
    // WAHA é o provider completo hoje: qualquer capability que ele perca é
    // regressão de comportamento, não escolha de design.
    for (const capability of every) expect(provider.supports(capability)).toBe(true);
    expect(provider.supports('webhookNormalization')).toBe(false);
  });

  it('carrega o provider GOWA com a interface completa e capabilities estreitas', () => {
    const provider: WhatsAppProvider = new GowaProvider(gowaClient());

    expect(provider.provider).toBe('gowa');
    for (const capability of ['health', 'sessions', 'status', 'sendMessage', 'sendMedia', 'sendContent', 'reactions', 'contacts', 'history', 'groups'] as const) expect(provider.supports(capability)).toBe(true);
    // Só a normalização de webhook segue fora: os normalizadores vivem na API.
    expect(provider.supports('webhookNormalization')).toBe(false);
  });

  it('os dois providers expõem exatamente os mesmos métodos da interface', () => {
    const waha = new WahaProvider(wahaClient(), 60_000);
    const gowa = new GowaProvider(gowaClient());
    const operations = ['listSessions', 'createSession', 'sessionStatus', 'connectSession', 'sessionQr', 'logoutSession', 'removeSession', 'sendText', 'sendImage', 'sendFile', 'sendAudio', 'sendVideo', 'sendLocation', 'sendContact', 'getContacts', 'getAvatar', 'listChats', 'listMessages', 'getGroupInfo', 'getGroupParticipants', 'normalizeWebhook'] as const;

    for (const operation of operations) {
      expect(typeof (waha as unknown as Record<string, unknown>)[operation]).toBe('function');
      expect(typeof (gowa as unknown as Record<string, unknown>)[operation]).toBe('function');
    }
  });

  it('traduz cada operação neutra para o comando que o provider já executava', async () => {
    const provider = new RecordingProvider(every);
    const target = { sessionId: 'session-a', chatId: '5511999990001@c.us' };
    const media = { url: 'https://example.invalid/a.jpg', filename: 'a.jpg', mimeType: 'image/jpeg' };

    await provider.sendText(context(), target, 'oi');
    await provider.sendImage(context(), target, media);
    await provider.sendAudio(context(), target, media);
    await provider.sendLocation(context(), target, { latitude: 1, longitude: 2 });
    await provider.listChats(context(), { sessionId: 'session-a' }, { offset: 0, limit: 10 });

    // `sessionId` neutro precisa chegar no campo legado `wahaSession`: é isso
    // que mantém o caminho da WAHA idêntico enquanto o banco não muda.
    expect(provider.commands.map(command => command.type)).toEqual(['sendMessage', 'sendAttachment', 'sendAttachment', 'sendContent', 'historyPage']);
    expect(provider.commands.every(command => (command as { wahaSession?: string }).wahaSession === 'session-a')).toBe(true);
    expect((provider.commands[1] as { attachment: { type: string } }).attachment.type).toBe('image');
    expect((provider.commands[2] as { attachment: { type: string } }).attachment.type).toBe('audio');
  });

  it('capability inexistente devolve NOT_IMPLEMENTED sem tocar o provider', async () => {
    const provider = new RecordingProvider(['sessions']);

    await expect(provider.sendText(context(), { sessionId: 'session-a', chatId: 'x@c.us' }, 'oi')).rejects.toMatchObject({
      response: { error: { code: 'NOT_IMPLEMENTED', details: { capability: 'sendMessage', operation: 'sendText' } } },
    });
    // O ponto do portão: falha antes da chamada, e não como erro do fornecedor.
    expect(provider.commands).toHaveLength(0);
  });

  it('operação sem capability declarada falha pelo portão, sem tocar o fornecedor', async () => {
    const provider = new RecordingProvider(['sessions']);

    await expect(provider.listChats(context(), { sessionId: 'session-a' }, { offset: 0, limit: 10 }))
      .rejects.toMatchObject({ response: { error: { code: 'NOT_IMPLEMENTED', details: { capability: 'history' } } } });
    expect(provider.commands).toHaveLength(0);
  });

  it('normalizeWebhook ainda não é responsabilidade do worker', async () => {
    const provider = new GowaProvider(gowaClient());

    // Os normalizadores dos dois providers vivem na API, onde o webhook chega.
    // O contrato existe; mover a implementação é mudança no ciclo webhook →
    // identidade → persistência e exige regressão própria.
    expect(() => provider.normalizeWebhook({}, 'correlation-a')).toThrow(/does not implement normalizeWebhook/);
  });
});
