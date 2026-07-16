import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

export interface WorkspaceRecord { id: string; workspaceId: string; createdAt: string; updatedAt: string; }
export interface WorkspaceRepository<T extends WorkspaceRecord, Create, Update> {
  insert(workspaceId: string, input: Create): T;
  findById(workspaceId: string, id: string): T | undefined;
  list(workspaceId: string): T[];
  update(workspaceId: string, id: string, input: Update): T | undefined;
  delete(workspaceId: string, id: string): boolean;
}

export type ContactRecord = WorkspaceRecord & { displayName: string; phoneNumber: string; email: string | null; company: string | null; };
export type TagRecord = WorkspaceRecord & { name: string; color: string | null; };
export type TemplateRecord = WorkspaceRecord & { name: string; content: string; variables: string[]; };
export type PipelineRecord = WorkspaceRecord & { name: string; };
export type StageRecord = WorkspaceRecord & { pipelineId: string; name: string; position: number; };
export type LeadRecord = WorkspaceRecord & { stageId: string; contactId: string | null; title: string; };
export type CampaignRecord = WorkspaceRecord & { name: string; templateId: string | null; status: 'draft' | 'scheduled' | 'ready' | 'blocked' | 'cancelled'; scheduledAt: string | null; };
export type WorkspaceSettingsRecord = WorkspaceRecord & { settings: Record<string, unknown>; };

const timestamp = () => new Date().toISOString();
const normalizePhone = (value: string) => {
  const normalized = value.replace(/[^\d]/g, '');
  if (normalized.length < 8 || normalized.length > 15) throw new Error('Phone number must contain 8 to 15 digits');
  return normalized;
};

