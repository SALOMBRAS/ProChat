import { AppError } from '../errors.js';
import { log } from '../logging.js';
import type { RealtimeHub } from '../realtime.js';

/**
 * CallService — cliente do Call Service (Go, fork do WaCalls), o provider
 * paralelo de chamadas de voz. A WAHA continua dona das mensagens; tudo que é
 * chamada passa por aqui. Dois deveres:
 *
 * 1. HTTP: iniciar/aceitar/rejeitar/encerrar chamadas e trocar o SDP do
 *    softphone do navegador (o áudio trafega PCM 16 kHz por Data Channel
 *    WebRTC direto entre navegador e o serviço Go).
 * 2. SSE: assinar /api/events do serviço Go, manter o mapa de chamadas ativas
 *    e republicar no RealtimeHub como `call.updated`, para o dashboard abrir
 *    o modal de chamada recebida e acompanhar o estado sem polling.
 */

type GoSession = { id: string; name: string; jid: string; state: string; paired: boolean; qr?: string };

export type CallPairingStatus = {
  available: boolean;
  sessionId?: string;
  name?: string;
  jid?: string;
  state?: string;
  paired: boolean;
  qr?: string;
};

export type ActiveCall = {
  callId: string;
  sessionId: string;
  direction: 'inbound' | 'outbound';
  peer: string;
  status: 'starting' | 'ringing' | 'connected' | 'ended';
  startedAt: number;
  owner?: string | null;
};

type CallServiceOptions = {
  baseUrl: string;
  ownWhatsappNumbers: readonly string[];
  realtimeHub?: RealtimeHub;
  /** Workspace que recebe os eventos realtime (slice 1: workspace única do webhook). */
  eventsWorkspaceId?: string;
};

const digits = (value: string) => value.replace(/\D/g, '');

export class CallService {
  private readonly baseUrl: string;
  private readonly ownNumbers: readonly string[];
  private readonly hub?: RealtimeHub;
  private readonly eventsWorkspaceId?: string;
  private readonly calls = new Map<string, ActiveCall>();
  private eventsStarted = false;

  constructor(options: CallServiceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.ownNumbers = options.ownWhatsappNumbers;
    this.hub = options.realtimeHub;
    this.eventsWorkspaceId = options.eventsWorkspaceId;
  }

  activeCalls(): ActiveCall[] {
    return [...this.calls.values()];
  }

  /** Ligação de saída: resolve a sessão pareada no serviço Go e dispara o offer.
   *  `phone`: o serviço Go canonicaliza o JID (BR sem 9º dígito) via IsOnWhatsApp.
   *  `lid`: contato endereçado por LID — o Go resolve LID→PN pelo store da
   *  sessão e, sem mapa, disca o JID @lid direto. */
  async startCall(target: { phone: string } | { lid: string }): Promise<ActiveCall> {
    const session = await this.resolveSession();
    const response = await this.request<{ call?: { callId?: string } }>('POST', `/api/sessions/${session.id}/calls`, target);
    const callId = response.call?.callId;
    if (!callId) throw new AppError(502, 'PROVIDER_CONTRACT_ERROR', 'Call Service did not return a call id');
    const peer = 'phone' in target ? target.phone : `${target.lid}@lid`;
    const call: ActiveCall = { callId, sessionId: session.id, direction: 'outbound', peer, status: 'ringing', startedAt: Date.now() };
    this.calls.set(callId, call);
    this.publish(call);
    return call;
  }

  /** Troca SDP do softphone: o navegador oferece, o serviço Go responde.
   *  Depois disso o Data Channel "pcm" liga navegador ⇄ núcleo da chamada. */
  async exchangeSdp(callId: string, sdpOffer: string): Promise<string> {
    const call = this.requireCall(callId);
    const answer = await this.request<{ sdp_answer?: string }>('POST', `/api/sessions/${call.sessionId}/calls/${callId}/webrtc`, { sdp_offer: sdpOffer });
    if (!answer.sdp_answer) throw new AppError(502, 'PROVIDER_CONTRACT_ERROR', 'Call Service did not return an SDP answer');
    return answer.sdp_answer;
  }

  async accept(callId: string): Promise<void> {
    const call = this.requireCall(callId);
    await this.request('POST', `/api/sessions/${call.sessionId}/calls/${callId}/accept`);
  }

  async reject(callId: string): Promise<void> {
    const call = this.requireCall(callId);
    await this.request('POST', `/api/sessions/${call.sessionId}/calls/${callId}/reject`);
    this.calls.delete(callId);
  }

  async end(callId: string): Promise<void> {
    const call = this.requireCall(callId);
    await this.request('DELETE', `/api/sessions/${call.sessionId}/calls/${callId}`);
    this.calls.delete(callId);
  }

  /** Escolhe a sessão do serviço Go que pertence a este workspace: preferência
   *  para o número próprio configurado; com uma sessão pareada só, usa ela. */
  private async resolveSession(): Promise<GoSession> {
    const list = await this.request<{ sessions?: GoSession[] }>('GET', '/api/sessions');
    const paired = (list.sessions ?? []).filter(session => session.paired && session.state === 'open' && session.jid);
    if (!paired.length) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Nenhuma sessão de chamadas pareada. Pareie o WhatsApp no Call Service (aparelhos conectados).');
    if (this.ownNumbers.length) {
      const match = paired.find(session => this.ownNumbers.some(own => digits(session.jid).startsWith(own)));
      if (match) return match;
    }
    if (paired.length === 1) return paired[0]!;
    throw new AppError(409, 'CONFLICT', 'Mais de uma sessão de chamadas pareada; configure WHATSAPP_OWN_NUMBERS para escolher.', { sessions: paired.map(session => session.jid) });
  }

