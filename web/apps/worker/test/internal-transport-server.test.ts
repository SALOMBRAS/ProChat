import { afterEach, describe, expect, it } from 'vitest';
import { createInternalTransportServer, listenInternalTransport } from '../src/internal-transport-server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
async function start(handler?: Parameters<typeof createInternalTransportServer>[0]) { const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, handler); closers.push(runtime.close); const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('missing address'); return `http://127.0.0.1:${address.port}/internal/transport`; }
async function send(url: string, body: unknown) { return (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }
const request = { correlationId: 'corr-a', workspaceId: 'workspace-a', timeoutMs: 100, command: { type: 'transport.ping', payload: { message: 'hello' } } };
describe('internal worker transport server', () => {
  it('returns the controlled response without starting WhatsApp', async () => { const body = await send(await start(), request); expect(body).toMatchObject({ success: true, correlationId: 'corr-a', workspaceId: 'workspace-a', data: { message: 'hello' } }); });
  it('returns worker errors as typed responses', async () => { const body = await send(await start(), { ...request, command: { type: 'transport.ping', payload: { message: 'hello', fail: true } } }); expect(body).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } }); });
  it('sends only one response when a handler finishes after the request is closed', async () => { const url = await start(async input => ({ success: true, correlationId: input.correlationId, workspaceId: input.workspaceId, data: { message: 'once' } })); const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }); expect(await response.text()).toContain('once'); });
  it('closes gracefully and stops accepting commands', async () => { const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }); const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('missing address'); await runtime.close(); await expect(fetch(`http://127.0.0.1:${address.port}/internal/transport`)).rejects.toThrow(); });
});
