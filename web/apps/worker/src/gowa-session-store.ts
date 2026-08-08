import { randomUUID } from 'node:crypto';
import type { SessionStatus } from '@chatpro/contracts';
import type { SqliteDatabase } from '../../api/src/persistence/database.js';

export type GowaReconciliationState = 'healthy' | 'missing' | 'unverified';
export type GowaSessionLink = {
  id: string;
  workspaceId: string;
  provider: 'gowa';
  sessionId: string;
  sessionName: string;
  providerDeviceId: string;
  providerStatus: string;
  chatproStatus: SessionStatus;
  capabilities: string[];
  providerMetadata: Record<string, unknown>;
  reconciliationState: GowaReconciliationState;
  createdAt: string;
  updatedAt: string;
  lastReconciledAt: string | null;
};

export type GowaSessionStore = {
  save(link: GowaSessionLink): Promise<GowaSessionLink>;
  list(): Promise<GowaSessionLink[]>;
  updateObservation(link: Pick<GowaSessionLink, 'workspaceId' | 'sessionId' | 'providerStatus' | 'chatproStatus' | 'reconciliationState' | 'lastReconciledAt'>): Promise<void>;
  close(): Promise<void> | void;
};

type DatabaseRow = {
  id: string; workspaceId: string; provider: 'gowa'; sessionId: string; sessionName: string; providerDeviceId: string; providerStatus: string; chatproStatus: SessionStatus; capabilitiesJson: string; providerMetadataJson: string; reconciliationState: GowaReconciliationState; createdAt: string; updatedAt: string; lastReconciledAt: string | null;
};

/** Test-friendly store. Production uses one of the durable adapters below. */
export class InMemoryGowaSessionStore implements GowaSessionStore {
  private readonly links = new Map<string, GowaSessionLink>();
  async save(link: GowaSessionLink): Promise<GowaSessionLink> { const copy = clone(link); this.links.set(key(copy.workspaceId, copy.sessionId), copy); return clone(copy); }
  async list(): Promise<GowaSessionLink[]> { return [...this.links.values()].map(clone); }
  async updateObservation(input: Pick<GowaSessionLink, 'workspaceId' | 'sessionId' | 'providerStatus' | 'chatproStatus' | 'reconciliationState' | 'lastReconciledAt'>): Promise<void> {
    const existing = this.links.get(key(input.workspaceId, input.sessionId));
    if (!existing) return;
    this.links.set(key(input.workspaceId, input.sessionId), { ...existing, ...input, updatedAt: new Date().toISOString() });
  }
  close(): void {}
}

export class SqliteGowaSessionStore implements GowaSessionStore {
  constructor(private readonly database: SqliteDatabase, private readonly onClose: () => void = () => undefined) {}

  async save(link: GowaSessionLink): Promise<GowaSessionLink> {
    const value = sanitize(link);
    this.database.prepare(`INSERT INTO whatsapp_provider_sessions (id,workspaceId,provider,sessionId,sessionName,providerDeviceId,providerStatus,chatproStatus,capabilitiesJson,providerMetadataJson,reconciliationState,createdAt,updatedAt,lastReconciledAt) VALUES (@id,@workspaceId,@provider,@sessionId,@sessionName,@providerDeviceId,@providerStatus,@chatproStatus,@capabilitiesJson,@providerMetadataJson,@reconciliationState,@createdAt,@updatedAt,@lastReconciledAt) ON CONFLICT(workspaceId,provider,sessionId) DO UPDATE SET sessionName=excluded.sessionName,providerDeviceId=excluded.providerDeviceId,providerStatus=excluded.providerStatus,chatproStatus=excluded.chatproStatus,capabilitiesJson=excluded.capabilitiesJson,providerMetadataJson=excluded.providerMetadataJson,reconciliationState=excluded.reconciliationState,updatedAt=excluded.updatedAt,lastReconciledAt=excluded.lastReconciledAt`).run(toRow(value));
    return value;
  }

  async list(): Promise<GowaSessionLink[]> {
    return this.database.prepare(`SELECT * FROM whatsapp_provider_sessions WHERE provider='gowa' ORDER BY createdAt`).all().map(row => fromRow(row as DatabaseRow));
  }

  async updateObservation(input: Pick<GowaSessionLink, 'workspaceId' | 'sessionId' | 'providerStatus' | 'chatproStatus' | 'reconciliationState' | 'lastReconciledAt'>): Promise<void> {
    this.database.prepare(`UPDATE whatsapp_provider_sessions SET providerStatus=?,chatproStatus=?,reconciliationState=?,lastReconciledAt=?,updatedAt=? WHERE workspaceId=? AND provider='gowa' AND sessionId=?`).run(input.providerStatus, input.chatproStatus, input.reconciliationState, input.lastReconciledAt, new Date().toISOString(), input.workspaceId, input.sessionId);
  }

