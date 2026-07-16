export type ApiErrorCode = 'API_UNAVAILABLE' | 'TIMEOUT' | 'REQUEST_FAILED';

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}

export interface ApiClientOptions { baseUrl?: string; workspaceId?: string; timeoutMs?: number; fetcher?: typeof fetch; }

/** Single transport boundary for the dashboard. Components never call fetch directly. */
export class ApiClient {
  private readonly baseUrl: string; private readonly workspaceId: string; private readonly timeoutMs: number; private readonly fetcher: typeof fetch;
  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? import.meta.env.VITE_API_URL ?? '';
    this.workspaceId = options.workspaceId ?? import.meta.env.VITE_WORKSPACE_ID ?? 'default-workspace';
    this.timeoutMs = options.timeoutMs ?? 8_000; this.fetcher = options.fetcher ?? fetch;
  }
  async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, signal: controller.signal, headers: { 'content-type': 'application/json', 'x-workspace-id': this.workspaceId, ...init.headers } });
      if (response.status === 204) return undefined as T;
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) { const error = body as { error?: { message?: string; details?: Record<string, unknown> } } | null; throw new ApiError('REQUEST_FAILED', error?.error?.message ?? 'Não foi possível concluir a operação.', error?.error?.details ?? {}); }
      return body as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as DOMException).name === 'AbortError') throw new ApiError(signal?.aborted ? 'REQUEST_FAILED' : 'TIMEOUT', signal?.aborted ? 'Solicitação cancelada.' : 'A API demorou para responder.');
      throw new ApiError('API_UNAVAILABLE', 'A API está indisponível.');
    } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  get<T>(path: string, signal?: AbortSignal) { return this.request<T>(path, { method: 'GET' }, signal); }
  post<T>(path: string, body?: unknown, signal?: AbortSignal) { return this.request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, signal); }
  patch<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }); }
  put<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) }); }
  delete(path: string) { return this.request<void>(path, { method: 'DELETE' }); }
}
