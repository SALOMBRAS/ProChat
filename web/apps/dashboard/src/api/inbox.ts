import { ApiClient } from './client';
import type { InboxConversation as SharedInboxConversation, InboxMessage as SharedInboxMessage, InboxOutboxJob } from '@chatpro/contracts';
export type InboxConversation = SharedInboxConversation;
export type InboxMessage = SharedInboxMessage;
export type Page<T> = { items:T[]; page:number; pageSize:number; total:number };
export type ConversationContext = { notes: string | null; tags: string[]; firstInteractionAt: string; lastInteractionAt: string };
export type HistorySyncJob = { id: string; jobId: string; wahaSession: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; chatsProcessed: number; messagesProcessed: number; currentChat: string | null; hasMore: boolean; progressLabel: string; lastErrorSafe: string | null; updatedAt: string };
export type ConversationStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'archived';
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ConversationEvent = { id: string; conversationId: string; workspaceId: string; userId: string; action: 'assigned' | 'unassigned' | 'status_changed' | 'priority_changed' | 'archived' | 'reopened'; previousValue: string | null; newValue: string | null; createdAt: string };
export type ConversationManagementResult = { conversation: InboxConversation; event: ConversationEvent | null; changed: boolean };
export class InboxApi {
  constructor(private readonly http = new ApiClient()) {}
  conversations=(page=1,pageSize=50)=>this.http.get<Page<InboxConversation>>(`/api/v1/inbox/conversations?page=${page}&pageSize=${pageSize}`);
  messages=(id:string,page=1,pageSize=100)=>this.http.get<Page<InboxMessage>>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/messages?page=${page}&pageSize=${pageSize}`);
  sendMessage=(id:string,text:string)=>this.http.post<InboxMessage>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/messages`, { text });
  sendAttachment=(id:string,file:File,clientRequestId:string,caption?:string)=>{ const body = new FormData(); body.set('file', file); body.set('clientRequestId', clientRequestId); if (caption?.trim()) body.set('caption', caption.trim()); return this.http.postForm<InboxOutboxJob>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/attachments`, body); };
  outbox=(jobId:string)=>this.http.get<InboxOutboxJob>(`/api/v1/inbox/outbox/${encodeURIComponent(jobId)}`);
  cancelOutbox=(jobId:string)=>this.http.post<InboxOutboxJob>(`/api/v1/inbox/outbox/${encodeURIComponent(jobId)}/cancel`);
  markRead=(id:string)=>this.http.post<void>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/read`);
  context=(id:string)=>this.http.get<ConversationContext>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/context`);
  updateContext=(id:string, input: { notes?: string; tags?: string[] })=>this.http.patch<ConversationContext>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/context`, input);
  assign=(id:string,userId?:string|null)=>this.http.post<ConversationManagementResult>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/assign`, userId === undefined ? {} : { userId });
  assignTeam=(id:string,teamId:string|null)=>this.http.post<ConversationManagementResult>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/assign`, { teamId });
  unassign=(id:string)=>this.http.post<ConversationManagementResult>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/unassign`);
  moveToQueue=(id:string,queueId:string|null)=>this.http.post<ConversationManagementResult>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/queue`, { queueId });
  redistribute=(id:string)=>this.http.post<ConversationManagementResult>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/redistribute`);
  updateStatus=(id:string,status:ConversationStatus)=>this.http.patch<ConversationManagementResult>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/status`, { status });
  updatePriority=(id:string,priority:ConversationPriority)=>this.http.patch<ConversationManagementResult>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/priority`, { priority });
  activity=(id:string)=>this.http.get<ConversationEvent[]>(`/api/v1/inbox/conversations/${encodeURIComponent(id)}/activity`);
  startSync=(wahaSession?:string)=>this.http.post<HistorySyncJob>('/api/v1/inbox/sync/start', wahaSession ? { wahaSession } : {});
  syncStatus=(wahaSession:string)=>this.http.get<HistorySyncJob>(`/api/v1/inbox/sync/status?wahaSession=${encodeURIComponent(wahaSession)}`);
  cancelSync=(wahaSession:string)=>this.http.post<HistorySyncJob>('/api/v1/inbox/sync/cancel', { wahaSession });
}
