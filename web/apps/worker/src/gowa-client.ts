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
/** GOWA takes media either as multipart bytes or as a URL it fetches itself.
 * ChatPro uses the URL form, exactly as it already does with WAHA: the object
 * stays private behind a short-lived signed URL and the worker never streams
 * the bytes. `kind` selects the endpoint and the `*_url` field name. */
export type GowaMediaKind = 'image' | 'video' | 'audio' | 'file';
export type GowaOutboundMedia = { url: string; caption?: string; voiceNote?: boolean; replyMessageId?: string };
export type GowaPage = { offset: number; limit: number };
export type GowaListing = { items: Record<string, unknown>[]; hasMore: boolean };
export type GowaDownloadedMedia = { fileUrl: string | null; filename: string | null; mediaType: string | null; fileSize: number | null };

export interface GowaClientPort {
  health(): Promise<void>;
  createDevice(deviceId: string): Promise<GowaDevice>;
  listDevices(): Promise<GowaDevice[]>;
  getSessionStatus(deviceId: string): Promise<GowaSessionState>;
  startLogin(deviceId: string): Promise<GowaLogin>;
  fetchQrImage(qrLink: string): Promise<string>;
  logout(deviceId: string): Promise<void>;
  reconnect(deviceId: string): Promise<void>;
  removeDevice(deviceId: string): Promise<void>;
  sendText(deviceId: string, phone: string, message: string, options?: { mentions?: readonly string[]; replyMessageId?: string }): Promise<GowaSentMessage>;
  sendMedia(deviceId: string, kind: GowaMediaKind, phone: string, media: GowaOutboundMedia): Promise<GowaSentMessage>;
  sendLocation(deviceId: string, phone: string, location: { latitude: number; longitude: number }): Promise<GowaSentMessage>;
  sendContact(deviceId: string, phone: string, contact: { name: string; phoneNumber: string }): Promise<GowaSentMessage>;
  sendReaction(deviceId: string, messageId: string, phone: string, emoji: string): Promise<void>;
  listContacts(deviceId: string, page: GowaPage): Promise<GowaListing>;
  getAvatar(deviceId: string, phone: string): Promise<string | null>;
  listChats(deviceId: string, page: GowaPage): Promise<GowaListing>;
  listMessages(deviceId: string, chatJid: string, page: GowaPage): Promise<GowaListing>;
  getGroupInfo(deviceId: string, groupId: string): Promise<Record<string, unknown>>;
  getGroupParticipants(deviceId: string, groupId: string): Promise<Record<string, unknown>[]>;
  downloadMedia(deviceId: string, messageId: string, phone: string): Promise<GowaDownloadedMedia>;
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

  async reconnect(deviceId: string): Promise<void> {
    await this.results(`/devices/${encodeURIComponent(deviceId)}/reconnect`, { method: 'POST' });
  }

