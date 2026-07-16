export type ApiErrorCode = 'API_UNAVAILABLE' | 'TIMEOUT' | 'REQUEST_FAILED';

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}

export interface ApiClientOptions { baseUrl?: string; workspaceId?: string; timeoutMs?: number; fetcher?: typeof fetch; }
const safeText = (value: unknown) => String(value ?? '').replace(/(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 240);

/** Single transport boundary for the dashboard. Components never call fetch directly. */
export class ApiClient {
  private readonly baseUrl: string; private readonly workspaceId: string; private readonly timeoutMs: number; private readonly fetcher: typeof fetch;
  constructor(options: ApiClientOptions = {}) { this.baseUrl = options.baseUrl ?? import.meta.env.VITE_API_URL ?? ''; this.workspaceId = options.workspaceId ?? import.meta.env.VITE_WORKSPACE_ID ?? 'default-workspace'; this.timeoutMs = options.timeoutMs ?? 8_000; this.fetcher = options.fetcher ?? fetch; }
  async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const startedAt = performance.now(); const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); const method = init.method ?? 'GET';
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, signal: controller.signal, headers: { 'content-type': 'application/json', 'x-workspace-id': this.workspaceId, ...init.headers } });
      if (response.status === 204) return undefined as T;
      let body: unknown;
      try { body = await response.json(); } catch (error) { throw new ApiError('REQUEST_FAILED', `Resposta inválida da API.${import.meta.env.DEV ? ` [PARSE ${response.status} ${path}]` : ''}`, { phase: 'parse', endpoint: path, method, status: response.status, errorName: error instanceof Error ? error.name : 'UnknownError', reason: safeText(error instanceof Error ? error.message : error) }); }
      if (!response.ok) { const error = body as { error?: { message?: string; details?: Record<string, unknown> } } | null; const safeMessage = error?.error?.message ?? 'Não foi possível concluir a operação.'; throw new ApiError('REQUEST_FAILED', `${safeMessage}${import.meta.env.DEV ? ` [REQUEST_FAILED ${response.status} ${path}]` : ''}`, { ...error?.error?.details, phase: 'response', endpoint: path, method, status: response.status }); }
      return body as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const name = error instanceof Error ? error.name : 'UnknownError'; const reason = safeText(error instanceof Error ? error.message : error); const elapsedMs = Math.round(performance.now() - startedAt);
      if ((error as DOMException).name === 'AbortError') { const code = signal?.aborted ? 'REQUEST_FAILED' : 'TIMEOUT'; const text = signal?.aborted ? 'Solicitação cancelada.' : 'A API demorou para responder.'; throw new ApiError(code, `${text}${import.meta.env.DEV ? ` [${code} 0 ${path}; ${name}: ${reason}]` : ''}`, { phase: signal?.aborted ? 'abort' : 'timeout', endpoint: path, method, status: 0, errorName: name, reason, elapsedMs }); }
      if (import.meta.env.DEV) console.debug('ChatPro API request failed', { phase: 'fetch', endpoint: path, method, status: 0, errorName: name, reason, elapsedMs });
      throw new ApiError('API_UNAVAILABLE', `A API está indisponível.${import.meta.env.DEV ? ` [API_UNAVAILABLE 0 ${path}; ${name}: ${reason}]` : ''}`, { phase: 'fetch', endpoint: path, method, status: 0, errorName: name, reason, elapsedMs });
    } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  get<T>(path: string, signal?: AbortSignal) { return this.request<T>(path, { method: 'GET' }, signal); }
  post<T>(path: string, body?: unknown, signal?: AbortSignal) { return this.request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, signal); }
  patch<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }); }
  put<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) }); }
  delete(path: string) { return this.request<void>(path, { method: 'DELETE' }); }
}
