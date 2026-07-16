import { ApiClient, ApiError } from './client';
export type SessionStatus = 'disconnected' | 'connecting' | 'waiting_qr' | 'connected' | 'stopped' | 'error';
export interface Session { id:string; name:string; status:SessionStatus; createdAt?:string; updatedAt:string; }
export type SessionQr = { sessionId:string; qr:string; expiresAt:string };
export class SessionApiError extends ApiError {}
export class SessionsApi {
  private readonly http: ApiClient;
  constructor(fetcher?: typeof fetch, baseUrl?: string, timeoutMs?: number) { this.http = new ApiClient({ fetcher, baseUrl, timeoutMs }); }
  list=()=>this.http.get<Session[]>('/api/v1/sessions'); create=(name:string)=>this.http.post<Session>('/api/v1/sessions',{name}); status=(id:string)=>this.http.get<Session>(`/api/v1/sessions/${encodeURIComponent(id)}/status`); qr=(id:string)=>this.http.get<SessionQr>(`/api/v1/sessions/${encodeURIComponent(id)}/qr`); connect=(id:string,forceQrRefresh=false)=>this.http.post<void>(`/api/v1/sessions/${encodeURIComponent(id)}/connect`,{forceQrRefresh}); stop=(id:string)=>this.http.post<void>(`/api/v1/sessions/${encodeURIComponent(id)}/stop`); logout=(id:string)=>this.http.post<void>(`/api/v1/sessions/${encodeURIComponent(id)}/logout`); remove=(id:string)=>this.http.delete(`/api/v1/sessions/${encodeURIComponent(id)}`);
}
