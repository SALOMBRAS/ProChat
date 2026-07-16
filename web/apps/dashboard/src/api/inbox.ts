import { ApiClient } from './client';
export type InboxConversation = { id:string; whatsappSessionId:string; chatId:string; contactId:string|null; status:'open'|'closed'; lastMessage:string|null; lastMessageAt:string; unreadCount:number; };
export type InboxMessage = { id:string; direction:'inbound'|'outbound'; content:string|null; timestamp:string; status:'received'|'sent'; messageType:string; chatId:string; metadata:Record<string,unknown>; };
export type Page<T> = { items:T[]; page:number; pageSize:number; total:number };
export class InboxApi {
  constructor(private readonly http = new ApiClient()) {}
  conversations=(page=1,pageSize=50)=>this.http.get<Page<InboxConversation>>(`/api/v1/inbox/conversations?page=${page}&pageSize=${pageSize}`);
  messages=(id:string,page=1,pageSize=100)=>this.http.get<Page<InboxMessage>>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/messages?page=${page}&pageSize=${pageSize}`);
  markRead=(id:string)=>this.http.post<void>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/read`);
}
