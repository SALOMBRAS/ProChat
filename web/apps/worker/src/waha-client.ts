export type WahaSession = { name: string; status: string };

export class WahaClientError extends Error {
  constructor(readonly kind: 'unavailable' | 'timeout' | 'response', readonly status?: number) {
    super(kind === 'timeout' ? 'WAHA request timed out' : kind === 'unavailable' ? 'WAHA is unavailable' : 'WAHA returned an unexpected response');
    this.name = 'WahaClientError';
  }
}

export interface WahaClientPort {
  health(): Promise<void>;
  listSessions(): Promise<WahaSession[]>;
  createSession(name: string): Promise<WahaSession>;
  startSession(name: string): Promise<void>;
  getSession(name: string): Promise<WahaSession>;
  getQr(name: string): Promise<string>;
  stopSession(name: string): Promise<void>;
  logoutSession(name: string): Promise<void>;
  removeSession(name: string): Promise<void>;
}

export class WahaHttpClient implements WahaClientPort {
  constructor(private readonly options: { baseUrl: string; apiKey?: string; timeoutMs: number; fetchImpl?: typeof fetch }) {}

  async health(): Promise<void> { await this.request('/health'); }
  async listSessions(): Promise<WahaSession[]> { const data = await this.request('/api/sessions?all=true'); return Array.isArray(data) ? data.map(session) : []; }
  async createSession(name: string): Promise<WahaSession> { return session(await this.request('/api/sessions', 'POST', { name })); }
  async startSession(name: string): Promise<void> { await this.request(`/api/sessions/${encodeURIComponent(name)}/start`, 'POST'); }
  async getSession(name: string): Promise<WahaSession> { return session(await this.request(`/api/sessions/${encodeURIComponent(name)}`)); }
  async getQr(name: string): Promise<string> {
    // WAHA waits for SCAN_QR_CODE internally. A QR request must never outlive
    // the API/worker command when authentication changes the session state.
    const data = await this.request(`/api/${encodeURIComponent(name)}/auth/qr?format=raw`, 'GET', undefined, Math.min(this.options.timeoutMs, 1_500));
    if (!data || typeof data !== 'object' || typeof (data as { value?: unknown }).value !== 'string') throw new WahaClientError('response');
    return (data as { value: string }).value;
  }
  async stopSession(name: string): Promise<void> { await this.request(`/api/sessions/${encodeURIComponent(name)}/stop`, 'POST'); }
  async logoutSession(name: string): Promise<void> { await this.request(`/api/sessions/${encodeURIComponent(name)}/logout`, 'POST'); }
  async removeSession(name: string): Promise<void> { await this.request(`/api/sessions/${encodeURIComponent(name)}`, 'DELETE'); }

  private async request(path: string, method = 'GET', body?: unknown, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl}${path}`, { method, headers: { accept: 'application/json', ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      if (!response.ok) throw new WahaClientError('response', response.status);
      const text = await response.text();
      return text ? JSON.parse(text) : undefined;
    } catch (error) {
      if (error instanceof WahaClientError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new WahaClientError('timeout');
      throw new WahaClientError('unavailable');
    } finally { clearTimeout(timer); }
  }
}
function session(value: unknown): WahaSession { if (!value || typeof value !== 'object' || typeof (value as { name?: unknown }).name !== 'string' || typeof (value as { status?: unknown }).status !== 'string') throw new WahaClientError('response'); return value as WahaSession; }
