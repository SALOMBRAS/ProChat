import type { SessionStatus } from '@chatpro/contracts';
import type { WhatsAppSocket } from './whatsapp-socket.js';

export type CriticalOperation = 'connect' | 'disconnect' | 'logout' | 'remove';
export type RuntimeEntry = {
  workspaceId: string;
  sessionId: string;
  socket?: WhatsAppSocket;
  status: SessionStatus;
  reconnectAttempt: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  qrExpiryTimer?: ReturnType<typeof setTimeout>;
  qr?: { value: string; expiresAt: string };
  createdAt: string;
  statusChangedAt: string;
  operation?: CriticalOperation;
  manualStop: boolean;
  explicitLogout: boolean;
};

export class SessionRuntimeRegistry {
  private readonly entries = new Map<string, RuntimeEntry>();
  key(workspaceId: string, sessionId: string): string { return `${workspaceId}:${sessionId}`; }
  get(workspaceId: string, sessionId: string): RuntimeEntry | undefined { return this.entries.get(this.key(workspaceId, sessionId)); }
  set(entry: RuntimeEntry): void { this.entries.set(this.key(entry.workspaceId, entry.sessionId), entry); }
  delete(workspaceId: string, sessionId: string): void { this.entries.delete(this.key(workspaceId, sessionId)); }
  values(): RuntimeEntry[] { return [...this.entries.values()]; }
  begin(entry: RuntimeEntry, operation: CriticalOperation): boolean { if (entry.operation) return false; entry.operation = operation; return true; }
  finish(entry: RuntimeEntry): void { entry.operation = undefined; }
  cancelTimers(entry: RuntimeEntry): void {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.qrExpiryTimer) clearTimeout(entry.qrExpiryTimer);
    entry.reconnectTimer = undefined;
    entry.qrExpiryTimer = undefined;
    entry.qr = undefined;
  }
}
