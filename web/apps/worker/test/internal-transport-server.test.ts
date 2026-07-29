import { afterEach, describe, expect, it } from 'vitest';
import { createInternalTransportServer, createWorkerTransportHandler, listenInternalTransport } from '../src/internal-transport-server.js';
import { WahaHttpClient } from '../src/waha-client.js';
import { WahaProvider } from '../src/waha-provider.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
async function start(handler?: Parameters<typeof createInternalTransportServer>[0]) { const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, handler); closers.push(runtime.close); const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('missing address'); return `http://127.0.0.1:${address.port}/internal/transport`; }
async function send(url: string, body: unknown) { return (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }
const request = { correlationId: 'corr-a', workspaceId: 'workspace-a', timeoutMs: 100, command: { type: 'transport.ping', payload: { message: 'hello' } } };
describe('internal worker transport server', () => {
  it('returns the controlled response without starting WhatsApp', async () => { const body = await send(await start(), request); expect(body).toMatchObject({ success: true, correlationId: 'corr-a', workspaceId: 'workspace-a', data: { message: 'hello' } }); });
  it('returns worker errors as typed responses', async () => { const body = await send(await start(), { ...request, command: { type: 'transport.ping', payload: { message: 'hello', fail: true } } }); expect(body).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } }); });
  it('sends only one response when a handler finishes after the request is closed', async () => { const url = await start(async input => ({ success: true, correlationId: input.correlationId, workspaceId: input.workspaceId, data: { message: 'once' } })); const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }); expect(await response.text()).toContain('once'); });
  /** The operator's intent is worthless if it stops at the transport. These pin
   *  that `voiceNote` survives the hop into the worker command, and — the half
   *  that actually breaks silently — that its ABSENCE stays an absence rather
   *  than becoming `false`, which would turn every recorded note into a file. */
  const attachmentCommand = (payload: Record<string, unknown>) => ({ correlationId: 'corr-a', workspaceId: 'workspace-a', timeoutMs: 500, command: { type: 'message.sendAttachment', payload: { wahaSession: 'waha-a', chatId: '5511999999999@c.us', type: 'audio', url: 'https://storage.test/signed', filename: 'musica.mp3', mimeType: 'audio/mpeg', ...payload } } });
  const captureAttachment = () => { const seen: Record<string, unknown>[] = []; return { seen, worker: { execute: async (_context: unknown, command: { attachment: Record<string, unknown> }) => { seen.push(command.attachment); return { id: 'waha-audio-a', timestamp: new Date().toISOString() }; } } }; };

  it('carries the music-file intent into the worker command', async () => {
    const { seen, worker } = captureAttachment();
    await send(await start(createWorkerTransportHandler(worker as never)), attachmentCommand({ voiceNote: false }));
    expect(seen[0]).toMatchObject({ type: 'audio', voiceNote: false });
  });

  it('leaves the intent absent when the caller states none', async () => {
    const { seen, worker } = captureAttachment();
    await send(await start(createWorkerTransportHandler(worker as never)), attachmentCommand({}));
    expect(seen[0]).not.toHaveProperty('voiceNote');
  });

  it('rejects an intent that is not a boolean instead of coercing it', async () => {
    const { seen, worker } = captureAttachment();
    const body = await send(await start(createWorkerTransportHandler(worker as never)), attachmentCommand({ voiceNote: 'false' }));
    expect(body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    expect(seen).toHaveLength(0);
  });

  it('closes gracefully and stops accepting commands', async () => { const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }); const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('missing address'); await runtime.close(); await expect(fetch(`http://127.0.0.1:${address.port}/internal/transport`)).rejects.toThrow(); });

  it('keeps an operation that needs several provider calls inside the announced budget, and names the budget as the cause', async () => {
    const waha = slowWaha(600);
    const url = await start(createWorkerTransportHandler(historyWorker(waha.fetchImpl)));
    const started = Date.now();
    const body = await send(url, { ...request, timeoutMs: 1_000, command: historyPage });
    const elapsed = Date.now() - started;
    // Two 600 ms provider calls do not fit in 1 000 ms. Sharing the budget makes
    // the second one end early with the real cause instead of letting the whole
    // command outlive the caller, which then reports only its own abort.
    expect(body).toMatchObject({ success: false, error: { code: 'TIMEOUT', message: 'command budget ran out before WAHA answered' } });
    expect(waha.calls).toHaveLength(2);
    expect(elapsed).toBeLessThan(1_200);
  });

  it('leaves an operation that fits the budget untouched', async () => {
    const waha = slowWaha(20);
    const url = await start(createWorkerTransportHandler(historyWorker(waha.fetchImpl)));
    const body = await send(url, { ...request, timeoutMs: 1_000, command: historyPage });
    expect(body).toMatchObject({ success: true, data: { historyPage: { kind: 'messages', items: [{ id: 'message-a' }] } } });
    expect(waha.calls).toHaveLength(2);
  });

  it('rejects a content payload the contract does not accept, before the worker sees it', async () => {
    const executed: unknown[] = [];
    const url = await start(createWorkerTransportHandler({ execute: async (_context: unknown, command: unknown) => { executed.push(command); return { timestamp: 'x' }; } } as never));
    const content = (value: unknown) => ({ ...request, command: { type: 'message.sendContent', payload: { wahaSession: 'session-a', chatId: '1@c.us', content: value } } });
    // A field that travels but is never validated is how `timeoutMs` used to be
    // accepted and dropped. Every one of these must die at the door.
    for (const invalid of [
      { kind: 'location', latitude: 91, longitude: 0 },
      { kind: 'location', latitude: 0, longitude: 181 },
      { kind: 'location', latitude: '10', longitude: '20' },
      { kind: 'location', longitude: 0 },
      { kind: 'poll', name: 'Q', options: ['only-one'], multipleAnswers: false },
      { kind: 'vcard', contacts: [] },
      { kind: 'sticker', url: 'https://example.test/a.webp' },
    ]) {
      expect(await send(url, content(invalid))).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(executed).toEqual([]);
  });

  it('hands every declared content kind to the worker with its fields intact', async () => {
    const executed: any[] = [];
    const url = await start(createWorkerTransportHandler({ execute: async (_context: unknown, command: unknown) => { executed.push(command); return { id: 'sent-a', timestamp: '2026-07-28T00:00:00.000Z' }; } } as never));
    const kinds = [
      { kind: 'location', latitude: -7.115, longitude: -34.861, title: 'Escritório' },
      { kind: 'vcard', contacts: [{ fullName: 'Ada Lovelace', phoneNumber: '+55 85 92369359' }] },
      { kind: 'poll', name: 'Qual horário?', options: ['Manhã', 'Tarde'], multipleAnswers: true },
    ];
    for (const content of kinds) {
      const body = await send(url, { ...request, command: { type: 'message.sendContent', payload: { wahaSession: 'session-a', chatId: '1@c.us', content } } });
      expect(body).toMatchObject({ success: true, data: { sentMessage: { id: 'sent-a' } } });
    }
    expect(executed.map(command => command.content)).toEqual(kinds);
    expect(executed.every(command => command.type === 'sendContent' && command.chatId === '1@c.us')).toBe(true);
  });

  it('does not charge background provisioning to the budget of the command that started it', async () => {
    // Session creation is answered immediately and provisions WAHA afterwards.
    // That work outlives the command, so the command's budget must not end it.
    const waha = slowWaha(150);
    const client = new WahaHttpClient({ baseUrl: 'http://waha.test', timeoutMs: 30_000, fetchImpl: waha.fetchImpl });
    const provider = new WahaProvider(client, 60_000);
    const url = await start(createWorkerTransportHandler(provider));
    const body = await send(url, { ...request, timeoutMs: 60, command: { type: 'session.create', payload: { sessionId: 'session-a', name: 'Primary' } } });
    expect(body).toMatchObject({ success: true, data: { session: { id: 'session-a' } } });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(waha.calls).toEqual(['http://waha.test/api/sessions']);
    expect(waha.aborted).toEqual([]);
  });
});

