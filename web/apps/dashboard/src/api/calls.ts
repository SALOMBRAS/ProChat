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
}
