import type { RoutingQueue, RoutingQueueMember } from '@chatpro/contracts';
import { ApiClient } from './client';
export class RoutingApi {
  constructor(private readonly http = new ApiClient()) {}
  queues=()=>this.http.get<RoutingQueue[]>('/api/v1/workspace/queues');
  create=(input: Partial<RoutingQueue> & { name: string })=>this.http.post<RoutingQueue>('/api/v1/workspace/queues', input);
  update=(id:string,input:Partial<RoutingQueue>)=>this.http.patch<RoutingQueue>(`/api/v1/workspace/queues/${encodeURIComponent(id)}`, input);
  members=(id:string)=>this.http.get<RoutingQueueMember[]>(`/api/v1/workspace/queues/${encodeURIComponent(id)}/members`);
  saveMember=(id:string,input:{userId:string;priorityWeight?:number;isAvailable?:boolean})=>this.http.post<RoutingQueueMember>(`/api/v1/workspace/queues/${encodeURIComponent(id)}/members`, input);
  removeMember=(id:string,userId:string)=>this.http.delete(`/api/v1/workspace/queues/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`);
}
