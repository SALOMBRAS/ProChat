import { access, mkdir, readdir, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { safeIdentifierSchema } from '@chatpro/contracts';
import type { CredentialStorePort } from './ports.js';

export class FileSystemCredentialStoreAdapter implements CredentialStorePort {
  readonly root: string;
  constructor(dataDir: string) { this.root = path.resolve(dataDir); }

  authDirectory(workspaceId: string, sessionId: string): string {
    safeIdentifierSchema.parse(workspaceId);
    safeIdentifierSchema.parse(sessionId);
    const target = path.resolve(this.root, 'workspaces', workspaceId, 'whatsapp', 'sessions', sessionId, 'auth');
    const expectedParent = path.resolve(this.root, 'workspaces') + path.sep;
    if (!target.startsWith(expectedParent)) throw new Error('Credential path escaped data directory');
    return target;
  }

  async prepareAuthDirectory(workspaceId: string, sessionId: string): Promise<string> {
    const target = this.authDirectory(workspaceId, sessionId);
    await mkdir(target, { recursive: true });
    return target;
  }

  async hasAuthDirectory(workspaceId: string, sessionId: string): Promise<boolean> {
    try { await access(this.authDirectory(workspaceId, sessionId)); return true; } catch { return false; }
  }

  async removeAuthDirectory(workspaceId: string, sessionId: string): Promise<void> {
    const authDir = this.authDirectory(workspaceId, sessionId);
    await rm(authDir, { recursive: true, force: true });
    await rm(path.dirname(authDir), { recursive: false, force: true }).catch(() => undefined);
  }

  async discoverSessions(): Promise<Array<{ workspaceId: string; sessionId: string }>> {
    const workspacesRoot = path.join(this.root, 'workspaces');
    let workspaces: Dirent<string>[];
    try { workspaces = await readdir(workspacesRoot, { withFileTypes: true }); } catch { return []; }
    const found: Array<{ workspaceId: string; sessionId: string }> = [];
    for (const workspace of workspaces) {
      if (!workspace.isDirectory() || !safeIdentifierSchema.safeParse(workspace.name).success) continue;
      const sessionsRoot = path.join(workspacesRoot, workspace.name, 'whatsapp', 'sessions');
      let sessions: Dirent<string>[];
      try { sessions = await readdir(sessionsRoot, { withFileTypes: true }); } catch { continue; }
      for (const session of sessions) {
        if (!session.isDirectory() || !safeIdentifierSchema.safeParse(session.name).success) continue;
        if (await this.hasAuthDirectory(workspace.name, session.name)) found.push({ workspaceId: workspace.name, sessionId: session.name });
      }
    }
    return found;
  }
}
