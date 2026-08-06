import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import type { WorkspaceUser } from '@chatpro/contracts';
import type { SqliteDatabase } from '../persistence/database.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export type AuthSessionRow = { id: string; userId: string; workspaceId: string; tokenHash: string; createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null };
export type AuthStore = {
  findUserByEmail(workspaceId: string, email: string): Promise<WorkspaceUser | undefined>;
  getUser(workspaceId: string, id: string): Promise<WorkspaceUser | undefined>;
  countUsers(workspaceId: string): Promise<number>;
  createUser(user: WorkspaceUser): Promise<WorkspaceUser>;
  getPasswordHash(userId: string): Promise<string | undefined>;
  setPasswordHash(userId: string, passwordHash: string, updatedAt: string): Promise<void>;
  createSession(session: AuthSessionRow): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthSessionRow | undefined>;
  touchSession(id: string, lastUsedAt: string): Promise<void>;
  revokeSession(id: string, revokedAt: string): Promise<void>;
  revokeUserSessions(userId: string, revokedAt: string): Promise<void>;
};

const now = () => new Date().toISOString();
/** Formato `scrypt:saltB64:hashB64` — parâmetros padrão do Node são o
 *  equilíbrio documentado entre custo de brute-force e latência de login. */
export const hashPassword = (password: string) => { const salt = randomBytes(16); return `scrypt:${salt.toString('base64')}:${scryptSync(password, salt, 32).toString('base64')}`; };
export const verifyPassword = (password: string, stored: string) => {
  const [scheme, saltB64, hashB64] = stored.split(':');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const invalidCredentials = () => new AppError(401, 'UNAUTHORIZED', 'E-mail ou senha inválidos.');
const canManageUsers = (role: WorkspaceUser['role']) => role === 'owner' || role === 'admin';
export const MIN_PASSWORD_LENGTH = 8;

export class AuthService {
  constructor(private readonly store: AuthStore, private readonly sessionTtlHours = 168) {}

  async login(workspaceId: string, email: string, password: string): Promise<{ token: string; expiresAt: string; user: WorkspaceUser }> {
    const user = await this.store.findUserByEmail(workspaceId, email.toLowerCase());
    if (!user) throw invalidCredentials();
    if (user.status !== 'active') throw new AppError(403, 'FORBIDDEN', 'Este usuário está desativado. Peça a reativação a um administrador.');
    const stored = await this.store.getPasswordHash(user.id);
    if (!stored || !verifyPassword(password, stored)) throw invalidCredentials();
    const token = randomBytes(32).toString('base64url');
    const createdAt = now();
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 3_600_000).toISOString();
    await this.store.createSession({ id: randomUUID(), userId: user.id, workspaceId: user.workspaceId, tokenHash: hashToken(token), createdAt, expiresAt, lastUsedAt: createdAt, revokedAt: null });
    return { token, expiresAt, user };
  }

  async resolveSession(token: string): Promise<WorkspaceUser> {
    const session = await this.store.findSessionByTokenHash(hashToken(token));
    if (!session || session.revokedAt || session.expiresAt <= now()) throw new AppError(401, 'UNAUTHORIZED', 'Sessão inválida ou expirada. Faça login novamente.');
    const user = await this.store.getUser(session.workspaceId, session.userId);
    if (!user || user.status !== 'active') throw new AppError(401, 'UNAUTHORIZED', 'Sessão inválida ou expirada. Faça login novamente.');
    await this.store.touchSession(session.id, now());
    return user;
  }

  async logout(token: string): Promise<void> {
    const session = await this.store.findSessionByTokenHash(hashToken(token));
    if (session && !session.revokedAt) await this.store.revokeSession(session.id, now());
  }

  async changePassword(user: WorkspaceUser, currentPassword: string, newPassword: string): Promise<void> {
    this.assertPasswordStrength(newPassword);
    const stored = await this.store.getPasswordHash(user.id);
    if (!stored || !verifyPassword(currentPassword, stored)) throw invalidCredentials();
    await this.store.setPasswordHash(user.id, hashPassword(newPassword), now());
    await this.store.revokeUserSessions(user.id, now());
  }

  /** Senha definida por um admin (criação de colaborador ou reset). Não exige a
   *  senha antiga, mas derruba as sessões do alvo para não deixar token velho
   *  vivo depois de um reset. */
  async adminSetPassword(actor: WorkspaceUser, workspaceId: string, targetUserId: string, newPassword: string): Promise<void> {
    if (!canManageUsers(actor.role)) throw new AppError(403, 'FORBIDDEN', 'Apenas proprietários e administradores podem definir senhas.');
    this.assertPasswordStrength(newPassword);
    const target = await this.store.getUser(workspaceId, targetUserId);
    if (!target) throw new AppError(404, 'NOT_FOUND', 'Usuário não encontrado neste workspace.');
    if (target.role === 'owner' && actor.role !== 'owner' && actor.id !== target.id) throw new AppError(403, 'FORBIDDEN', 'Apenas o proprietário pode alterar a senha de outro proprietário.');
    await this.store.setPasswordHash(target.id, hashPassword(newPassword), now());
    await this.store.revokeUserSessions(target.id, now());
  }

  /** Primeiro acesso: cria o owner inicial quando o workspace ainda não tem
   *  nenhum usuário. Só roda quando o env trouxe e-mail e senha — sem eles o
   *  boot não inventa credencial. */
  async bootstrapOwner(workspaceId: string, email: string, password: string, displayName = 'Proprietário'): Promise<WorkspaceUser | undefined> {
    if (await this.store.countUsers(workspaceId) > 0) return undefined;
    this.assertPasswordStrength(password);
    const timestamp = now();
    const user = await this.store.createUser({ id: randomUUID(), workspaceId, email: email.toLowerCase(), displayName, avatarUrl: null, role: 'owner', status: 'active', createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp });
    await this.store.setPasswordHash(user.id, hashPassword(password), timestamp);
    return user;
  }

  private assertPasswordStrength(password: string) {
    if (password.length < MIN_PASSWORD_LENGTH) throw new AppError(400, 'VALIDATION_ERROR', `A senha precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
}

type SqliteUserRow = WorkspaceUser;
type SqliteSessionRow = AuthSessionRow;

export class SqliteAuthStore implements AuthStore {
  constructor(private readonly db: SqliteDatabase) {}
  async findUserByEmail(workspaceId: string, email: string) { return this.db.prepare('SELECT id, workspaceId, email, displayName, avatarUrl, role, status, createdAt, updatedAt, lastSeenAt FROM workspace_users WHERE workspaceId = ? AND email = ?').get(workspaceId, email) as SqliteUserRow | undefined; }
  async getUser(workspaceId: string, id: string) { return this.db.prepare('SELECT id, workspaceId, email, displayName, avatarUrl, role, status, createdAt, updatedAt, lastSeenAt FROM workspace_users WHERE workspaceId = ? AND id = ?').get(workspaceId, id) as SqliteUserRow | undefined; }
  async countUsers(workspaceId: string) { return (this.db.prepare('SELECT count(*) total FROM workspace_users WHERE workspaceId = ?').get(workspaceId) as { total: number }).total; }
  async createUser(user: WorkspaceUser) { this.db.prepare('INSERT INTO workspace_users (id, workspaceId, email, displayName, avatarUrl, role, status, createdAt, updatedAt, lastSeenAt) VALUES (@id,@workspaceId,@email,@displayName,@avatarUrl,@role,@status,@createdAt,@updatedAt,@lastSeenAt)').run(user); return user; }
  async getPasswordHash(userId: string) { return (this.db.prepare('SELECT passwordHash FROM auth_credentials WHERE userId = ?').get(userId) as { passwordHash: string } | undefined)?.passwordHash; }
  async setPasswordHash(userId: string, passwordHash: string, updatedAt: string) { this.db.prepare('INSERT INTO auth_credentials (userId, passwordHash, createdAt, updatedAt) VALUES (@userId, @passwordHash, @updatedAt, @updatedAt) ON CONFLICT(userId) DO UPDATE SET passwordHash=excluded.passwordHash, updatedAt=excluded.updatedAt').run({ userId, passwordHash, updatedAt }); }
  async createSession(session: AuthSessionRow) { this.db.prepare('INSERT INTO auth_sessions (id, userId, workspaceId, tokenHash, createdAt, expiresAt, lastUsedAt, revokedAt) VALUES (@id, @userId, @workspaceId, @tokenHash, @createdAt, @expiresAt, @lastUsedAt, @revokedAt)').run(session); }
  async findSessionByTokenHash(tokenHash: string) { return this.db.prepare('SELECT id, userId, workspaceId, tokenHash, createdAt, expiresAt, lastUsedAt, revokedAt FROM auth_sessions WHERE tokenHash = ?').get(tokenHash) as SqliteSessionRow | undefined; }
  async touchSession(id: string, lastUsedAt: string) { this.db.prepare('UPDATE auth_sessions SET lastUsedAt = ? WHERE id = ?').run(lastUsedAt, id); }
  async revokeSession(id: string, revokedAt: string) { this.db.prepare('UPDATE auth_sessions SET revokedAt = ? WHERE id = ?').run(revokedAt, id); }
  async revokeUserSessions(userId: string, revokedAt: string) { this.db.prepare('UPDATE auth_sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL').run(revokedAt, userId); }
}

const userFromRow = (row: Record<string, any>): WorkspaceUser => ({ id: row.id, workspaceId: row.workspace_id, email: row.email, displayName: row.display_name, avatarUrl: row.avatar_url, role: row.role, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastSeenAt: row.last_seen_at });
const sessionFromRow = (row: Record<string, any>): AuthSessionRow => ({ id: row.id, userId: row.user_id, workspaceId: row.workspace_id, tokenHash: row.token_hash, createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at });

export class SupabaseAuthStore implements AuthStore {
  constructor(private readonly client: SupabaseClient) {}
  async findUserByEmail(workspaceId: string, email: string) { const { data, error } = await this.client.from('workspace_users').select('*').eq('workspace_id', workspaceId).eq('email', email).maybeSingle(); if (error) throw error; return data ? userFromRow(data) : undefined; }
  async getUser(workspaceId: string, id: string) { const { data, error } = await this.client.from('workspace_users').select('*').eq('workspace_id', workspaceId).eq('id', id).maybeSingle(); if (error) throw error; return data ? userFromRow(data) : undefined; }
  async countUsers(workspaceId: string) { const { count, error } = await this.client.from('workspace_users').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId); if (error) throw error; return count ?? 0; }
  async createUser(user: WorkspaceUser) { const { error } = await this.client.from('workspace_users').insert({ id: user.id, workspace_id: user.workspaceId, email: user.email, display_name: user.displayName, avatar_url: user.avatarUrl, role: user.role, status: user.status, created_at: user.createdAt, updated_at: user.updatedAt, last_seen_at: user.lastSeenAt }); if (error) throw error; return user; }
  async getPasswordHash(userId: string) { const { data, error } = await this.client.from('auth_credentials').select('password_hash').eq('user_id', userId).maybeSingle(); if (error) throw error; return data?.password_hash as string | undefined; }
  async setPasswordHash(userId: string, passwordHash: string, updatedAt: string) { const { error } = await this.client.from('auth_credentials').upsert({ user_id: userId, password_hash: passwordHash, updated_at: updatedAt }); if (error) throw error; }
  async createSession(session: AuthSessionRow) { const { error } = await this.client.from('auth_sessions').insert({ id: session.id, user_id: session.userId, workspace_id: session.workspaceId, token_hash: session.tokenHash, created_at: session.createdAt, expires_at: session.expiresAt, last_used_at: session.lastUsedAt, revoked_at: session.revokedAt }); if (error) throw error; }
  async findSessionByTokenHash(tokenHash: string) { const { data, error } = await this.client.from('auth_sessions').select('*').eq('token_hash', tokenHash).maybeSingle(); if (error) throw error; return data ? sessionFromRow(data) : undefined; }
  async touchSession(id: string, lastUsedAt: string) { const { error } = await this.client.from('auth_sessions').update({ last_used_at: lastUsedAt }).eq('id', id); if (error) throw error; }
  async revokeSession(id: string, revokedAt: string) { const { error } = await this.client.from('auth_sessions').update({ revoked_at: revokedAt }).eq('id', id); if (error) throw error; }
  async revokeUserSessions(userId: string, revokedAt: string) { const { error } = await this.client.from('auth_sessions').update({ revoked_at: revokedAt }).eq('user_id', userId).is('revoked_at', null); if (error) throw error; }
}