  close(): void { this.onClose(); }
}

type SupabaseRow = Record<string, unknown>;
type SupabaseClientLike = {
  from(table: string): {
    upsert(value: SupabaseRow, options: { onConflict: string }): { select(): { single(): Promise<{ data: SupabaseRow | null; error: { message: string } | null }> } };
    select(): { eq(column: string, value: string): { order(column: string): Promise<{ data: SupabaseRow[] | null; error: { message: string } | null }> } };
    update(value: SupabaseRow): { eq(column: string, value: string): { eq(column: string, value: string): { eq(column: string, value: string): Promise<{ error: { message: string } | null }> } } };
  };
};

export class SupabaseGowaSessionStore implements GowaSessionStore {
  constructor(private readonly client: SupabaseClientLike) {}

  async save(link: GowaSessionLink): Promise<GowaSessionLink> {
    const value = sanitize(link);
    const { data, error } = await this.client.from('whatsapp_provider_sessions').upsert(toSupabaseRow(value), { onConflict: 'workspace_id,provider,session_id' }).select().single();
    if (error || !data) throw new Error('Supabase GOWA session persistence failed');
    return fromSupabaseRow(data);
  }

  async list(): Promise<GowaSessionLink[]> {
    const { data, error } = await this.client.from('whatsapp_provider_sessions').select().eq('provider', 'gowa').order('created_at');
    if (error) throw new Error('Supabase GOWA session lookup failed');
    return (data ?? []).map(fromSupabaseRow);
  }

  async updateObservation(input: Pick<GowaSessionLink, 'workspaceId' | 'sessionId' | 'providerStatus' | 'chatproStatus' | 'reconciliationState' | 'lastReconciledAt'>): Promise<void> {
    const { error } = await this.client.from('whatsapp_provider_sessions').update({ provider_status: input.providerStatus, chatpro_status: input.chatproStatus, reconciliation_state: input.reconciliationState, last_reconciled_at: input.lastReconciledAt, updated_at: new Date().toISOString() }).eq('workspace_id', input.workspaceId).eq('provider', 'gowa').eq('session_id', input.sessionId);
    if (error) throw new Error('Supabase GOWA session update failed');
  }

  close(): void {}
}

export async function createGowaSessionStore(config: { databaseProvider?: 'sqlite' | 'supabase'; databasePath?: string; supabaseUrl?: string; supabaseServiceRoleKey?: string }): Promise<GowaSessionStore> {
  if (config.databaseProvider === 'supabase') {
    const { createSupabasePersistenceClient } = await import('../../api/src/persistence/supabase.js');
    return new SupabaseGowaSessionStore(createSupabasePersistenceClient({ supabaseUrl: config.supabaseUrl, supabaseServiceRoleKey: config.supabaseServiceRoleKey }) as unknown as SupabaseClientLike);
  }
  if (!config.databasePath) throw new Error('CHATPRO_DATABASE_PATH is required for persistent GOWA sessions with SQLite');
  const { SqlitePersistenceDatabase } = await import('../../api/src/persistence/database.js');
  const database = new SqlitePersistenceDatabase(config.databasePath);
  // The API owns the schema. The worker used to call migrate() on this same
  // file, and both processes start together in local-runtime.mjs: measured on
  // this machine, 5 of 6 boots lost the race, half to SQLITE_BUSY and half to
  // the read-then-apply window ("duplicate column name") that opens because
  // each process reads schema_migrations before applying. Whoever lost threw
  // out of startup. Validating instead of migrating removes the second writer.
  try { assertGowaSchema(database.sqlite); } catch (error) { database.close(); throw error; }
  return new SqliteGowaSessionStore(database.sqlite, () => database.close());
}

/**
 * Read-only schema guard. It never creates or alters anything: a worker that
 * cannot find the table must stop and say so, not repair a database it does
 * not own. The API applies `026_whatsapp_provider_sessions.sql` on its own
 * startup, so the fix for this error is to start the API once, not to run SQL.
 */
export function assertGowaSchema(database: SqliteDatabase): void {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_provider_sessions'").get();
  if (!table) throw new Error('Table whatsapp_provider_sessions is missing. The API owns the schema and applies it at startup: start the API once against this CHATPRO_DATABASE_PATH before starting the worker with WHATSAPP_PROVIDER=gowa.');
}

