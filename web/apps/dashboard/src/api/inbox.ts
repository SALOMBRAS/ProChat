import { ApiClient } from './client';
import type { InboxConversation as SharedInboxConversation, InboxMessage as SharedInboxMessage } from '@chatpro/contracts';
export type InboxConversation = SharedInboxConversation;
export type InboxMessage = SharedInboxMessage;
export type Page<T> = { items:T[]; page:number; pageSize:number; total:number };
export class InboxApi {
  constructor(private readonly http = new ApiClient()) {}
  conversations=(page=1,pageSize=50)=>this.http.get<Page<InboxConversation>>(`/api/v1/inbox/conversations?page=${page}&pageSize=${pageSize}`);
  messages=(id:string,page=1,pageSize=100)=>this.http.get<Page<InboxMessage>>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/messages?page=${page}&pageSize=${pageSize}`);
  sendMessage=(id:string,text:string)=>this.http.post<InboxMessage>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/messages`, { text });
  markRead=(id:string)=>this.http.post<void>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/read`);
}