abstract class BaseSqliteRepository<T extends WorkspaceRecord, Create, Update> implements WorkspaceRepository<T, Create, Update> {
  constructor(protected readonly db: SqliteDatabase, private readonly table: string, private readonly columns: readonly string[]) {}
  protected abstract toRecord(row: Record<string, unknown>): T;
  protected abstract changes(input: Update): Record<string, unknown>;
  insert(workspaceId: string, input: Create): T {
    const id = randomUUID(), now = timestamp(); const values = { ...input, id, workspaceId, createdAt: now, updatedAt: now } as Record<string, unknown>;
    const names = ['id', 'workspaceId', ...this.columns, 'createdAt', 'updatedAt'];
    this.db.prepare(`INSERT INTO ${this.table} (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`).run(values);
    return this.findById(workspaceId, id)!;
  }
  findById(workspaceId: string, id: string): T | undefined { const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE workspaceId = ? AND id = ?`).get(workspaceId, id) as Record<string, unknown> | undefined; return row && this.toRecord(row); }
  list(workspaceId: string): T[] { return (this.db.prepare(`SELECT * FROM ${this.table} WHERE workspaceId = ? ORDER BY createdAt`).all(workspaceId) as Record<string, unknown>[]).map((row) => this.toRecord(row)); }
  update(workspaceId: string, id: string, input: Update): T | undefined {
    const values = this.changes(input); if (!Object.keys(values).length) return this.findById(workspaceId, id);
    values.updatedAt = timestamp(); values.workspaceId = workspaceId; values.id = id;
    const set = Object.keys(values).filter((key) => !['workspaceId', 'id'].includes(key)).map((key) => `${key} = @${key}`).join(', ');
    this.db.prepare(`UPDATE ${this.table} SET ${set} WHERE workspaceId = @workspaceId AND id = @id`).run(values); return this.findById(workspaceId, id);
  }
  delete(workspaceId: string, id: string): boolean { return this.db.prepare(`DELETE FROM ${this.table} WHERE workspaceId = ? AND id = ?`).run(workspaceId, id).changes > 0; }
}

export class SqliteContactRepository extends BaseSqliteRepository<ContactRecord, Omit<ContactRecord, keyof WorkspaceRecord>, Partial<Omit<ContactRecord, keyof WorkspaceRecord>>> {
  constructor(db: SqliteDatabase) { super(db, 'contacts', ['displayName', 'phoneNumber', 'email', 'company']); }
  protected toRecord(row: Record<string, unknown>): ContactRecord { return row as unknown as ContactRecord; }
  protected changes(input: Partial<Omit<ContactRecord, keyof WorkspaceRecord>>) { return { ...input, ...(input.phoneNumber ? { phoneNumber: normalizePhone(input.phoneNumber) } : {}) }; }
  override insert(workspaceId: string, input: Omit<ContactRecord, keyof WorkspaceRecord>): ContactRecord { return super.insert(workspaceId, { ...input, phoneNumber: normalizePhone(input.phoneNumber) }); }
}
export class SqliteTagRepository extends BaseSqliteRepository<TagRecord, Omit<TagRecord, keyof WorkspaceRecord>, Partial<Omit<TagRecord, keyof WorkspaceRecord>>> { constructor(db: SqliteDatabase) { super(db, 'tags', ['name', 'color']); } protected toRecord(row: Record<string, unknown>): TagRecord { return row as unknown as TagRecord; } protected changes(input: Partial<Omit<TagRecord, keyof WorkspaceRecord>>) { return input; } }
export class SqlitePipelineRepository extends BaseSqliteRepository<PipelineRecord, Omit<PipelineRecord, keyof WorkspaceRecord>, Partial<Omit<PipelineRecord, keyof WorkspaceRecord>>> { constructor(db: SqliteDatabase) { super(db, 'pipelines', ['name']); } protected toRecord(row: Record<string, unknown>): PipelineRecord { return row as unknown as PipelineRecord; } protected changes(input: Partial<Omit<PipelineRecord, keyof WorkspaceRecord>>) { return input; } }
export class SqliteStageRepository extends BaseSqliteRepository<StageRecord, Omit<StageRecord, keyof WorkspaceRecord>, Partial<Omit<StageRecord, keyof WorkspaceRecord>>> { constructor(db: SqliteDatabase) { super(db, 'stages', ['pipelineId', 'name', 'position']); } protected toRecord(row: Record<string, unknown>): StageRecord { return row as unknown as StageRecord; } protected changes(input: Partial<Omit<StageRecord, keyof WorkspaceRecord>>) { return input; } }
export class SqliteLeadRepository extends BaseSqliteRepository<LeadRecord, Omit<LeadRecord, keyof WorkspaceRecord>, Partial<Omit<LeadRecord, keyof WorkspaceRecord>>> { constructor(db: SqliteDatabase) { super(db, 'leads', ['stageId', 'contactId', 'title']); } protected toRecord(row: Record<string, unknown>): LeadRecord { return row as unknown as LeadRecord; } protected changes(input: Partial<Omit<LeadRecord, keyof WorkspaceRecord>>) { return input; } }
export class SqliteCampaignRepository extends BaseSqliteRepository<CampaignRecord, Omit<CampaignRecord, keyof WorkspaceRecord>, Partial<Omit<CampaignRecord, keyof WorkspaceRecord>>> { constructor(db: SqliteDatabase) { super(db, 'campaigns', ['name', 'templateId', 'status', 'scheduledAt']); } protected toRecord(row: Record<string, unknown>): CampaignRecord { return row as unknown as CampaignRecord; } protected changes(input: Partial<Omit<CampaignRecord, keyof WorkspaceRecord>>) { return input; } }

export class SqliteTemplateRepository extends BaseSqliteRepository<TemplateRecord, Omit<TemplateRecord, keyof WorkspaceRecord>, Partial<Omit<TemplateRecord, keyof WorkspaceRecord>>> {
  constructor(db: SqliteDatabase) { super(db, 'templates', ['name', 'content', 'variablesJson']); }
  protected toRecord(row: Record<string, unknown>): TemplateRecord { const { variablesJson, ...record } = row; return { ...record, variables: JSON.parse(variablesJson as string) } as TemplateRecord; }
  protected changes(input: Partial<Omit<TemplateRecord, keyof WorkspaceRecord>>) { const { variables, ...rest } = input; return { ...rest, ...(variables ? { variablesJson: JSON.stringify(variables) } : {}) }; }
  override insert(workspaceId: string, input: Omit<TemplateRecord, keyof WorkspaceRecord>): TemplateRecord { const { variables, ...rest } = input; return super.insert(workspaceId, { ...rest, variablesJson: JSON.stringify(variables) } as never); }
}
export class SqliteWorkspaceSettingsRepository extends BaseSqliteRepository<WorkspaceSettingsRecord, Omit<WorkspaceSettingsRecord, keyof WorkspaceRecord>, Partial<Omit<WorkspaceSettingsRecord, keyof WorkspaceRecord>>> {
  constructor(db: SqliteDatabase) { super(db, 'workspace_settings', ['settingsJson']); }
  protected toRecord(row: Record<string, unknown>): WorkspaceSettingsRecord { const { settingsJson, ...record } = row; return { ...record, settings: JSON.parse(settingsJson as string) } as WorkspaceSettingsRecord; }
  protected changes(input: Partial<Omit<WorkspaceSettingsRecord, keyof WorkspaceRecord>>) { return input.settings ? { settingsJson: JSON.stringify(input.settings) } : {}; }
  override insert(workspaceId: string, input: Omit<WorkspaceSettingsRecord, keyof WorkspaceRecord>): WorkspaceSettingsRecord { return super.insert(workspaceId, { settingsJson: JSON.stringify(input.settings) } as never); }
}

export class SqliteTagRelationsRepository {
  constructor(private readonly db: SqliteDatabase) {}
  attachToContact(workspaceId: string, contactId: string, tagId: string): void { this.db.prepare('INSERT INTO contact_tags (workspaceId, contactId, tagId, createdAt) VALUES (?, ?, ?, ?)').run(workspaceId, contactId, tagId, timestamp()); }
  attachToLead(workspaceId: string, leadId: string, tagId: string): void { this.db.prepare('INSERT INTO lead_tags (workspaceId, leadId, tagId, createdAt) VALUES (?, ?, ?, ?)').run(workspaceId, leadId, tagId, timestamp()); }
}

export function createPersistenceRepositories(db: SqliteDatabase) {
  return { contacts: new SqliteContactRepository(db), tags: new SqliteTagRepository(db), templates: new SqliteTemplateRepository(db), pipelines: new SqlitePipelineRepository(db), stages: new SqliteStageRepository(db), leads: new SqliteLeadRepository(db), campaigns: new SqliteCampaignRepository(db), workspaceSettings: new SqliteWorkspaceSettingsRepository(db), tagRelations: new SqliteTagRelationsRepository(db) };
}
