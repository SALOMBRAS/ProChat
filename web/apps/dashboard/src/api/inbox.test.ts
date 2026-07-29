import { describe, expect, it, vi } from 'vitest';
import { InboxApi } from './inbox';

/**
 * `voiceNote` é a intenção do operador e viaja em multipart, onde tudo é string.
 * O que se fixa aqui é a fronteira: a intenção só sai no corpo quando alguém a
 * declara, e sai como "true"/"false" — que é o par que o schema da rota aceita.
 *
 * O caso que quebra em silêncio é a ausência: se um `voiceNote` ausente virasse
 * "undefined" ou "false" no corpo, toda gravação do compositor sairia como
 * arquivo em vez de nota de voz, sem nenhum erro.
 */
const stub = () => { const calls: Array<[string, FormData]> = []; const http = { postForm: vi.fn().mockImplementation((path: string, body: FormData) => { calls.push([path, body]); return Promise.resolve({ id: 'job-a', status: 'pending' }); }) }; return { calls, api: new InboxApi(http as never) }; };
const file = () => new File([new Uint8Array([0x49, 0x44, 0x33])], 'musica.mp3', { type: 'audio/mpeg' });
const requestId = '00000000-0000-4000-8000-0000000000aa';

describe('InboxApi.sendAttachment', () => {
  it('declara a intenção de arquivo de música como a string que a rota aceita', async () => {
    const { calls, api } = stub();
    await api.sendAttachment('c1', file(), requestId, undefined, false);
    expect(calls[0][1].get('voiceNote')).toBe('false');
  });

  it('declara a intenção de nota de voz do mesmo jeito', async () => {
    const { calls, api } = stub();
    await api.sendAttachment('c1', file(), requestId, undefined, true);
    expect(calls[0][1].get('voiceNote')).toBe('true');
  });

  it('não inventa intenção nenhuma quando o chamador não declara uma', async () => {
    const { calls, api } = stub();
    await api.sendAttachment('c1', file(), requestId);
    expect(calls[0][1].has('voiceNote')).toBe(false);
  });

  it('continua enviando arquivo, clientRequestId e legenda como antes', async () => {
    const { calls, api } = stub();
    await api.sendAttachment('c1', file(), requestId, '  Ouça isto  ', false);
    const body = calls[0][1];
    expect(body.get('clientRequestId')).toBe(requestId);
    expect(body.get('caption')).toBe('Ouça isto');
    expect((body.get('file') as File).name).toBe('musica.mp3');
  });
});
