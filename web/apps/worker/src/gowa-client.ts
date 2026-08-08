export type GowaHttpClientOptions = {
  baseUrl: string;
  /**
   * GOWA documents Basic Auth, rather than a generic API-key header. The
   * value remains configuration-only until a deployment auth contract exists.
   */
  apiKey?: string;
  basicAuthUsername?: string;
  basicAuthPassword?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

type GowaClientErrorKind = 'unavailable' | 'timeout' | 'response' | 'contract';

export class GowaClientError extends Error {
  constructor(readonly kind: GowaClientErrorKind, readonly status?: number) {
    super(kind === 'timeout' ? 'GOWA request timed out' : kind === 'unavailable' ? 'GOWA is unavailable' : kind === 'contract' ? 'GOWA response contract is invalid' : 'GOWA request failed');
    this.name = 'GowaClientError';
  }
}

export type GowaDevice = { id: string; state: string };
export type GowaSessionState = { isConnected: boolean; isLoggedIn: boolean };
export type GowaLogin = { qrLink: string; qrDurationSeconds: number };
export type GowaSentMessage = { id: string };

export interface GowaClientPort {
  health(): Promise<void>;
  createDevice(deviceId: string): Promise<GowaDevice>;
  listDevices(): Promise<GowaDevice[]>;
  getSessionStatus(deviceId: string): Promise<GowaSessionState>;
  startLogin(deviceId: string): Promise<GowaLogin>;
  fetchQrImage(qrLink: string): Promise<string>;
  logout(deviceId: string): Promise<void>;
  sendText(deviceId: string, phone: string, message: string): Promise<GowaSentMessage>;
}

const MAX_QR_IMAGE_BYTES = 6_000;

/** HTTP boundary for the documented GOWA device lifecycle API. */
export class GowaHttpClient implements GowaClientPort {
  private readonly baseUrl: string;

  constructor(private readonly options: GowaHttpClientOptions) {
    try {
      const url = new URL(options.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
      this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    } catch { throw new Error('GOWA_BASE_URL must be a valid HTTP(S) URL'); }
    if (Boolean(options.basicAuthUsername) !== Boolean(options.basicAuthPassword)) throw new Error('GOWA Basic Auth requires both username and password');
  }

  async health(): Promise<void> {
    await this.request('/health', { method: 'GET' });
  }

  async createDevice(deviceId: string): Promise<GowaDevice> {
    return this.device(await this.results('/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_id: deviceId }) }));
  }

  async listDevices(): Promise<GowaDevice[]> {
    const results = await this.results('/devices', { method: 'GET' });
    if (!Array.isArray(results)) throw new GowaClientError('contract');
    return results.map(result => this.device(result));
  }

  async getSessionStatus(deviceId: string): Promise<GowaSessionState> {
    const results = this.record(await this.results(`/devices/${encodeURIComponent(deviceId)}/status`, { method: 'GET' }));
    if (typeof results.is_connected !== 'boolean' || typeof results.is_logged_in !== 'boolean') throw new GowaClientError('contract');
    return { isConnected: results.is_connected, isLoggedIn: results.is_logged_in };
  }

  async startLogin(deviceId: string): Promise<GowaLogin> {
    const results = this.record(await this.results(`/devices/${encodeURIComponent(deviceId)}/login`, { method: 'GET' }));
    if (typeof results.qr_link !== 'string' || !results.qr_link || typeof results.qr_duration !== 'number' || !Number.isFinite(results.qr_duration) || results.qr_duration <= 0) throw new GowaClientError('contract');
    return { qrLink: results.qr_link, qrDurationSeconds: results.qr_duration };
  }

  async fetchQrImage(qrLink: string): Promise<string> {
    const target = this.trustedQrUrl(qrLink);
    const response = await this.request(target.toString(), { method: 'GET' }, true);
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].toLowerCase();
    if (!contentType.startsWith('image/')) throw new GowaClientError('contract');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_QR_IMAGE_BYTES) throw new GowaClientError('contract');
    return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
  }

  async logout(deviceId: string): Promise<void> {
    await this.results(`/devices/${encodeURIComponent(deviceId)}/logout`, { method: 'POST' });
  }

  async sendText(deviceId: string, phone: string, message: string): Promise<GowaSentMessage> {
    const results = this.record(await this.results('/send/message', { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': deviceId }, body: JSON.stringify({ phone, message }) }));
    if (typeof results.message_id !== 'string' || !results.message_id) throw new GowaClientError('contract');
    return { id: results.message_id };
  }

  private async results(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(path, init);
    let body: unknown;
    try { body = await response.json(); } catch { throw new GowaClientError('contract'); }
    const envelope = this.record(body);
    if (envelope.code !== 'SUCCESS' || !Object.prototype.hasOwnProperty.call(envelope, 'results')) throw new GowaClientError('contract');
    return envelope.results;
  }

  private async request(path: string, init: RequestInit, absolute = false): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      if (this.options.basicAuthUsername && this.options.basicAuthPassword) headers.set('authorization', `Basic ${Buffer.from(`${this.options.basicAuthUsername}:${this.options.basicAuthPassword}`).toString('base64')}`);
      const response = await (this.options.fetchImpl ?? fetch)(absolute ? path : `${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      if (!response.ok) throw new GowaClientError('response', response.status);
      return response;
    } catch (error) {
      if (error instanceof GowaClientError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new GowaClientError('timeout');
      throw new GowaClientError('unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  private trustedQrUrl(qrLink: string): URL {
    let target: URL;
    try { target = new URL(qrLink); } catch { throw new GowaClientError('contract'); }
    if (target.origin !== new URL(this.baseUrl).origin) throw new GowaClientError('contract');
    return target;
  }

  private device(value: unknown): GowaDevice {
    const device = this.record(value);
    if (typeof device.id !== 'string' || !device.id || typeof device.state !== 'string') throw new GowaClientError('contract');
    return { id: device.id, state: device.state };
  }

  private record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GowaClientError('contract');
    return value as Record<string, unknown>;
  }
}
