import { log } from './logging.js';
import { remainingBudgetMs } from './request-deadline.js';

export type WahaSession = { name: string; status: string };
/** `url` é sempre a canônica quando existe; a thumbnail chega em base64 e viaja
 *  como data URL, que é o formato que o contrato aceita. */
export type WahaLinkPreview = { url: string; title?: string; description?: string; imageUrl?: string };
export type WahaSentMessage = { id?: string; pending: boolean; linkPreview?: WahaLinkPreview };
export type WahaAttachment = { type: 'image' | 'audio' | 'video' | 'document'; url: string; filename: string; mimeType: string; caption?: string; voiceNote?: boolean };
export type WahaIdentity = { whatsappId: string; canonicalWhatsappId: string; phone: string | null; name: string | null; pushName: string | null; shortName: string | null; profilePictureUrl: string | null };
export type WahaGroup = { chatId: string; name: string | null; pictureUrl: string | null; metadata: Record<string, unknown>; participants: Array<{ whatsappId: string; role: string | null }> };
export type WahaHistoryPage = { items: Record<string, unknown>[]; hasMore: boolean; unsupported: string[] };

export class WahaClientError extends Error {
  // `timeout` is WAHA failing to answer within the time it was given; `deadline`
  // is this command running out of the budget the API announced, with WAHA still
  // working. Both end the call, but only the second one says the operation did
  // not fit in the budget, which is what an operator needs to read.
  constructor(readonly kind: 'unavailable' | 'timeout' | 'deadline' | 'response' | 'contract', readonly status?: number, readonly providerMessage?: string, readonly details: Record<string, unknown> = {}) {
    super(kind === 'timeout' ? 'WAHA request timed out' : kind === 'deadline' ? 'command budget ran out before WAHA answered' : kind === 'unavailable' ? 'WAHA is unavailable' : kind === 'contract' ? 'WAHA returned an unsupported response contract' : 'WAHA returned an unexpected response');
    this.name = 'WahaClientError';
  }
  /**
   * The call was abandoned while WAHA was still working on it, so WAHA may have
   * applied it anyway and the state has to be reconciled by reading it back.
   * Which clock ran out — WAHA's own or the command budget — does not change
   * that.
   */
  get interrupted(): boolean { return this.kind === 'timeout' || this.kind === 'deadline'; }
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
  sendText(session: string, chatId: string, text: string, mentions?: readonly string[], linkPreview?: boolean): Promise<WahaSentMessage>;
  sendAttachment(session: string, chatId: string, attachment: WahaAttachment): Promise<WahaSentMessage>;
  getIdentity(session: string, whatsappId: string): Promise<WahaIdentity>;
  getGroup(session: string, chatId: string): Promise<WahaGroup>;
  sendLocation(session: string, chatId: string, location: { latitude: number; longitude: number; title?: string }): Promise<WahaSentMessage>;
  sendContactVcard(session: string, chatId: string, contacts: ReadonlyArray<Record<string, unknown>>): Promise<WahaSentMessage>;
  sendReaction(session: string, messageId: string, reaction: string): Promise<void>;
  listChats(session: string, offset: number, limit: number): Promise<WahaHistoryPage>;
  listMessages(session: string, chatId: string, offset: number, limit: number): Promise<WahaHistoryPage>;
  listContacts(session: string, offset: number, limit: number): Promise<WahaHistoryPage>;
  listLidMappings(session: string, offset: number, limit: number): Promise<WahaHistoryPage>;
}

