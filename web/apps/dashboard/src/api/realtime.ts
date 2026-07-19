export type RealtimeEvent = { eventType: 'system.connected' | 'session.status.changed' | 'message.received' | 'message.sent' | 'conversation.updated' | 'conversation.management.updated' | 'conversation.context.updated' | 'conversation.sync.updated'; workspaceId: string; payload: Record<string, unknown> };
export function connectRealtime(onEvent: (event: RealtimeEvent) => void): () => void {
  if (typeof WebSocket === 'undefined') return () => undefined;
  const apiUrl = import.meta.env.VITE_API_URL || `${location.protocol}//${location.hostname}:3000`;
  const url = new URL(apiUrl.replace(/^http/, 'ws')); url.pathname = '/ws'; url.searchParams.set('workspaceId', import.meta.env.VITE_WORKSPACE_ID || 'default-workspace'); url.searchParams.set('userId', import.meta.env.VITE_USER_ID || '00000000-0000-4000-8000-000000000001');
  const socket = new WebSocket(url);
  socket.onmessage = event => { try { const data = JSON.parse(String(event.data)) as RealtimeEvent; if (data && typeof data.eventType === 'string') onEvent(data); } catch { /* Ignore malformed realtime messages. */ } };
  return () => socket.close();
}
