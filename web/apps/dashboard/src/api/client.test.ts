import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client';
const response = (status: number, body?: unknown) => ({ status, ok: status >= 200 && status < 300, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;
describe('ApiClient', () => {
  it('preserva o contexto do fetch nativo do navegador', async () => { const original = globalThis.fetch; const browserFetch = function(this: unknown) { if (this !== globalThis) throw new TypeError('Illegal invocation'); return Promise.resolve(response(200, [{ id: 'session' }])); } as typeof fetch; globalThis.fetch = browserFetch; try { await expect(new ApiClient().get('/api/v1/sessions')).resolves.toEqual([{ id: 'session' }]); } finally { globalThis.fetch = original; } });
  it('envia o workspace e o corpo para a API real', async () => { const fetcher = vi.fn().mockResolvedValue(response(200, { ok: true })); await new ApiClient({ fetcher, workspaceId: 'workspace-test' }).post('/api/v1/domain/contacts', { displayName: 'Ana' }); expect(fetcher.mock.calls[0][1].headers['x-workspace-id']).toBe('workspace-test'); expect(fetcher.mock.calls[0][1].body).toContain('Ana'); });
  it('mantém uma resposta 200 com JSON válido', async () => { await expect(new ApiClient({ fetcher: vi.fn().mockResolvedValue(response(200, { sessions: [] })) }).get('/api/v1/sessions')).resolves.toEqual({ sessions: [] }); });
  it('classifica falha de parse sem simular indisponibilidade', async () => { const invalid = { status: 200, ok: true, json: vi.fn().mockRejectedValue(new SyntaxError('invalid JSON')) } as unknown as Response; await expect(new ApiClient({ fetcher: vi.fn().mockResolvedValue(invalid) }).get('/api/v1/sessions')).rejects.toMatchObject({ code: 'REQUEST_FAILED', details: { phase: 'parse', status: 200 } }); });
  it('normaliza indisponibilidade e timeout', async () => { await expect(new ApiClient({ fetcher: vi.fn().mockRejectedValue(new TypeError('offline')) }).get('/health')).rejects.toMatchObject({ code: 'API_UNAVAILABLE' }); vi.useFakeTimers(); const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))))); const pending = new ApiClient({ fetcher: fetcher as typeof fetch, timeoutMs: 1 }).get('/health'); const check = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' }); await vi.advanceTimersByTimeAsync(2); await check; vi.useRealTimers(); });
});

/** O progresso de upload só existe via XHR — `fetch` não expõe `upload`. O fake
 *  captura a instância para o teste dirigir os eventos na ordem em que o
 *  navegador os dispararia. */
class FakeXHR {
  static last: FakeXHR;
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  status = 0; responseText = ""; timeout = 0;
  onload?: () => void; onerror?: () => void; onabort?: () => void; ontimeout?: () => void;
  headers: Record<string, string> = {};
  open(_method: string, _url: string) { /* fronteira já coberta pelo request */ }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(_body: unknown) { FakeXHR.last = this; }
}
const withFakeXHR = (run: () => Promise<void>) => async () => { const original = globalThis.XMLHttpRequest; globalThis.XMLHttpRequest = FakeXHR as never; try { await run(); } finally { globalThis.XMLHttpRequest = original; } };

describe('ApiClient.postFormProgress', () => {
  it('relata o percentual de upload e resolve o JSON da resposta', withFakeXHR(async () => {
    const seen: number[] = [];
    const pending = new ApiClient({ baseUrl: 'http://api.test' }).postFormProgress<{ id: string }>('/upload', new FormData(), (pct) => seen.push(pct));
    const xhr = FakeXHR.last;
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 40, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    expect(seen).toEqual([40, 100]);
    xhr.status = 200; xhr.responseText = JSON.stringify({ id: 'job-a' }); xhr.onload?.();
    await expect(pending).resolves.toEqual({ id: 'job-a' });
  }));
  it('ignora eventos sem tamanho computável, que não dizem percentual nenhum', withFakeXHR(async () => {
    const seen: number[] = [];
    const pending = new ApiClient({ baseUrl: 'http://api.test' }).postFormProgress('/upload', new FormData(), (pct) => seen.push(pct));
    const xhr = FakeXHR.last;
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 10, total: 0 });
    xhr.status = 204; xhr.onload?.();
    await pending;
    expect(seen).toEqual([]);
  }));
  it('reusa a mensagem segura da API num erro de status', withFakeXHR(async () => {
    const pending = new ApiClient({ baseUrl: 'http://api.test' }).postFormProgress('/upload', new FormData());
    const xhr = FakeXHR.last;
    xhr.status = 413; xhr.responseText = JSON.stringify({ error: { message: 'Arquivo excede o limite permitido', details: { max: 50 } } }); xhr.onload?.();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_FAILED', message: expect.stringContaining('Arquivo excede o limite permitido'), details: { phase: 'response', status: 413, max: 50 } });
  }));
  it('classifica queda de rede como indisponibilidade e estouro como timeout', withFakeXHR(async () => {
    const offline = new ApiClient({ baseUrl: 'http://api.test' }).postFormProgress('/upload', new FormData());
    FakeXHR.last.onerror?.();
    await expect(offline).rejects.toMatchObject({ code: 'API_UNAVAILABLE', details: { phase: 'fetch' } });
    const slow = new ApiClient({ baseUrl: 'http://api.test' }).postFormProgress('/upload', new FormData());
    FakeXHR.last.ontimeout?.();
    await expect(slow).rejects.toMatchObject({ code: 'TIMEOUT', details: { phase: 'timeout' } });
  }));
});
