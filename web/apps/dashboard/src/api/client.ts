export type ApiErrorCode = 'API_UNAVAILABLE' | 'TIMEOUT' | 'REQUEST_FAILED';

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}

export interface ApiClientOptions { baseUrl?: string; workspaceId?: string; userId?: string; timeoutMs?: number; fetcher?: typeof fetch; }
const safeText = (value: unknown) => String(value ?? '').replace(/(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 240);

/** Single transport boundary for the dashboard. Components never call fetch directly. */
export class ApiClient {
  private readonly baseUrl: string; private readonly workspaceId: string; private readonly userId: string; private readonly timeoutMs: number; private readonly fetcher: typeof fetch;
  constructor(options: ApiClientOptions = {}) { this.baseUrl = options.baseUrl ?? import.meta.env.VITE_API_URL ?? ''; this.workspaceId = options.workspaceId ?? import.meta.env.VITE_WORKSPACE_ID ?? 'default-workspace'; this.userId = options.userId ?? import.meta.env.VITE_USER_ID ?? '00000000-0000-4000-8000-000000000001'; this.timeoutMs = options.timeoutMs ?? 35_000; this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis); }
  async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const startedAt = performance.now(); const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); const method = init.method ?? 'GET';
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, signal: controller.signal, headers: { ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }), 'x-workspace-id': this.workspaceId, 'x-user-id': this.userId, ...init.headers } });
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
  async blob(path: string, signal?: AbortSignal): Promise<Blob> { const response = await this.fetcher(`${this.baseUrl}${path}`, { method: 'GET', signal, headers: { 'x-workspace-id': this.workspaceId, 'x-user-id': this.userId } }); if (!response.ok) throw new ApiError('REQUEST_FAILED', 'Não foi possível carregar a mídia.', { endpoint: path, status: response.status }); return response.blob(); }
  post<T>(path: string, body?: unknown, signal?: AbortSignal) { return this.request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, signal); }
  postForm<T>(path: string, body: FormData) { return this.request<T>(path, { method: 'POST', body }); }
  /** Mesma fronteira e mesmos erros do `request` — só muda o transporte e o
   *  `onProgress`. `fetch` não expõe progresso de upload; o XHR expõe. */
  postFormProgress<T>(path: string, body: FormData, onProgress?: (percent: number) => void): Promise<T> {
    const method = 'POST';
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, `${this.baseUrl}${path}`);
      xhr.timeout = this.timeoutMs;
      xhr.setRequestHeader('x-workspace-id', this.workspaceId);
      xhr.setRequestHeader('x-user-id', this.userId);
      // Sem `content-type`: o browser define o boundary do multipart.
      xhr.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100))); };
      xhr.onload = () => {
        if (xhr.status === 204) { resolve(undefined as T); return; }
        let body: unknown;
        try { body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined; } catch (error) { reject(new ApiError('REQUEST_FAILED', `Resposta inválida da API.${import.meta.env.DEV ? ` [PARSE ${xhr.status} ${path}]` : ''}`, { phase: 'parse', endpoint: path, method, status: xhr.status, errorName: error instanceof Error ? error.name : 'UnknownError', reason: safeText(error instanceof Error ? error.message : error) })); return; }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(body as T); return; }
        const error = body as { error?: { message?: string; details?: Record<string, unknown> } } | null | undefined;
        const safeMessage = error?.error?.message ?? 'Não foi possível concluir a operação.';
        reject(new ApiError('REQUEST_FAILED', `${safeMessage}${import.meta.env.DEV ? ` [REQUEST_FAILED ${xhr.status} ${path}]` : ''}`, { ...error?.error?.details, phase: 'response', endpoint: path, method, status: xhr.status }));
      };
      xhr.onerror = () => reject(new ApiError('API_UNAVAILABLE', `A API está indisponível.${import.meta.env.DEV ? ` [API_UNAVAILABLE 0 ${path}]` : ''}`, { phase: 'fetch', endpoint: path, method, status: 0 }));
      xhr.onabort = () => reject(new ApiError('REQUEST_FAILED', 'Solicitação cancelada.', { phase: 'abort', endpoint: path, method, status: 0 }));
      xhr.ontimeout = () => reject(new ApiError('TIMEOUT', `A API demorou para responder.${import.meta.env.DEV ? ` [TIMEOUT 0 ${path}]` : ''}`, { phase: 'timeout', endpoint: path, method, status: 0 }));
      xhr.send(body);
    });
  }
  patch<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }); }
  put<T>(path: string, body: unknown) { return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) }); }
  delete(path: string) { return this.request<void>(path, { method: 'DELETE' }); }
}
