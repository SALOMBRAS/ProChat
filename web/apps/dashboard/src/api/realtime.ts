export type RealtimeEvent = { eventType: 'system.connected' | 'session.status.changed' | 'message.received' | 'message.sent' | 'message.reaction.updated' | 'conversation.updated' | 'conversation.management.updated' | 'conversation.context.updated' | 'conversation.sync.updated' | 'conversation.sla.updated' | 'conversation.kanban.moved' | 'kanban.stage.created' | 'kanban.stage.updated' | 'kanban.stage.reordered' | 'workspace.user.created' | 'workspace.user.updated' | 'workspace.team.created' | 'workspace.team.updated' | 'workspace.team.members.updated' | 'routing.queue.created' | 'routing.queue.updated' | 'routing.queue.members.updated' | 'conversation.routing.updated' | 'call.updated'; workspaceId: string; payload: Record<string, unknown> };

/**
 * Reconecta com backoff exponencial (1s dobrando até 15s): antes o socket
 * morria em silêncio na primeira queda e a inbox só voltava a atualizar no
 * refresh da página. `onReconnect` dispara quando uma reconexão tem sucesso —
 * é o momento de ressincronizar, porque eventos foram perdidos enquanto o
 * socket estava fora.
 */
export function connectRealtime(onEvent: (event: RealtimeEvent) => void, onReconnect?: () => void): () => void {
  if (typeof WebSocket === 'undefined') return () => undefined;
  const apiUrl = import.meta.env.VITE_API_URL || `${location.protocol}//${location.hostname}:3000`;
  const url = new URL(apiUrl.replace(/^http/, 'ws')); url.pathname = '/ws'; url.searchParams.set('workspaceId', import.meta.env.VITE_WORKSPACE_ID || 'default-workspace'); url.searchParams.set('userId', import.meta.env.VITE_USER_ID || '00000000-0000-4000-8000-000000000001');
  let socket: WebSocket | undefined;
  let closed = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    socket = new WebSocket(url);
    socket.onmessage = event => { try { const data = JSON.parse(String(event.data)) as RealtimeEvent; if (data && typeof data.eventType === 'string') onEvent(data); } catch { /* Ignore malformed realtime messages. */ } };
    socket.onopen = () => { const recovered = attempts > 0; attempts = 0; if (recovered) onReconnect?.(); };
    socket.onclose = () => { if (closed) return; attempts += 1; timer = setTimeout(open, Math.min(1_000 * 2 ** (attempts - 1), 15_000)); };
  };
  open();
  return () => { closed = true; if (timer) clearTimeout(timer); socket?.close(); };
}
