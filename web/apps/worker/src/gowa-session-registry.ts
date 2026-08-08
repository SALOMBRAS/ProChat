import { createHash } from 'node:crypto';

export type GowaSessionMapping = { workspaceId: string; sessionId: string; deviceId: string };

/** Runtime cache only. The durable source of truth is GowaSessionStore. */
export class GowaSessionRegistry {
  private readonly entries = new Map<string, GowaSessionMapping>();

  map(workspaceId: string, sessionId: string): GowaSessionMapping {
    const key = this.key(workspaceId, sessionId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 40);
    const mapping = { workspaceId, sessionId, deviceId: `chatpro-gowa-${digest}` };
    this.entries.set(key, mapping);
    return mapping;
  }

  restore(entries: readonly GowaSessionMapping[]): void {
    for (const entry of entries) this.entries.set(this.key(entry.workspaceId, entry.sessionId), { ...entry });
  }

  private key(workspaceId: string, sessionId: string): string { return `${workspaceId}\u0000${sessionId}`; }
}
