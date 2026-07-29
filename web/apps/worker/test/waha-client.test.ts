import { describe, expect, it, vi } from 'vitest';
import { WahaHttpClient } from '../src/waha-client.js';

const response = (status: number, body?: unknown) => new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (fetchImpl: typeof fetch) => new WahaHttpClient({ baseUrl: 'http://waha.test', timeoutMs: 1_000, fetchImpl });

describe('WahaHttpClient sendText', () => {
  it('accepts a 201 response with a direct id', async () => { await expect(client(vi.fn().mockResolvedValue(response(201, { id: 'abc' }))).sendText('session-a', '5511999999999@c.us', 'ignored')).resolves.toEqual({ id: 'abc', pending: false }); });
  it('accepts a 2xx response without an id and waits for the webhook confirmation', async () => { await expect(client(vi.fn().mockResolvedValue(response(201, { accepted: true }))).sendText('session-a', '5511999999999@c.us', 'ignored')).resolves.toEqual({ pending: true }); });
  it('keeps a real 500 response as a provider failure', async () => { await expect(client(vi.fn().mockResolvedValue(response(500, { error: 'failure' }))).sendText('session-a', '5511999999999@c.us', 'ignored')).rejects.toMatchObject({ kind: 'response', status: 500 }); });
  /** This table used to read `['audio', 'audio/mpeg', '/api/sendVoice', { convert: true }]`
   *  and that row asserted an invariant: audio ALWAYS became a voice note. That
   *  was the defect — an mp3 left as a recorded note, and the operator had no way
   *  to say otherwise, because the endpoint was a function of the mimetype alone.
   *
   *  The row survives, with `voiceNote` undefined, and now asserts a DEFAULT
   *  rather than an invariant: an attachment that states no intent still goes out
   *  as a note, which is what the composer's recorder relies on. The two rows
   *  added around it are the intent itself — the same mimetype reaching a
   *  different endpoint, which is the whole point of the change.
   *
   *  `convert` is asserted absent for the file: it transcodes to the OPUS a note
   *  requires and would defeat sending the track as it is. And `voiceNote` never
   *  appears in any expected body — it is our word, not WAHA's; the exact
   *  `toEqual` below is what keeps it from leaking to the provider. */
  it.each([
    ['image', 'image/jpeg', undefined, '/api/sendImage', {}],
    ['audio', 'audio/mpeg', undefined, '/api/sendVoice', { convert: true }],
    ['audio', 'audio/mpeg', true, '/api/sendVoice', { convert: true }],
    ['audio', 'audio/mpeg', false, '/api/sendFile', {}],
    ['audio', 'audio/ogg', false, '/api/sendFile', {}],
    ['video', 'video/mp4', undefined, '/api/sendVideo', { convert: false, asNote: false }],
    ['document', 'application/pdf', undefined, '/api/sendFile', {}],
  ] as const)('uses the WAHA endpoint for %s media (voiceNote=%s)', async (type, mimeType, voiceNote, endpoint, options) => { const fetcher = vi.fn().mockResolvedValue(response(201, { id: 'file-a' })); await expect(client(fetcher).sendAttachment('session-a', '5511999999999@c.us', { type, url: 'https://storage.test/signed', filename: 'attachment.bin', mimeType, caption: 'Olá', ...(voiceNote === undefined ? {} : { voiceNote }) })).resolves.toEqual({ id: 'file-a', pending: false }); expect(String(fetcher.mock.calls[0][0])).toBe(`http://waha.test${endpoint}`); expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({ session: 'session-a', chatId: '5511999999999@c.us', file: { url: 'https://storage.test/signed', mimetype: mimeType, filename: 'attachment.bin' }, caption: 'Olá', ...options }); });
  it('uses the WAHA-supported conversationTimestamp ordering for historical chats', async () => { const fetcher = vi.fn().mockResolvedValue(response(200, [])); await client(fetcher).listChats('session-a', 2, 10); expect(String(fetcher.mock.calls[0][0])).toContain('/api/session-a/chats?limit=10&offset=2&sortBy=conversationTimestamp&sortOrder=desc'); });
  it('normalizes WAHA chat object ids before filtering supported conversations', async () => { const fetcher = vi.fn().mockResolvedValue(response(200, [{ id: { _serialized: '5511999999999@c.us' } }])); await expect(client(fetcher).listChats('session-a', 0, 10)).resolves.toMatchObject({ items: [{ id: '5511999999999@c.us' }], unsupported: [] }); });
});
