import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WahaWebhookController } from '../src/controllers/waha-webhook.controller.js';
import { wahaMessageType } from '../src/services/conversation-identity.js';
import { WhatsAppMediaPersistenceService, SupabaseWhatsAppMediaStorage, type WhatsAppMediaPersistenceStore } from '../src/services/whatsapp-media-persistence.service.js';

/**
 * O tipo real de uma mensagem WAHA/WEBJS não está na raiz do payload: está em
 * `_data.type`. O controller lia só a raiz, então `messageType` chegava nulo em
 * todo o tráfego real e `normalizedMime` nunca tinha como decidir nada.
 *
 * A forma dos payloads abaixo foi tirada do tráfego real (chaves da raiz, onde o
 * tipo mora, formato de `media`); o conteúdo é sintético.
 */
const wahaPayload = (type: string, mimetype: string, overrides: Record<string, unknown> = {}) => ({
  id: `msg-${type}`,
  timestamp: 1_770_000_000,
  from: '5511999990000@c.us',
  to: '5511888880000@c.us',
  fromMe: false,
  source: 'app',
  hasMedia: true,
  body: '',
  ack: 1,
  ackName: 'DEVICE',
  vCards: [],
  media: { url: 'http://waha.test/api/files/media.bin', mimetype, filename: `arquivo.${type}` },
  _data: { type, mimetype },
  ...overrides,
});

/** `outboundRecord` monta um payload sintético com `type` na RAIZ e sem `_data`:
 *  é o envio pelo Inbox, e a raiz precisa continuar sendo lida primeiro. */
const inboxPayload = (type: string) => ({
  id: `out-${type}`,
  timestamp: 1_770_000_000,
  fromMe: true,
  type,
  media: { url: 'http://waha.test/api/files/media.bin', mimetype: 'application/octet-stream', filename: 'anexo' },
});

const HMAC_KEY = 'chave-de-teste';

/** Entrega o evento pelo caminho real do controller, assinado como o WAHA assina. */
const receive = async (persist: ReturnType<typeof vi.fn>, payload: Record<string, unknown>) => {
  const store = { ingest: vi.fn().mockResolvedValue({ duplicate: false, messageInserted: true }) };
  const realtime = { publish: vi.fn() };
  const controller = new WahaWebhookController(store as never, realtime as never, { hmacKey: HMAC_KEY, workspaceId: 'workspace-a' }, undefined, undefined, { persist } as never);
  const body = { id: 'evt-1', event: 'message', session: 'default', timestamp: 1_770_000_000, payload };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Date.now());
  const headers: Record<string, string> = { 'x-webhook-hmac': createHmac('sha512', HMAC_KEY).update(rawBody).digest('hex'), 'x-webhook-hmac-algorithm': 'sha512', 'x-webhook-timestamp': timestamp };
  const req = { body, rawBody, header: (name: string) => headers[name.toLowerCase()] } as never;
  const failure = vi.fn();
  const res = { status: () => ({ json: () => undefined }) } as never;
  await controller.receive(req, res, failure as never);
  expect(failure, 'o controller rejeitou o evento antes de chegar na mídia').not.toHaveBeenCalled();
};

describe('content-type da mídia que chega pelo webhook', () => {
  // Estes são os tipos que o tráfego real produz hoje, com a contagem medida na
  // base viva: image 726, ptt 111, video 71, sticker 35, document 11, audio 2.
  it.each([
    ['image', 'image/jpeg'],
    ['ptt', 'audio/ogg; codecs=opus'],
    ['video', 'video/mp4'],
    ['document', 'application/pdf'],
    ['sticker', 'image/webp'],
    ['audio', 'audio/ogg; codecs=opus'],
  ])('repassa o tipo %s para a persistência de mídia', async (type, mimetype) => {
    const persist = vi.fn().mockResolvedValue(true);
    await receive(persist, wahaPayload(type, mimetype));
    expect(persist).toHaveBeenCalledTimes(1);
    // Sem a correção isto vinha null para todos, porque a raiz não tem `type`.
    expect(persist.mock.calls[0][0]).toMatchObject({ externalMessageId: `msg-${type}`, messageType: type });
  });

  it('lê a raiz primeiro, para o envio pelo Inbox que não tem _data', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    await receive(persist, inboxPayload('image'));
    expect(persist.mock.calls[0][0]).toMatchObject({ externalMessageId: 'out-image', messageType: 'image' });
  });

  it('não inventa tipo quando o payload não traz nenhum', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const { _data, ...semTipo } = wahaPayload('image', 'image/jpeg');
    await receive(persist, semTipo);
    expect(persist.mock.calls[0][0]).toMatchObject({ messageType: null });
  });

  it('resolve o tipo pela mesma regra em qualquer formato de payload', () => {
    expect(wahaMessageType({ _data: { type: 'ptt' } })).toBe('ptt');
    expect(wahaMessageType({ type: 'image' })).toBe('image');
    // A raiz vence: é o envio pelo Inbox, que nunca tem `_data`.
    expect(wahaMessageType({ type: 'image', _data: { type: 'video' } })).toBe('image');
    // Raiz vazia não vale como resposta: cai para `_data`.
    expect(wahaMessageType({ type: '', _data: { type: 'video' } })).toBe('video');
    expect(wahaMessageType({})).toBeUndefined();
    expect(wahaMessageType(null)).toBeUndefined();
    expect(wahaMessageType({ _data: 'não é objeto' })).toBeUndefined();
  });
});

