export type SessionStatus = 'disconnected' | 'connecting' | 'waiting_qr' | 'connected' | 'stopped' | 'error';
export interface Session { id: string; name: string; status: SessionStatus; createdAt?: string; updatedAt: string; }
export interface SessionQr { sessionId: string; qr: string; expiresAt: string; }
export class SessionApiError extends Error { constructor(public readonly code: 'API_UNAVAILABLE' | 'WORKER_UNAVAILABLE' | 'TIMEOUT' | 'REQUEST_FAILED', message: string) { super(message); } }

type Fetcher = typeof fetch;
const apiBase = import.meta.env.VITE_API_URL ?? '';
const workspaceId = import.meta.env.VITE_WORKSPACE_ID ?? 'demo-workspace';
const isSession = (value: unknown): value is Session => typeof value === 'object' && value !== null && typeof (value as Session).id === 'string' && typeof (value as Session).name === 'string' && typeof (value as Session).status === 'string';

export class SessionsApi {
  constructor(private readonly fetcher: Fetcher = fetch, private readonly baseUrl = apiBase, private readonly timeoutMs = 8_000) {}
  list = () => this.request<Session[]>('/api/v1/sessions', { method: 'GET' }, value => Array.isArray(value) && value.every(isSession) ? value : null);
  create = (name: string) => this.request<Session>('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ name }) }, value => isSession(value) ? value : null);
  status = (id: string) => this.request<Session>(`/api/v1/sessions/${encodeURIComponent(id)}/status`, { method: 'GET' }, value => isSession(value) ? value : null);
  qr = (id: string) => this.request<SessionQr>(`/api/v1/sessions/${encodeURIComponent(id)}/qr`, { method: 'GET' }, value => typeof value === 'object' && value !== null && typeof (value as SessionQr).qr === 'string' && typeof (value as SessionQr).expiresAt === 'string' ? value as SessionQr : null);
  connect = (id: string, forceQrRefresh = false) => this.request<void>(`/api/v1/sessions/${encodeURIComponent(id)}/connect`, { method: 'POST', body: JSON.stringify({ forceQrRefresh }) }, () => undefined);
  stop = (id: string) => this.request<void>(`/api/v1/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }, () => undefined);
  logout = (id: string) => this.request<void>(`/api/v1/sessions/${encodeURIComponent(id)}/logout`, { method: 'POST' }, () => undefined);
  remove = (id: string) => this.request<void>(`/api/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }, () => undefined);

  private async request<T>(path: string, init: RequestInit, parse: (value: unknown) => T | null): Promise<T> {
    const controller = new AbortController(); const timer = window.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, signal: controller.signal, headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, ...init.headers } });
      if (response.status === 204) return undefined as T;
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = typeof body === 'object' && body !== null ? (body as { error?: { code?: string; message?: string } }).error?.code : undefined;
        const message = typeof body === 'object' && body !== null ? (body as { error?: { message?: string } }).error?.message : undefined;
        throw new SessionApiError(code === 'SERVICE_UNAVAILABLE' ? 'WORKER_UNAVAILABLE' : 'REQUEST_FAILED', message ?? 'Não foi possível concluir a operação.');
      }
      const parsed = parse(body); if (parsed === null) throw new SessionApiError('REQUEST_FAILED', 'A API retornou um formato inesperado.'); return parsed;
    } catch (error) {
      if (error instanceof SessionApiError) throw error;
      if ((error as DOMException).name === 'AbortError') throw new SessionApiError('TIMEOUT', 'A API demorou para responder.');
      throw new SessionApiError('API_UNAVAILABLE', 'A API está indisponível.');
    } finally { window.clearTimeout(timer); }
  }
}