const wahaName = 'chatpro-b60c5708e0c4a09d91258bd25a5a81a0c48104a9';
const historyPage = { type: 'history.page', payload: { wahaSession: wahaName, chatId: '120363363444637332@g.us', offset: 0, limit: 100 } };

/** A session already linked, so the command spends its budget only on the two calls it makes. */
function historyWorker(fetchImpl: typeof fetch) {
  // Far longer than any budget below: a per-call timeout must never be what
  // bounds the command.
  const client = new WahaHttpClient({ baseUrl: 'http://waha.test', timeoutMs: 30_000, fetchImpl });
  return new WahaProvider(client, 60_000, { load: async () => [{ workspaceId: 'workspace-a', sessionId: 'session-a', name: 'Primary', wahaName }], save: async () => undefined });
}

function slowWaha(delayMs: number) {
  const calls: string[] = [];
  const aborted: string[] = [];
  const fetchImpl = ((input: string, init?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    calls.push(input);
    const payload = input.includes('/messages') ? [{ id: 'message-a', timestamp: 1 }] : { name: wahaName, status: 'WORKING' };
    const timer = setTimeout(() => resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })), delayMs);
    init?.signal?.addEventListener('abort', () => { aborted.push(input); clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); });
  })) as unknown as typeof fetch;
  return { calls, aborted, fetchImpl };
}
