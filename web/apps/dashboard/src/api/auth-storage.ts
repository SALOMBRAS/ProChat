import type { WorkspaceUser } from '@chatpro/contracts';

export type AuthSession = { token: string; expiresAt: string; user: WorkspaceUser };

const STORAGE_KEY = 'chatpro.session';
/** Evento disparado quando a API responde 401 numa requisição autenticada — a
 *  UI escuta e volta para a tela de login. */
export const SESSION_EXPIRED_EVENT = 'chatpro:session-expired';

export function loadAuthSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as AuthSession;
    if (!session?.token || !session?.user || session.expiresAt <= new Date().toISOString()) { localStorage.removeItem(STORAGE_KEY); return null; }
    return session;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function saveAuthSession(session: AuthSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearAuthSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