export class WahaHttpClient implements WahaClientPort {
  /** Os endpoints de listagem materializam o store inteiro da sessão dentro da
   *  WAHA (agenda, conversas, mensagens), e o padrão de 10 s pensado para envio
   *  e QR estourava antes da resposta em qualquer base real — derrubando o sync
   *  de histórico e o de contatos com `TIMEOUT` sistemático. 25 s fica abaixo
   *  do orçamento de transporte de 30 s, então o limite continua sendo o da
   *  WAHA, não o do envelope. `Math.max` respeita um `WAHA_TIMEOUT_MS` ainda
   *  maior vindo do ambiente. */
  private static readonly listingTimeoutMs = 25_000;
  private get listingTimeout(): number { return Math.max(this.options.timeoutMs, WahaHttpClient.listingTimeoutMs); }

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
  async sendText(session: string, chatId: string, text: string, mentions?: readonly string[], linkPreview?: boolean): Promise<WahaSentMessage> {
    // É o próprio app que resolve o link, como acontece no cliente oficial: o
    // default da WAHA já gera prévia, e os parâmetros tornam o pedido explícito
    // (`HighQuality` é melhor esforço no engine WEBJS). O operador pode dispensar
    // a prévia no compositor — aí o texto vai puro, sem nem pedir a versão
    // de alta qualidade.
    // `mentions` exige o `@dígitos` correspondente dentro de `text` — quem
    // garante é a validação da API; aqui o array só viaja quando presente.
    const withPreview = linkPreview !== false;
    const response = await this.requestResponse('/api/sendText', 'POST', { session, chatId, text, linkPreview: withPreview, ...(withPreview ? { linkPreviewHighQuality: true } : {}), ...(mentions?.length ? { mentions: [...mentions] } : {}) });
    const id = messageId(response.data);
    const preview = nativeLinkPreview(response.data, text);
    log('info', 'WAHA sendText accepted', { providerStatus: response.status, responseType: responseType(response.data), responseShape: responseKeys(response.data).join(','), idPresent: Boolean(id), linkPreview: Boolean(preview), mentions: mentions?.length ?? 0 });
    return { ...(id ? { id, pending: false } : { pending: true }), ...(preview ? { linkPreview: preview } : {}) };
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
  async sendAttachment(session: string, chatId: string, attachment: WahaAttachment): Promise<WahaSentMessage> {
    // Keep the object private and delegate retrieval to WAHA through its short
    // lived signed URL. Endpoint choice controls the WhatsApp media kind.
    //
    // Audio is the one kind where the endpoint is not a function of the kind.
    // `/api/sendVoice` produces a recorded note (PTT, waveform) and `/api/sendFile`
    // produces a track; probing the instance found no third route — `sendAudio`
    // and `sendPtt` answer 404 while both of these answer 422. So a music file
    // rides the same endpoint a document does, and `convert` — which transcodes
    // to the OPUS a note requires — must not be sent with it.
    const voiceNote = attachment.type === 'audio' && attachment.voiceNote !== false;
    const path = attachment.type === 'image' ? '/api/sendImage' : voiceNote ? '/api/sendVoice' : attachment.type === 'video' ? '/api/sendVideo' : '/api/sendFile';
    const response = await this.requestResponse(path, 'POST', { session, chatId, file: { url: attachment.url, mimetype: attachment.mimeType, filename: attachment.filename }, ...(attachment.caption ? { caption: attachment.caption } : {}), ...(voiceNote ? { convert: true } : {}), ...(attachment.type === 'video' ? { convert: attachment.mimeType !== 'video/mp4', asNote: false } : {}) });
    const id = messageId(response.data);
    log('info', 'WAHA attachment accepted', { providerStatus: response.status, endpoint: path, mediaType: attachment.type, voiceNote, responseType: responseType(response.data), responseShape: responseKeys(response.data).join(','), idPresent: Boolean(id) });
    return id ? { id, pending: false } : { pending: true };
  }
  async sendLocation(session: string, chatId: string, location: { latitude: number; longitude: number; title?: string }): Promise<WahaSentMessage> {
    const response = await this.requestResponse('/api/sendLocation', 'POST', { session, chatId, latitude: location.latitude, longitude: location.longitude, ...(location.title ? { title: location.title } : {}) });
    const id = messageId(response.data);
    log('info', 'WAHA location accepted', { providerStatus: response.status, responseType: responseType(response.data), responseShape: responseKeys(response.data).join(','), idPresent: Boolean(id) });
    return id ? { id, pending: false } : { pending: true };
  }
  async sendContactVcard(session: string, chatId: string, contacts: ReadonlyArray<Record<string, unknown>>): Promise<WahaSentMessage> {
    const response = await this.requestResponse('/api/sendContactVcard', 'POST', { session, chatId, contacts });
    const id = messageId(response.data);
    log('info', 'WAHA contact card accepted', { providerStatus: response.status, contacts: contacts.length, responseType: responseType(response.data), responseShape: responseKeys(response.data).join(','), idPresent: Boolean(id) });
    return id ? { id, pending: false } : { pending: true };
  }
  // `reaction` vazia é a remoção no protocolo WAHA — por isso o corpo a envia
  // como está, sem trim nem validação de emoji. O `messageId` vai verbatim: é o
  // mesmo id serializado que o webhook `message.reaction` reporta de volta.
  async sendReaction(session: string, messageId: string, reaction: string): Promise<void> {
    const response = await this.requestResponse('/api/reaction', 'PUT', { session, messageId, reaction });
    log('info', 'WAHA reaction accepted', { providerStatus: response.status, removed: reaction.length === 0, responseType: responseType(response.data), responseShape: responseKeys(response.data).join(',') });
  }
  async listChats(session: string, offset: number, limit: number): Promise<WahaHistoryPage> {
    const data = await this.request(`/api/${encodeURIComponent(session)}/chats?limit=${limit}&offset=${offset}&sortBy=conversationTimestamp&sortOrder=desc`, 'GET', undefined, this.listingTimeout);
    const items = Array.isArray(data) ? data.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) ? [{ ...(value as Record<string, unknown>), id: serializedId((value as Record<string, unknown>).id) ?? (value as Record<string, unknown>).id }] : []) : [];
    const unsupported: string[] = []; const accepted = items.filter(item => { const id = stringValue(item.id); if (!id || id === 'status@broadcast' || (!id.endsWith('@c.us') && !id.endsWith('@lid') && !id.endsWith('@g.us'))) { if (id) unsupported.push(id); return false; } return true; });
    return { items: accepted, unsupported, hasMore: items.length === limit };
  }
  async listMessages(session: string, chatId: string, offset: number, limit: number): Promise<WahaHistoryPage> {
    const data = await this.request(`/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&offset=${offset}&downloadMedia=false`, 'GET', undefined, this.listingTimeout);
    const items = Array.isArray(data) ? data.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : []) : [];
    return { items, unsupported: [], hasMore: items.length === limit };
  }
  /** A agenda carregada pela sessão (`GET /api/contacts/all`).
   *
   *  Não é a agenda do telefone inteira: a WAHA WEBJS só enxerga os contatos que
   *  a sessão Web já carregou, e só usuários WhatsApp. Ordenar por `id` é o que
   *  dá ao `offset` um cursor estável — a WAHA pagina um conjunto em memória, e
   *  sem ordenação determinística uma página poderia repetir ou pular itens
   *  entre duas chamadas do job.
   *
   *  Grupos e canais não são filtrados aqui de propósito: quem decide o que vira
   *  contato na base é o serviço de sincronização, e esconder a rejeição aqui
   *  apagaria a métrica de itens ignorados. Só entra em `unsupported` o que não
   *  tem identificador utilizável.
   *
   *  `hasMore` vem de página cheia: a WAHA não informa total nem um flag, e
   *  pedir a página seguinte é a única forma de saber que a agenda acabou. */
  async listContacts(session: string, offset: number, limit: number): Promise<WahaHistoryPage> {
    const data = await this.request(`/api/contacts/all?session=${encodeURIComponent(session)}&limit=${limit}&offset=${offset}&sortBy=id&sortOrder=asc`, 'GET', undefined, this.listingTimeout);
    const items = Array.isArray(data) ? data.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) ? [{ ...(value as Record<string, unknown>), id: serializedId((value as Record<string, unknown>).id) ?? (value as Record<string, unknown>).id }] : []) : [];
    const unsupported: string[] = []; const accepted = items.filter(item => { const id = stringValue(item.id); if (!id) { unsupported.push('(sem id)'); return false; } return true; });
    return { items: accepted, unsupported, hasMore: items.length === limit };
  }
  /** O mapa LID → número real da sessão (`GET /api/{session}/lids`).
   *
   *  O WhatsApp moderno endereça muita gente só por LID — um identificador
   *  técnico que não disca. Este endpoint devolve o par `{lid, pn}` de cada um
   *  que a sessão conhece, e é o que permite gravar o telefone de verdade na
   *  sincronização de contatos. `hasMore` segue a mesma regra da agenda:
   *  página cheia é o único sinal de que pode haver mais. */
  async listLidMappings(session: string, offset: number, limit: number): Promise<WahaHistoryPage> {
    const data = await this.request(`/api/${encodeURIComponent(session)}/lids?limit=${limit}&offset=${offset}`, 'GET', undefined, this.listingTimeout);
    const items = Array.isArray(data) ? data.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : []) : [];
    const unsupported: string[] = []; const accepted = items.filter(item => { const lid = stringValue(item.lid); const pn = stringValue(item.pn); if (!lid || !pn) { unsupported.push('(par lid/pn incompleto)'); return false; } return true; });
    return { items: accepted, unsupported, hasMore: items.length === limit };
  }

  private async request(path: string, method = 'GET', body?: unknown, timeoutMs = this.options.timeoutMs): Promise<unknown> { return (await this.requestResponse(path, method, body, timeoutMs)).data; }
  private async requestResponse(path: string, method = 'GET', body?: unknown, timeoutMs = this.options.timeoutMs): Promise<{ data: unknown; status: number }> {
    // An operation may need several provider calls, so each one gets whatever is
    // left of the command budget rather than a fresh copy of the configured
    // timeout. Without this the budget multiplies by the number of calls and the
    // caller gives up first, reporting its own abort instead of the real cause.
    const budget = remainingBudgetMs();
    const constrained = budget !== undefined && budget < timeoutMs;
    const deadlineMs = constrained ? budget : timeoutMs;
    if (deadlineMs <= 0) throw new WahaClientError('deadline');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl}${path}`, { method, headers: { accept: 'application/json', ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new WahaClientError('response', response.status, safeProviderMessage(text));
      if (!text) return { data: undefined, status: response.status };
      try { return { data: JSON.parse(text), status: response.status }; } catch { return { data: undefined, status: response.status }; }
    } catch (error) {
      if (error instanceof WahaClientError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new WahaClientError(constrained ? 'deadline' : 'timeout');
      throw new WahaClientError('unavailable');
    } finally { clearTimeout(timer); }
  }
  private async optionalRequest(path: string): Promise<unknown> { try { return await this.request(path); } catch (error) { if (error instanceof WahaClientError && error.status === 404) return {}; throw error; } }
}
function session(value: unknown): WahaSession { if (!value || typeof value !== 'object' || typeof (value as { name?: unknown }).name !== 'string' || typeof (value as { status?: unknown }).status !== 'string') throw new WahaClientError('response'); return value as WahaSession; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WahaClientError('response'); return value as Record<string, unknown>; }
function objectOrEmpty(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function serializedId(value: unknown): string | null { return stringValue(value) ?? (value && typeof value === 'object' && !Array.isArray(value) ? stringValue((value as Record<string, unknown>)._serialized) : null); }
function safeMetadata(value: Record<string, unknown>): Record<string, unknown> { const allowed = ['description', 'owner', 'creation', 'createdAt', 'isReadOnly', 'isAnnounce', 'isRestricted']; return Object.fromEntries(allowed.flatMap(key => value[key] === undefined ? [] : [[key, value[key]]])) as Record<string, unknown>; }
function phoneFromChat(chatId: string): string | null { const phone = chatId.split('@', 1)[0].replace(/\D/g, ''); return phone.length >= 8 && phone.length <= 15 ? phone : null; }
function safeProviderMessage(value: string): string | undefined { const trimmed = value.replace(/(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').replace(/\s+/g, ' ').trim(); return trimmed ? trimmed.slice(0, 200) : undefined; }
function messageId(value: unknown): string | undefined { if (typeof value === 'string' && value.trim()) return value.trim(); if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined; const data = value as Record<string, unknown>; return stringValue(data.id) ?? stringValue(data.messageId) ?? stringValue(data.message_id) ?? (data.id && typeof data.id === 'object' ? stringValue((data.id as Record<string, unknown>)._serialized) : null) ?? (data.message && typeof data.message === 'object' ? messageId(data.message) : undefined) ?? undefined; }
function responseType(value: unknown): string { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
function firstHttpUrl(text: string): string | undefined { return text.match(/https?:\/\/\S+/)?.[0]; }
/** A prévia nativa mora no `_data` do whatsapp-web.js (regra 7 do CLAUDE.md: a
 *  raiz é uma vista parcial). Sem título, descrição e thumbnail não há prévia —
 *  ausente é o estado normal, não um erro. */
function nativeLinkPreview(value: unknown, text: string): WahaLinkPreview | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = (value as Record<string, unknown>)._data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const raw = data as Record<string, unknown>;
  const title = stringValue(raw.title) ?? undefined;
  const description = stringValue(raw.description) ?? undefined;
  const thumbnail = stringValue(raw.thumbnail) ?? undefined;
  if (!title && !description && !thumbnail) return undefined;
  const url = stringValue(raw.canonicalUrl) ?? stringValue(raw.matchedText) ?? firstHttpUrl(text);
  if (!url) return undefined;
  return { url, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(thumbnail ? { imageUrl: thumbnail.startsWith('data:') ? thumbnail : `data:image/jpeg;base64,${thumbnail}` } : {}) };
}
function responseKeys(value: unknown): string[] { return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>).slice(0, 20).sort() : []; }
