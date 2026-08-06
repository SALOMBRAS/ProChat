import { ApiClient } from './client';

/** Espelho do `ActiveCall` exposto pela API (web/apps/api/src/services/call.service.ts).
 *  O payload do evento realtime `call.updated` carrega estes mesmos campos,
 *  mais `reason` quando o encerramento veio do WhatsApp. */
export type ActiveCall = {
  callId: string;
  sessionId: string;
  direction: 'inbound' | 'outbound';
  peer: string;
  status: 'starting' | 'ringing' | 'connected' | 'ended';
  startedAt: number;
  owner?: string | null;
  reason?: string;
  conversationId?: string;
};

export type CallPairingStatus = {
  available: boolean;
  sessionId?: string;
  name?: string;
  jid?: string;
  state?: string;
  paired: boolean;
  qr?: string;
};

/** Linha do histórico de chamadas da conversa (espelho do `history` da API). */
export type CallHistoryEntry = {
  callId: string;
  direction: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  recording: boolean;
  /** Só no histórico global (aba Chamadas): nome do contato e telefone real. */
  contactName?: string | null;
  phone?: string | null;
};

/** Chamadas de voz: quem fala com o WhatsApp é o Call Service (Go) por trás da
 *  API — o dashboard nunca toca o serviço Go direto, passa sempre por aqui. */
export class CallsApi {
  constructor(private readonly http = new ApiClient()) {}
  start = (conversationId: string) => this.http.post<ActiveCall>('/api/v1/calls', { conversationId });
  active = () => this.http.get<{ calls: ActiveCall[] }>('/api/v1/calls/active');
  webrtc = (callId: string, sdpOffer: string) => this.http.post<{ sdpAnswer: string }>(`/api/v1/calls/${encodeURIComponent(callId)}/webrtc`, { sdpOffer });
  accept = (callId: string) => this.http.post<void>(`/api/v1/calls/${encodeURIComponent(callId)}/accept`);
  reject = (callId: string) => this.http.post<void>(`/api/v1/calls/${encodeURIComponent(callId)}/reject`);
  end = (callId: string) => this.http.delete(`/api/v1/calls/${encodeURIComponent(callId)}`);
  pairing = (signal?: AbortSignal) => this.http.get<CallPairingStatus>('/api/v1/calls/pairing', signal);
  startPairing = (name?: string) => this.http.post<CallPairingStatus>('/api/v1/calls/pairing', name ? { name } : {});
  history = (conversationId: string) => this.http.get<{ calls: CallHistoryEntry[] }>(`/api/v1/calls/history?conversationId=${encodeURIComponent(conversationId)}`);
  historyAll = () => this.http.get<{ calls: CallHistoryEntry[] }>('/api/v1/calls/history');
  /** A gravação desce como blob (o <audio> não manda os headers de contexto). */
  recordingBlob = (callId: string) => this.http.blob(`/api/v1/calls/${encodeURIComponent(callId)}/recording`);
}
