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
  /* O contrato de reação da WAHA é PUT /api/reaction com o emoji no body —
   * e a string vazia é a REMOÇÃO, não um erro. O teste trava os dois lados:
   * reagir e desfazer precisam chegar ao provider exatamente assim. */
  it('sends reactions through PUT /api/reaction, where the empty string removes', async () => {
    // Uma Response por chamada: o body é consumido na leitura e o mesmo objeto
    // servido duas vezes falha na segunda — como a fetch de verdade se comporta.
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(200, {})));
    await client(fetcher).sendReaction('session-a', 'true_5511999990000@c.us_ABC123', '👍');
    await client(fetcher).sendReaction('session-a', 'true_5511999990000@c.us_ABC123', '');
    expect(String(fetcher.mock.calls[0][0])).toBe('http://waha.test/api/reaction');
    expect(String(fetcher.mock.calls[0][1].method)).toBe('PUT');
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({ session: 'session-a', messageId: 'true_5511999990000@c.us_ABC123', reaction: '👍' });
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toEqual({ session: 'session-a', messageId: 'true_5511999990000@c.us_ABC123', reaction: '' });
  });
  /* Menções: a WAHA só notifica de verdade quando o array `mentions` viaja no
   * body do /api/sendText junto do `@dígitos` no texto. Ausente ou vazio, a
   * chave NÃO aparece — body estrito, como sempre foi. */
  it('includes mentions in the sendText body only when present', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(201, { id: 'm1' })));
    await client(fetcher).sendText('session-a', '120363@g.us', 'olá @5511999990001', ['5511999990001@c.us']);
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({ session: 'session-a', chatId: '120363@g.us', text: 'olá @5511999990001', linkPreview: true, linkPreviewHighQuality: true, mentions: ['5511999990001@c.us'] });
    await client(fetcher).sendText('session-a', '5511999999999@c.us', 'sem menção');
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toEqual({ session: 'session-a', chatId: '5511999999999@c.us', text: 'sem menção', linkPreview: true, linkPreviewHighQuality: true });
    await client(fetcher).sendText('session-a', '120363@g.us', 'vazio não viaja', []);
    expect(JSON.parse(String(fetcher.mock.calls[2][1].body))).toEqual({ session: 'session-a', chatId: '120363@g.us', text: 'vazio não viaja', linkPreview: true, linkPreviewHighQuality: true });
  });
  /* O operador pode dispensar a prévia no compositor: o texto vai puro e nem a
   *  versão de alta qualidade é pedida. Omitida, a prévia segue ligada. */
  it('sends the text without a preview when the operator dismissed it', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(201, { id: 'm2' })));
    await client(fetcher).sendText('session-a', '5511999999999@c.us', 'veja https://example.com/a', undefined, false);
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({ session: 'session-a', chatId: '5511999999999@c.us', text: 'veja https://example.com/a', linkPreview: false });
  });
  it('normalizes WAHA chat object ids before filtering supported conversations', async () => { const fetcher = vi.fn().mockResolvedValue(response(200, [{ id: { _serialized: '5511999999999@c.us' } }])); await expect(client(fetcher).listChats('session-a', 0, 10)).resolves.toMatchObject({ items: [{ id: '5511999999999@c.us' }], unsupported: [] }); });
  it('requests the address book ordered by id and reads a full page as having more', async () => { const fetcher = vi.fn().mockResolvedValue(response(200, [{ id: '1@c.us' }, { id: '2@c.us' }])); await expect(client(fetcher).listContacts('session-a', 2, 2)).resolves.toMatchObject({ items: [{ id: '1@c.us' }, { id: '2@c.us' }], unsupported: [], hasMore: true }); expect(String(fetcher.mock.calls[0][0])).toBe('http://waha.test/api/contacts/all?session=session-a&limit=2&offset=2&sortBy=id&sortOrder=asc'); });
  it('normalizes WAHA contact object ids and reports entries without an identifier', async () => { const fetcher = vi.fn().mockResolvedValue(response(200, [{ id: { _serialized: '5511999999999@c.us' }, name: 'Ada' }, { name: 'sem id' }])); await expect(client(fetcher).listContacts('session-a', 0, 10)).resolves.toMatchObject({ items: [{ id: '5511999999999@c.us', name: 'Ada' }], unsupported: ['(sem id)'], hasMore: false }); });
  /* Os endpoints de listagem materializam o store da sessão na WAHA e estouravam
   * o padrão de 10 s (1 s aqui no teste) pensado para envio — era o `TIMEOUT`
   * sistemático que derrubava o sync de histórico e o de contatos. O orçamento
   * de listagem é 25 s, ainda abaixo do envelope de transporte de 30 s. */
  it.each([
    ['listChats', (waha: WahaHttpClient) => waha.listChats('session-a', 0, 100)],
    ['listMessages', (waha: WahaHttpClient) => waha.listMessages('session-a', '1@c.us', 0, 100)],
    ['listContacts', (waha: WahaHttpClient) => waha.listContacts('session-a', 0, 100)],
  ])('%s waits up to the 25s listing budget instead of the send-tuned default', async (_name, call) => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => { (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError'))); }));
      let settled: unknown;
      const pending = call(client(hanging as unknown as typeof fetch)).catch((error: unknown) => { settled = error; });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(23_500);
      await pending;
      expect(settled).toMatchObject({ kind: 'timeout' });
    } finally { vi.useRealTimers(); }
  });
});

describe('WahaHttpClient sendText link preview', () => {
  it('pede a prévia nativa à WAHA explicitamente', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(201, { id: 'abc' }));
    await client(fetcher).sendText('session-a', '5511999999999@c.us', 'Veja https://example.com');
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({ linkPreview: true, linkPreviewHighQuality: true });
  });
  it('mapeia a prévia do _data: canonicalUrl vence e o thumbnail vira data URL', async () => {
    const body = { id: 'm1', _data: { title: 'Título', description: 'Descrição', thumbnail: 'QUJD', canonicalUrl: 'https://example.com/canonica', matchedText: 'https://example.com/outra' } };
    await expect(client(vi.fn().mockResolvedValue(response(201, body))).sendText('session-a', '5511999999999@c.us', 'Veja https://example.com/texto')).resolves.toEqual({ id: 'm1', pending: false, linkPreview: { url: 'https://example.com/canonica', title: 'Título', description: 'Descrição', imageUrl: 'data:image/jpeg;base64,QUJD' } });
  });
  it('cai no matchedText e depois na primeira URL do texto', async () => {
    const withMatched = { id: 'm2', _data: { title: 'Título', matchedText: 'https://matched.example/' } };
    await expect(client(vi.fn().mockResolvedValue(response(201, withMatched))).sendText('session-a', '5511999999999@c.us', 'Veja https://texto.example/')).resolves.toMatchObject({ linkPreview: { url: 'https://matched.example/', title: 'Título' } });
    const withoutUrl = { id: 'm3', _data: { title: 'Título' } };
    await expect(client(vi.fn().mockResolvedValue(response(201, withoutUrl))).sendText('session-a', '5511999999999@c.us', 'Veja https://texto.example/ agora')).resolves.toMatchObject({ linkPreview: { url: 'https://texto.example/', title: 'Título' } });
  });
  it('não devolve prévia quando o _data não traz nenhuma', async () => {
    await expect(client(vi.fn().mockResolvedValue(response(201, { id: 'm4', _data: {} }))).sendText('session-a', '5511999999999@c.us', 'Veja https://example.com')).resolves.toEqual({ id: 'm4', pending: false });
  });
});
