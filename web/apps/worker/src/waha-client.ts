import { log } from './logging.js';

export type WahaSession = { name: string; status: string };
export type WahaSentMessage = { id?: string; pending: boolean };
export type WahaAttachment = { type: 'image' | 'audio' | 'video' | 'document'; url: string; filename: string; mimeType: string; caption?: string };
export type WahaIdentity = { whatsappId: string; canonicalWhatsappId: string; phone: string | null; name: string | null; pushName: string | null; shortName: string | null; profilePictureUrl: string | null };
export type WahaGroup = { chatId: string; name: string | null; pictureUrl: string | null; metadata: Record<string, unknown>; participants: Array<{ whatsappId: string; role: string | null }> };
export type WahaHistoryPage = { items: Record<string, unknown>[]; hasMore: boolean; unsupported: string[] };

export class WahaClientError extends Error {
  constructor(readonly kind: 'unavailable' | 'timeout' | 'response' | 'contract', readonly status?: number, readonly providerMessage?: string, readonly details: Record<string, unknown> = {}) {
    super(kind === 'timeout' ? 'WAHA request timed out' : kind === 'unavailable' ? 'WAHA is unavailable' : kind === 'contract' ? 'WAHA returned an unsupported response contract' : 'WAHA returned an unexpected response');
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
  sendText(session: string, chatId: string, text: string): Promise<WahaSentMessage>;
  sendFile(session: string, chatId: string, attachment: WahaAttachment): Promise<WahaSentMessage>;
  getIdentity(session: string, whatsappId: string): Promise<WahaIdentity>;
  getGroup(session: string, chatId: string): Promise<WahaGroup>;
  listChats(session: string, offset: number, limit: number): Promise<WahaHistoryPage>;
  listMessages(session: string, chatId: string, offset: number, limit: number): Promise<WahaHistoryPage>;
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
  async sendText(session: string, chatId: string, text: string): Promise<WahaSentMessage> {
    const response = await this.requestResponse('/api/sendText', 'POST', { session, chatId, text });
    const id = messageId(response.data);
    log('info', 'WAHA sendText accepted', { providerStatus: response.status, responseType: responseType(response.data), responseShape: responseKeys(response.data).join(','), idPresent: Boolean(id) });
    return id ? { id, pending: false } : { pending: true };
  }
  async getIdentity(session: string, whatsappId: string): Promise<WahaIdentity> {
    const contact = object(await this.request(`/api/contacts?contactId=${encodeURIComponent(whatsappId)}&session=${encodeURIComponent(session)}`));
    const picture = objectOrEmpty(await this.optionalRequest(`/api/contacts/profile-picture?contactId=${encodeURIComponent(whatsappId)}&session=${encodeURIComponent(session)}`));
    const lid = whatsappId.endsWith('@lid') ? objectOrEmpty(await this.optionalRequest(`/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(whatsappId)}`)) : {};
    const canonicalWhatsappId = stringValue(lid.pn) ?? (whatsappId.endsWith('@c.us') ? whatsappId : stringValue(contact.id) ?? whatsappId);
    return { whatsappId, canonicalWhatsappId, phone: stringValue(contact.number) ?? phoneFromChat(canonicalWhatsappId), name: stringValue(contact.name), pushName: stringValue(contact.pushname) ?? stringValue(contact.pushName), shortName: stringValue(contact.shortName), profilePictureUrl: stringValue(picture.profilePictureURL) ?? stringValue(picture.url) };
  }
  async getGroup(session: string, chatId: string): Promise<WahaGroup> {
    const group = object(await this.request(`/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(chatId)}`));
    const picture = objectOrEmpty(await this.optionalRequest(`/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(chatId)}/picture?refresh=false`));
    const participants = await this.request(`/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(chatId)}/participants/v2`);
    return { chatId, name: stringValue(group.subject) ?? stringValue(group.name), pictureUrl: stringValue(picture.url), metadata: safeMetadata(group), participants: Array.isArray(participants) ? participants.flatMap(value => { const participant = object(value); const whatsappId = stringValue(participant.id); return whatsappId ? [{ whatsappId, role: stringValue(participant.role) }] : []; }) : [] };
  }
  async sendFile(session: string, chatId: string, attachment: WahaAttachment): Promise<WahaSentMessage> {
    // WAHA Core 2026.7.1 sendFile accepts a JSON File object. We deliberately
    // use only its URL form: no server path and no base64 leave this boundary.
    const response = await this.requestResponse('/api/sendFile', 'POST', { session, chatId, file: { url: attachment.url, mimetype: attachment.mimeType, filename: attachment.filename }, ...(attachment.caption ? { caption: attachment.caption } : {}) });
    const id = messageId(response.data);
    log('info', 'WAHA sendFile accepted', { providerStatus: response.status, mediaType: attachment.type, responseType: responseType(response.data), responseShape: responseKeys(response.data).join(','), idPresent: Boolean(id) });
    return id ? { id, pending: false } : { pending: true };
  }
  async listChats(session: string, offset: number, limit: number): Promise<WahaHistoryPage> {
    const data = await this.request(`/api/${encodeURIComponent(session)}/chats?limit=${limit}&offset=${offset}&sortBy=messageTimestamp&sortOrder=desc`);
    const items = Array.isArray(data) ? data.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : []) : [];
    const unsupported: string[] = []; const accepted = items.filter(item => { const id = stringValue(item.id); if (!id || id === 'status@broadcast' || (!id.endsWith('@c.us') && !id.endsWith('@lid') && !id.endsWith('@g.us'))) { if (id) unsupported.push(id); return false; } return true; });
    return { items: accepted, unsupported, hasMore: items.length === limit };
  }
  async listMessages(session: string, chatId: string, offset: number, limit: number): Promise<WahaHistoryPage> {
    const data = await this.request(`/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&offset=${offset}&downloadMedia=false`);
    const items = Array.isArray(data) ? data.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : []) : [];
    return { items, unsupported: [], hasMore: items.length === limit };
  }

  private async request(path: string, method = 'GET', body?: unknown, timeoutMs = this.options.timeoutMs): Promise<unknown> { return (await this.requestResponse(path, method, body, timeoutMs)).data; }
  private async requestResponse(path: string, method = 'GET', body?: unknown, timeoutMs = this.options.timeoutMs): Promise<{ data: unknown; status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl}${path}`, { method, headers: { accept: 'application/json', ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new WahaClientError('response', response.status, safeProviderMessage(text));
      if (!text) return { data: undefined, status: response.status };
      try { return { data: JSON.parse(text), status: response.status }; } catch { return { data: undefined, status: response.status }; }
    } catch (error) {
      if (error instanceof WahaClientError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new WahaClientError('timeout');
      throw new WahaClientError('unavailable');
    } finally { clearTimeout(timer); }
  }
  private async optionalRequest(path: string): Promise<unknown> { try { return await this.request(path); } catch (error) { if (error instanceof WahaClientError && error.status === 404) return {}; throw error; } }
}
function session(value: unknown): WahaSession { if (!value || typeof value !== 'object' || typeof (value as { name?: unknown }).name !== 'string' || typeof (value as { status?: unknown }).status !== 'string') throw new WahaClientError('response'); return value as WahaSession; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WahaClientError('response'); return value as Record<string, unknown>; }
function objectOrEmpty(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function safeMetadata(value: Record<string, unknown>): Record<string, unknown> { const allowed = ['description', 'owner', 'creation', 'createdAt', 'isReadOnly', 'isAnnounce', 'isRestricted']; return Object.fromEntries(allowed.flatMap(key => value[key] === undefined ? [] : [[key, value[key]]])) as Record<string, unknown>; }
function phoneFromChat(chatId: string): string | null { const phone = chatId.split('@', 1)[0].replace(/\D/g, ''); return phone.length >= 8 && phone.length <= 15 ? phone : null; }
function safeProviderMessage(value: string): string | undefined { const trimmed = value.replace(/(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').replace(/\s+/g, ' ').trim(); return trimmed ? trimmed.slice(0, 200) : undefined; }
function messageId(value: unknown): string | undefined { if (typeof value === 'string' && value.trim()) return value.trim(); if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined; const data = value as Record<string, unknown>; return stringValue(data.id) ?? stringValue(data.messageId) ?? stringValue(data.message_id) ?? (data.id && typeof data.id === 'object' ? stringValue((data.id as Record<string, unknown>)._serialized) : null) ?? (data.message && typeof data.message === 'object' ? messageId(data.message) : undefined) ?? undefined; }
function responseType(value: unknown): string { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
function responseKeys(value: unknown): string[] { return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>).slice(0, 20).sort() : []; }