  /** Status de pareamento para a tela de sessões: a mesma tela que pareia a
   *  WAHA mostra o estado (e o QR) das chamadas ao lado. */
  async pairingStatus(): Promise<CallPairingStatus> {
    const list = await this.request<{ sessions?: GoSession[] }>('GET', '/api/sessions');
    const session = this.pickPairingSession(list.sessions ?? []);
    if (!session) return { available: true, paired: false };
    return { available: true, sessionId: session.id, name: session.name, jid: session.jid || undefined, state: session.state, paired: session.paired, qr: session.qr || undefined };
  }

  /** Garante uma sessão de chamadas em processo de pareamento: cria quando não
   *  há nenhuma; re-pareia quando a escolhida caiu (logged_out/timeout). O QR
   *  chega de forma assíncrona — a tela segue consultando o pairingStatus. */
  async ensurePairing(name = 'ChatPro'): Promise<CallPairingStatus> {
    const list = await this.request<{ sessions?: GoSession[] }>('GET', '/api/sessions');
    const session = this.pickPairingSession(list.sessions ?? []);
    if (!session) {
      await this.request('POST', '/api/sessions', { name });
    } else if (!session.paired && session.state !== 'qr') {
      try {
        await this.request('POST', `/api/sessions/${session.id}/pair`);
      } catch (error) {
        // Sessão deslogada pelo WhatsApp pode manter o device local e o /pair
        // responde 400 "session already paired": reseta o cliente e re-pareia.
        if (!(error instanceof AppError) || error.status !== 400) throw error;
        await this.request('POST', `/api/sessions/${session.id}/logout`);
        await this.request('POST', `/api/sessions/${session.id}/pair`);
      }
    }
    return this.pairingStatus();
  }

  /** A sessão que representa este workspace: a pareada do número próprio; sem
   *  ela, a única existente; com várias e nenhuma do número, a primeira pareada
   *  ou a primeira da lista (a tela mostra o estado para o operador decidir). */
  private pickPairingSession(sessions: GoSession[]): GoSession | undefined {
    if (!sessions.length) return undefined;
    if (this.ownNumbers.length) {
      const match = sessions.find(session => session.jid && this.ownNumbers.some(own => digits(session.jid).startsWith(own)));
      if (match) return match;
    }
    if (sessions.length === 1) return sessions[0];
    return sessions.find(session => session.paired) ?? sessions[0];
  }

  private requireCall(callId: string): ActiveCall {
    const call = this.calls.get(callId);
    if (!call) throw new AppError(404, 'NOT_FOUND', 'Chamada não encontrada ou já encerrada', { callId });
    return call;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Call Service indisponível. Verifique se o serviço de chamadas está rodando.', { cause: error instanceof Error ? error.message : String(error) });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new AppError(response.status === 404 ? 404 : 502, 'PROVIDER_CONTRACT_ERROR', `Call Service respondeu ${response.status}`, { path, detail: detail.slice(0, 300) });
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Assina o SSE do serviço Go uma única vez, com reconexão. Os eventos de
   *  chamada alimentam o mapa interno e o RealtimeHub do dashboard. */
  startEventBridge(): void {
    if (this.eventsStarted) return;
    this.eventsStarted = true;
    const connect = async () => {
      for (;;) {
        try {
          const response = await fetch(`${this.baseUrl}/api/events`, { headers: { accept: 'text/event-stream' } });
          if (!response.ok || !response.body) throw new Error(`SSE respondeu ${response.status}`);
          await this.consumeEventStream(response.body);
        } catch (error) {
          log('info', 'Call Service SSE desconectado; tentando de novo em 5s', { error: error instanceof Error ? error.message : String(error) });
          await new Promise(resolve => setTimeout(resolve, 5_000));
        }
      }
    };
    void connect();
  }

  private async consumeEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = block.split('\n').find(line => line.startsWith('data:'));
        if (!dataLine) continue;
        try {
          this.handleEvent(JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>);
        } catch { /* evento malformado não derruba a ponte */ }
      }
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = event.type;
    const callId = typeof event.id === 'string' ? event.id : undefined;
    const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;
    if (!callId || !sessionId) return;

    if (type === 'incoming') {
      const call: ActiveCall = { callId, sessionId, direction: 'inbound', peer: String(event.peer ?? ''), status: 'ringing', startedAt: Number(event.offeredAt ?? Date.now()) };
      this.calls.set(callId, call);
      this.publish(call);
      return;
    }
    if (type === 'call-status') {
      const existing = this.calls.get(callId);
      const status = String(event.status ?? 'ringing') as ActiveCall['status'];
      const call: ActiveCall = existing
        ? { ...existing, status, owner: (event.owner as string | null) ?? existing.owner }
        : { callId, sessionId, direction: 'outbound', peer: String(event.peer ?? ''), status, startedAt: Number(event.startedAt ?? Date.now()), owner: (event.owner as string | null) ?? null };
      this.calls.set(callId, call);
      this.publish(call);
      return;
    }
    if (type === 'call-ended') {
      const existing = this.calls.get(callId);
      this.calls.delete(callId);
      if (existing) this.publish({ ...existing, status: 'ended' }, { reason: String(event.reason ?? '') });
    }
  }

  private publish(call: ActiveCall, extra?: Record<string, unknown>): void {
    if (!this.hub || !this.eventsWorkspaceId) return;
    this.hub.publish(this.eventsWorkspaceId, 'call.updated', { ...call, ...(extra ?? {}) });
  }
}
