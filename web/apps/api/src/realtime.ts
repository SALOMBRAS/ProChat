import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@chatpro/contracts';
import { log } from './logging.js';

export type RealtimeSocket = { readyState: number; send(data: string): void };

/** Escopo de visibilidade de um listener: papel e times do usuário no
 *  workspace. `undefined` = usuário fora do diretório — tratado como agent sem
 *  times, o mesmo fallback restritivo do `ConversationVisibilityService`. */
export type ListenerScope = { role: string; teamIds: string[] } | undefined;
export type ScopeResolver = (workspaceId: string, userId: string) => Promise<ListenerScope>;

/** Recorte de entrega de um evento de conversa: departamento e responsável no
 *  momento da publicação. `conversationTeamId` nulo = conversa sem
 *  departamento — por decisão de produto ela é de todos (fail-open). */
export type RealtimeAudience = { conversationTeamId?: string | null; conversationAssignedUserId?: string | null };

/** TTL curto do escopo em cache: papel e vínculos mudam sem derrubar o socket,
 *  então expira rápido — e é o cache que impede uma consulta ao diretório por
 *  evento publicado. */
const scopeTtlMs = 30_000;

type Listener = { workspaceId: string; userId?: string; cached?: { expiresAt: number; scope: Promise<ListenerScope> } };

/** Monta o recorte de entrega a partir da conversa já carregada no fluxo. */
export const conversationAudience = (conversation: { assignedTeamId: string | null; assignedUserId: string | null }): RealtimeAudience => ({ conversationTeamId: conversation.assignedTeamId ?? null, conversationAssignedUserId: conversation.assignedUserId ?? null });

export class RealtimeHub {
  private readonly sockets = new Map<RealtimeSocket, Listener>();
  constructor(private resolveScope?: ScopeResolver) {}
  setScopeResolver(resolveScope: ScopeResolver): void { this.resolveScope = resolveScope; }
  add(socket: RealtimeSocket, workspaceId: string, userId?: string): void { this.sockets.set(socket, { workspaceId, userId }); log('info', 'Realtime listener registered', { workspaceId, listenersActive: this.listenersFor(workspaceId), listenersTotal: this.sockets.size }); }
  remove(socket: RealtimeSocket): void { const listener = this.sockets.get(socket); this.sockets.delete(socket); log('info', 'Realtime listener removed', { workspaceId: listener?.workspaceId ?? null, listenersActive: listener ? this.listenersFor(listener.workspaceId) : 0, listenersTotal: this.sockets.size }); }
  publish(workspaceId: string, eventType: EventEnvelope['eventType'], payload: Record<string, unknown>, audience?: RealtimeAudience, correlationId = randomUUID()): void {
    const event: EventEnvelope = { eventId: randomUUID(), eventType, workspaceId, timestamp: new Date().toISOString(), correlationId, payload };
    log('info', 'Realtime event emitted', { correlationId, workspaceId, eventId: event.eventId, eventType, listenersActive: this.listenersFor(workspaceId), listenersTotal: this.sockets.size });
    const data = JSON.stringify(event);
    for (const [socket, listener] of this.sockets) {
      if (listener.workspaceId !== workspaceId || socket.readyState !== 1) continue;
      // Sem recorte, sem resolvedor ou sem usuário identificado: broadcast normal.
      if (!audience || !this.resolveScope || !listener.userId) { socket.send(data); continue; }
      void this.deliver(socket, listener, audience, data);
    }
  }
  /** Entrega filtrada por departamento: aguarda o escopo (cache de 30 s) e
   *  aplica a regra da Inbox — privilegiados recebem tudo; agent recebe
   *  conversa sem time, do time dele ou atribuída a ele. Falha na resolução é
   *  fail-closed (não entrega) e derruba o cache para a próxima tentativa. */
  private async deliver(socket: RealtimeSocket, listener: Listener, audience: RealtimeAudience, data: string): Promise<void> {
    let scope: ListenerScope;
    try { scope = await this.scopeOf(listener); } catch (error) { listener.cached = undefined; log('error', 'Realtime scope resolution failed', { workspaceId: listener.workspaceId, error: error instanceof Error ? error.stack ?? error.message : String(error) }); return; }
    if (!allowsListener(scope, listener.userId!, audience)) return;
    if (this.sockets.get(socket) !== listener || socket.readyState !== 1) return;
    socket.send(data);
  }
  private scopeOf(listener: Listener): Promise<ListenerScope> {
    if (listener.cached && listener.cached.expiresAt > Date.now()) return listener.cached.scope;
    const scope = this.resolveScope!(listener.workspaceId, listener.userId!);
    listener.cached = { expiresAt: Date.now() + scopeTtlMs, scope };
    return scope;
  }
  private listenersFor(workspaceId: string): number { return [...this.sockets].filter(([socket, listener]) => listener.workspaceId === workspaceId && socket.readyState === 1).length; }
}

/** A mesma regra do `allowsConversation` da Inbox, sobre o recorte do evento. */
export function allowsListener(scope: ListenerScope, userId: string, audience: RealtimeAudience): boolean {
  if (scope && scope.role !== 'agent') return true;
  return !audience.conversationTeamId || (scope?.teamIds ?? []).includes(audience.conversationTeamId) || audience.conversationAssignedUserId === userId;
}
