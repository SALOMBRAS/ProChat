import { ApiClient } from './client';
import type { InboxConversation as SharedInboxConversation, InboxMessage as SharedInboxMessage } from '@chatpro/contracts';
export type InboxConversation = SharedInboxConversation;
export type InboxMessage = SharedInboxMessage;
export type Page<T> = { items:T[]; page:number; pageSize:number; total:number };
export type ConversationContext = { notes: string | null; tags: string[]; firstInteractionAt: string; lastInteractionAt: string };
export type HistorySyncJob = { id: string; wahaSession: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; chatsProcessed: number; messagesProcessed: number; lastErrorSafe: string | null };
export class InboxApi {
  constructor(private readonly http = new ApiClient()) {}
  conversations=(page=1,pageSize=50)=>this.http.get<Page<InboxConversation>>(`/api/v1/inbox/conversations?page=${page}&pageSize=${pageSize}`);
  messages=(id:string,page=1,pageSize=100)=>this.http.get<Page<InboxMessage>>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/messages?page=${page}&pageSize=${pageSize}`);
  sendMessage=(id:string,text:string)=>this.http.post<InboxMessage>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/messages`, { text });
  markRead=(id:string)=>this.http.post<void>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/read`);
  context=(id:string)=>this.http.get<ConversationContext>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/context`);
  updateContext=(id:string, input: { notes?: string; tags?: string[] })=>this.http.patch<ConversationContext>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/context`, input);
  startSync=(wahaSession?:string)=>this.http.post<HistorySyncJob>('/api/v1/inbox/sync/start', wahaSession ? { wahaSession } : {});
  syncStatus=(wahaSession:string)=>this.http.get<HistorySyncJob>(`/api/v1/inbox/sync/status?wahaSession=${encodeURIComponent(wahaSession)}`);
  cancelSync=(wahaSession:string)=>this.http.post<HistorySyncJob>('/api/v1/inbox/sync/cancel', { wahaSession });
}
