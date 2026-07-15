import { createServer, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { InternalWorkerClient } from '../src/internal-worker-client.js';

const servers: ReturnType<typeof createServer>[] = [];
async function serve(handler: RequestListener) { const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address'); return `http://127.0.0.1:${address.port}/internal/transport`; }
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
describe('InternalWorkerClient', () => {
  it('propagates correlationId and keeps workspace isolated', async () => {
    const url = await serve((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { const input = JSON.parse(body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, correlationId: input.correlationId, workspaceId: input.workspaceId, data: { message: input.command.payload.message } })); }); });
    const result = await new InternalWorkerClient({ url, timeoutMs: 100 }).send({ correlationId: 'corr-a', workspaceId: 'workspace-a', command: { type: 'transport.ping', payload: { message: 'ok' } } });
    expect(result).toMatchObject({ success: true, correlationId: 'corr-a', workspaceId: 'workspace-a' });
  });
  it('returns a typed timeout', async () => { const url = await serve((_req, _res) => undefined); const result = await new InternalWorkerClient({ url, timeoutMs: 10 }).send({ correlationId: 'corr-a', workspaceId: 'workspace-a', command: { type: 'transport.ping', payload: { message: 'ok' } } }); expect(result).toMatchObject({ success: false, error: { code: 'TIMEOUT' } }); });
  it('returns unavailable when no worker is listening', async () => { const result = await new InternalWorkerClient({ url: 'http://127.0.0.1:1/internal/transport', timeoutMs: 100 }).send({ correlationId: 'corr-a', workspaceId: 'workspace-a', command: { type: 'transport.ping', payload: { message: 'ok' } } }); expect(result).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } }); });
});