const mediaStore = (): WhatsAppMediaPersistenceStore & { saved: Array<Record<string, unknown>> } => {
  const saved: Array<Record<string, unknown>> = [];
  return { saved, persistMedia: async input => { saved.push(input); }, pendingMedia: async () => [], storedMediaWithGenericMime: async () => [], updateMediaMime: async () => undefined, markMediaUnavailable: async () => undefined };
};
const storageWith = (upload: ReturnType<typeof vi.fn>) => new SupabaseWhatsAppMediaStorage({ storage: { from: () => ({ upload, createSignedUrl: vi.fn() }) } } as never);

describe('normalização do content-type genérico', () => {
  // Só dispara quando o WAHA devolve um content-type genérico; com o tipo real em
  // mãos, o Storage passa a receber algo que o navegador sabe tocar.
  it.each([
    ['video', 'application/octet-stream', 'video/mp4'],
    ['ptv', 'application/mp4', 'video/mp4'],
    ['ptt', 'application/octet-stream', 'audio/mp4'],
    ['audio', 'application/mp4', 'audio/mp4'],
    ['sticker', 'application/octet-stream', 'image/webp'],
  ])('grava %s com content-type %s como %s', async (messageType, upstream, expected) => {
    const store = mediaStore(); const upload = vi.fn().mockResolvedValue({ error: null });
    const service = new WhatsAppMediaPersistenceService(store, storageWith(upload), { baseUrl: 'http://waha.test', apiKey: 'key', fetchImpl: vi.fn().mockResolvedValue(new Response('bytes', { headers: { 'content-type': upstream } })) });
    await service.persist({ workspaceId: 'workspace-a', externalMessageId: messageType, url: 'http://waha.test/api/files/media.bin', mimeType: upstream, filename: 'arquivo', messageType });
    expect(upload).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), expect.objectContaining({ contentType: expected }));
    expect(store.saved[0]).toMatchObject({ mimeType: expected });
  });

  it('não mexe num content-type que já é específico', async () => {
    const store = mediaStore(); const upload = vi.fn().mockResolvedValue({ error: null });
    const service = new WhatsAppMediaPersistenceService(store, storageWith(upload), { baseUrl: 'http://waha.test', apiKey: 'key', fetchImpl: vi.fn().mockResolvedValue(new Response('bytes', { headers: { 'content-type': 'audio/ogg' } })) });
    await service.persist({ workspaceId: 'workspace-a', externalMessageId: 'ptt', url: 'http://waha.test/api/files/media.bin', mimeType: 'audio/ogg', filename: 'audio.ogg', messageType: 'ptt' });
    expect(store.saved[0]).toMatchObject({ mimeType: 'audio/ogg' });
  });

  it('sem o tipo real, um content-type genérico fica genérico', async () => {
    // É o estado anterior à correção: o controller mandava messageType null.
    const store = mediaStore(); const upload = vi.fn().mockResolvedValue({ error: null });
    const service = new WhatsAppMediaPersistenceService(store, storageWith(upload), { baseUrl: 'http://waha.test', apiKey: 'key', fetchImpl: vi.fn().mockResolvedValue(new Response('bytes', { headers: { 'content-type': 'application/octet-stream' } })) });
    await service.persist({ workspaceId: 'workspace-a', externalMessageId: 'sem-tipo', url: 'http://waha.test/api/files/media.bin', mimeType: null, filename: 'arquivo', messageType: null });
    expect(store.saved[0]).toMatchObject({ mimeType: 'application/octet-stream' });
  });

  it('importPending repassa o tipo que o store resolveu do payload', async () => {
    const store = mediaStore(); const upload = vi.fn().mockResolvedValue({ error: null });
    store.pendingMedia = async () => [{ workspaceId: 'workspace-a', externalMessageId: 'pendente', url: 'http://waha.test/api/files/media.bin', mimeType: null, filename: 'nota', messageType: 'ptt' }];
    const service = new WhatsAppMediaPersistenceService(store, storageWith(upload), { baseUrl: 'http://waha.test', apiKey: 'key', fetchImpl: vi.fn().mockResolvedValue(new Response('bytes', { headers: { 'content-type': 'application/octet-stream' } })) });
    await expect(service.importPending()).resolves.toBe(1);
    expect(store.saved[0]).toMatchObject({ mimeType: 'audio/mp4' });
  });
});
