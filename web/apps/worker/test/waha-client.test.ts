import { describe, expect, it, vi } from 'vitest';
import { WahaHttpClient } from '../src/waha-client.js';

const response = (status: number, body?: unknown) => new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (fetchImpl: typeof fetch) => new WahaHttpClient({ baseUrl: 'http://waha.test', timeoutMs: 1_000, fetchImpl });

describe('WahaHttpClient sendText', () => {
  it('accepts a 201 response with a direct id', async () => { await expect(client(vi.fn().mockResolvedValue(response(201, { id: 'abc' }))).sendText('session-a', '5511999999999@c.us', 'ignored')).resolves.toEqual({ id: 'abc', pending: false }); });
  it('accepts a 2xx response without an id and waits for the webhook confirmation', async () => { await expect(client(vi.fn().mockResolvedValue(response(201, { accepted: true }))).sendText('session-a', '5511999999999@c.us', 'ignored')).resolves.toEqual({ pending: true }); });
  it('keeps a real 500 response as a provider failure', async () => { await expect(client(vi.fn().mockResolvedValue(response(500, { error: 'failure' }))).sendText('session-a', '5511999999999@c.us', 'ignored')).rejects.toMatchObject({ kind: 'response', status: 500 }); });
  it('uses the documented URL File shape for sendFile', async () => { const fetcher = vi.fn().mockResolvedValue(response(201, { id: 'file-a' })); await expect(client(fetcher).sendFile('session-a', '5511999999999@c.us', { type: 'image', url: 'https://storage.test/signed', filename: 'photo.jpg', mimeType: 'image/jpeg', caption: 'Olá' })).resolves.toEqual({ id: 'file-a', pending: false }); expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({ session: 'session-a', chatId: '5511999999999@c.us', file: { url: 'https://storage.test/signed', mimetype: 'image/jpeg', filename: 'photo.jpg' }, caption: 'Olá' }); });
});