  async removeDevice(deviceId: string): Promise<void> {
    await this.results(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  }

  async sendText(deviceId: string, phone: string, message: string, options: { mentions?: readonly string[]; replyMessageId?: string } = {}): Promise<GowaSentMessage> {
    return this.sent(await this.results('/send/message', this.json(deviceId, {
      phone, message,
      ...(options.mentions?.length ? { mentions: [...options.mentions] } : {}),
      ...(options.replyMessageId ? { reply_message_id: options.replyMessageId } : {}),
    })));
  }

  /** Endpoint and URL field are both a function of the kind; `ptt` is what
   * separates a voice note from an audio file, and only audio has it. */
  async sendMedia(deviceId: string, kind: GowaMediaKind, phone: string, media: GowaOutboundMedia): Promise<GowaSentMessage> {
    const body: Record<string, unknown> = { phone, [`${kind}_url`]: media.url };
    if (media.caption && kind !== 'audio') body.caption = media.caption;
    if (kind === 'audio') body.ptt = media.voiceNote === true;
    if (media.replyMessageId) body.reply_message_id = media.replyMessageId;
    return this.sent(await this.results(`/send/${kind}`, this.json(deviceId, body)));
  }

  /** GOWA types the coordinates as strings, unlike WAHA. It has no title field
   * — the caller decides what to do with a title it cannot deliver. */
  async sendLocation(deviceId: string, phone: string, location: { latitude: number; longitude: number }): Promise<GowaSentMessage> {
    return this.sent(await this.results('/send/location', this.json(deviceId, { phone, latitude: String(location.latitude), longitude: String(location.longitude) })));
  }

  /** One contact per call: GOWA takes a flat contact_name/contact_phone pair. */
  async sendContact(deviceId: string, phone: string, contact: { name: string; phoneNumber: string }): Promise<GowaSentMessage> {
    return this.sent(await this.results('/send/contact', this.json(deviceId, { phone, contact_name: contact.name, contact_phone: contact.phoneNumber })));
  }

  /** An empty emoji is how WhatsApp removes a reaction; GOWA takes the same. */
  async sendReaction(deviceId: string, messageId: string, phone: string, emoji: string): Promise<void> {
    await this.results(`/message/${encodeURIComponent(messageId)}/reaction`, this.json(deviceId, { phone, emoji }));
  }

  async listContacts(deviceId: string, page: GowaPage): Promise<GowaListing> {
    return this.listing(await this.results(`/user/my/contacts?${this.pageQuery(page)}`, this.get(deviceId)), page.limit);
  }

  async getAvatar(deviceId: string, phone: string): Promise<string | null> {
    const results = this.record(await this.results(`/user/avatar?phone=${encodeURIComponent(phone)}`, this.get(deviceId)));
    const url = results.url ?? results.avatar_url;
    return typeof url === 'string' && url ? url : null;
  }

  async listChats(deviceId: string, page: GowaPage): Promise<GowaListing> {
    return this.listing(await this.results(`/chats?${this.pageQuery(page)}`, this.get(deviceId)), page.limit);
  }

  async listMessages(deviceId: string, chatJid: string, page: GowaPage): Promise<GowaListing> {
    return this.listing(await this.results(`/chat/${encodeURIComponent(chatJid)}/messages?${this.pageQuery(page)}`, this.get(deviceId)), page.limit);
  }

  async getGroupInfo(deviceId: string, groupId: string): Promise<Record<string, unknown>> {
    return this.record(await this.results(`/group/info?group_id=${encodeURIComponent(groupId)}`, this.get(deviceId)));
  }

  async getGroupParticipants(deviceId: string, groupId: string): Promise<Record<string, unknown>[]> {
    return this.listing(await this.results(`/group/participants?group_id=${encodeURIComponent(groupId)}`, this.get(deviceId)), Number.MAX_SAFE_INTEGER).items;
  }

  /** The download contract also returns `file_path`, a path on the GOWA host.
   * It is deliberately dropped here: API and GOWA are not guaranteed to share
   * a filesystem, and a server path must never reach ChatPro storage or UI. */
  async downloadMedia(deviceId: string, messageId: string, phone: string): Promise<GowaDownloadedMedia> {
    const results = this.record(await this.results(`/message/${encodeURIComponent(messageId)}/download?phone=${encodeURIComponent(phone)}`, this.get(deviceId)));
    return {
      fileUrl: typeof results.file_url === 'string' && results.file_url ? results.file_url : null,
      filename: typeof results.filename === 'string' && results.filename ? results.filename : null,
      mediaType: typeof results.media_type === 'string' && results.media_type ? results.media_type : null,
      fileSize: typeof results.file_size === 'number' && Number.isFinite(results.file_size) ? results.file_size : null,
    };
  }

  private json(deviceId: string, body: Record<string, unknown>): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': deviceId }, body: JSON.stringify(body) };
  }

  private get(deviceId: string): RequestInit {
    return { method: 'GET', headers: { 'x-device-id': deviceId } };
  }

  private pageQuery(page: GowaPage): string {
    // GOWA caps a page at 100; asking for more is silently truncated, which
    // would make `hasMore` lie. Clamp here so the caller's paging stays honest.
    return `limit=${Math.min(Math.max(page.limit, 1), 100)}&offset=${Math.max(page.offset, 0)}`;
  }

  private listing(results: unknown, limit: number): GowaListing {
    const items = Array.isArray(results) ? results : this.collection(results);
    return { items: items.map(item => this.record(item)), hasMore: items.length >= Math.min(Math.max(limit, 1), 100) };
  }

  /** GOWA wraps some collections in `results.data`/`results.<name>`. Accept the
   * array wherever it sits, but never guess a scalar into a list. */
  private collection(results: unknown): unknown[] {
    const record = this.record(results);
    for (const value of Object.values(record)) if (Array.isArray(value)) return value;
    throw new GowaClientError('contract');
  }

  private sent(results: unknown): GowaSentMessage {
    const record = this.record(results);
    const id = record.message_id ?? record.id;
    if (typeof id !== 'string' || !id) throw new GowaClientError('contract');
    return { id };
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
