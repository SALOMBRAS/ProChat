import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client';
const response = (status: number, body?: unknown) => ({ status, ok: status >= 200 && status < 300, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;
describe('ApiClient', () => {
  it('envia o workspace e o corpo para a API real', async () => { const fetcher = vi.fn().mockResolvedValue(response(200, { ok: true })); await new ApiClient({ fetcher, workspaceId: 'workspace-test' }).post('/api/v1/domain/contacts', { displayName: 'Ana' }); expect(fetcher.mock.calls[0][1].headers['x-workspace-id']).toBe('workspace-test'); expect(fetcher.mock.calls[0][1].body).toContain('Ana'); });
  it('normaliza indisponibilidade e timeout', async () => { await expect(new ApiClient({ fetcher: vi.fn().mockRejectedValue(new TypeError('offline')) }).get('/health')).rejects.toMatchObject({ code: 'API_UNAVAILABLE' }); vi.useFakeTimers(); const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))))); const pending = new ApiClient({ fetcher: fetcher as typeof fetch, timeoutMs: 1 }).get('/health'); const check = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' }); await vi.advanceTimersByTimeAsync(2); await check; vi.useRealTimers(); });
});