export function newGowaSessionLink(input: Omit<GowaSessionLink, 'id' | 'createdAt' | 'updatedAt'>): GowaSessionLink {
  const now = new Date().toISOString();
  return sanitize({ ...input, id: randomUUID(), createdAt: now, updatedAt: now });
}

function toRow(link: GowaSessionLink): DatabaseRow { return { ...link, capabilitiesJson: JSON.stringify(link.capabilities), providerMetadataJson: JSON.stringify(link.providerMetadata) }; }
function fromRow(row: DatabaseRow): GowaSessionLink { return sanitize({ ...row, capabilities: parseArray(row.capabilitiesJson), providerMetadata: parseObject(row.providerMetadataJson) }); }
function toSupabaseRow(link: GowaSessionLink): SupabaseRow { return { id: link.id, workspace_id: link.workspaceId, provider: link.provider, session_id: link.sessionId, session_name: link.sessionName, provider_device_id: link.providerDeviceId, provider_status: link.providerStatus, chatpro_status: link.chatproStatus, capabilities_json: link.capabilities, provider_metadata_json: link.providerMetadata, reconciliation_state: link.reconciliationState, created_at: link.createdAt, updated_at: link.updatedAt, last_reconciled_at: link.lastReconciledAt }; }
function fromSupabaseRow(row: SupabaseRow): GowaSessionLink { return sanitize({ id: string(row.id), workspaceId: string(row.workspace_id), provider: 'gowa', sessionId: string(row.session_id), sessionName: string(row.session_name), providerDeviceId: string(row.provider_device_id), providerStatus: string(row.provider_status), chatproStatus: status(row.chatpro_status), capabilities: array(row.capabilities_json), providerMetadata: object(row.provider_metadata_json), reconciliationState: reconciliation(row.reconciliation_state), createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), lastReconciledAt: row.last_reconciled_at === null || row.last_reconciled_at === undefined ? null : instant(row.last_reconciled_at) }); }
/**
 * PostgREST renders `timestamptz` with an offset — `2026-07-20T13:30:04.508+00:00`
 * — and the shared contract uses `z.string().datetime()`, which accepts only a
 * `Z` suffix. Left raw, every restored session failed `whatsAppSessionSchema`
 * and the worker died on its second boot, once a row existed. Normalising at
 * the row boundary keeps the fix where the format is introduced, instead of
 * loosening a contract that both providers and the API share.
 */
function instant(value: unknown): string {
  const parsed = new Date(string(value));
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid stored GOWA timestamp');
  return parsed.toISOString();
}
function sanitize(link: GowaSessionLink): GowaSessionLink { return { ...link, capabilities: [...link.capabilities], providerMetadata: safeMetadata(link.providerMetadata) }; }
function clone(link: GowaSessionLink): GowaSessionLink { return sanitize({ ...link }); }
function key(workspaceId: string, sessionId: string): string { return `${workspaceId}\u0000${sessionId}`; }
function parseArray(value: string): string[] { try { return array(JSON.parse(value)); } catch { throw new Error('Invalid stored GOWA capabilities'); } }
function parseObject(value: string): Record<string, unknown> { try { return object(JSON.parse(value)); } catch { throw new Error('Invalid stored GOWA metadata'); } }
function string(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('Invalid stored GOWA session'); return value; }
function array(value: unknown): string[] { if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('Invalid stored GOWA capabilities'); return [...value]; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored GOWA metadata'); return safeMetadata(value as Record<string, unknown>); }
function status(value: unknown): SessionStatus { if (!['disconnected','connecting','waiting_qr','connected','stopped','error'].includes(String(value))) throw new Error('Invalid stored GOWA status'); return value as SessionStatus; }
function reconciliation(value: unknown): GowaReconciliationState { if (!['healthy','missing','unverified'].includes(String(value))) throw new Error('Invalid stored GOWA reconciliation state'); return value as GowaReconciliationState; }
function safeMetadata(value: Record<string, unknown>): Record<string, unknown> { for (const [key, item] of Object.entries(value)) { if (/(jid|token|password|qr)/i.test(key)) throw new Error('Sensitive GOWA metadata must not be persisted'); if (typeof item === 'string' && (/@(s\.whatsapp\.net|c\.us|g\.us|lid)$/i.test(item) || /^data:image\//i.test(item))) throw new Error('Sensitive GOWA metadata must not be persisted'); if (item && typeof item === 'object') safeMetadata(item as Record<string, unknown>); } return structuredClone(value); }
