import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActivityRecord,
  CampaignRecord,
  ContactRecord,
  LeadNoteRecord,
  LeadRecord,
  OptOutHistoryRecord,
  PipelineRecord,
  StageRecord,
  TagRecord,
  TemplateRecord,
  WorkspaceRecord,
  WorkspaceRepository,
  WorkspaceSettingsRecord,
} from './repositories.js';

type Row = Record<string, unknown>;
const timestamp = () => new Date().toISOString();
const normalizePhone = (value: string) => {
  const normalized = value.replace(/[^\d]/g, '');
  if (normalized.length < 8 || normalized.length > 15) throw new Error('Phone number must contain 8 to 15 digits');
  return normalized;
};
const columnName = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const camelize = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const toCamelRecord = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([key, value]) => [camelize(key), value]));
const fail = (error: { message: string } | null) => { if (error) throw new Error(`Supabase persistence error: ${error.message}`); };

abstract class BaseSupabaseRepository<T extends WorkspaceRecord, Create, Update> implements WorkspaceRepository<T, Create, Update> {
  constructor(protected readonly client: SupabaseClient, private readonly table: string) {}
  protected toInsert(input: Create): Row { return Object.fromEntries(Object.entries(input as Row).map(([key, value]) => [columnName(key), value])); }
  protected toUpdate(input: Update): Row { return Object.fromEntries(Object.entries(input as Row).map(([key, value]) => [columnName(key), value])); }
  protected toRecord(row: Row): T { return toCamelRecord(row) as T; }
  async insert(workspaceId: string, input: Create): Promise<T> {
    const now = timestamp();
    const { data, error } = await this.client.from(this.table).insert({ id: randomUUID(), workspace_id: workspaceId, ...this.toInsert(input), created_at: now, updated_at: now }).select().single();
    fail(error); return this.toRecord(data as Row);
  }
  async findById(workspaceId: string, id: string): Promise<T | undefined> {
    const { data, error } = await this.client.from(this.table).select().eq('workspace_id', workspaceId).eq('id', id).maybeSingle();
    fail(error); return data ? this.toRecord(data as Row) : undefined;
  }
  async list(workspaceId: string): Promise<T[]> {
    const { data, error } = await this.client.from(this.table).select().eq('workspace_id', workspaceId).order('created_at');
    fail(error); return (data ?? []).map((row) => this.toRecord(row as Row));
  }
  async update(workspaceId: string, id: string, input: Update): Promise<T | undefined> {
    const values = this.toUpdate(input); if (!Object.keys(values).length) return this.findById(workspaceId, id);
    const { data, error } = await this.client.from(this.table).update({ ...values, updated_at: timestamp() }).eq('workspace_id', workspaceId).eq('id', id).select().maybeSingle();
    fail(error); return data ? this.toRecord(data as Row) : undefined;
  }
  async delete(workspaceId: string, id: string): Promise<boolean> {
    const { data, error } = await this.client.from(this.table).delete().eq('workspace_id', workspaceId).eq('id', id).select('id');
    fail(error); return (data?.length ?? 0) > 0;
  }
}

export class SupabaseContactRepository extends BaseSupabaseRepository<ContactRecord, Omit<ContactRecord, keyof WorkspaceRecord>, Partial<Omit<ContactRecord, keyof WorkspaceRecord>>> {
  constructor(client: SupabaseClient) { super(client, 'contacts'); }
  override async insert(workspaceId: string, input: Omit<ContactRecord, keyof WorkspaceRecord>) { return super.insert(workspaceId, { ...input, phoneNumber: normalizePhone(input.phoneNumber) }); }
  protected override toUpdate(input: Partial<Omit<ContactRecord, keyof WorkspaceRecord>>) { return super.toUpdate({ ...input, ...(input.phoneNumber ? { phoneNumber: normalizePhone(input.phoneNumber) } : {}) }); }
}
export class SupabaseTagRepository extends BaseSupabaseRepository<TagRecord, Omit<TagRecord, keyof WorkspaceRecord>, Partial<Omit<TagRecord, keyof WorkspaceRecord>>> { constructor(client: SupabaseClient) { super(client, 'tags'); } }
export class SupabasePipelineRepository extends BaseSupabaseRepository<PipelineRecord, Omit<PipelineRecord, keyof WorkspaceRecord>, Partial<Omit<PipelineRecord, keyof WorkspaceRecord>>> { constructor(client: SupabaseClient) { super(client, 'pipelines'); } }
export class SupabaseStageRepository extends BaseSupabaseRepository<StageRecord, Omit<StageRecord, keyof WorkspaceRecord>, Partial<Omit<StageRecord, keyof WorkspaceRecord>>> { constructor(client: SupabaseClient) { super(client, 'stages'); } }
export class SupabaseLeadRepository extends BaseSupabaseRepository<LeadRecord, Omit<LeadRecord, keyof WorkspaceRecord>, Partial<Omit<LeadRecord, keyof WorkspaceRecord>>> { constructor(client: SupabaseClient) { super(client, 'leads'); } }
export class SupabaseCampaignRepository extends BaseSupabaseRepository<CampaignRecord, Omit<CampaignRecord, keyof WorkspaceRecord>, Partial<Omit<CampaignRecord, keyof WorkspaceRecord>>> { constructor(client: SupabaseClient) { super(client, 'campaigns'); } }

export class SupabaseTemplateRepository extends BaseSupabaseRepository<TemplateRecord, Omit<TemplateRecord, keyof WorkspaceRecord>, Partial<Omit<TemplateRecord, keyof WorkspaceRecord>>> {
  constructor(client: SupabaseClient) { super(client, 'templates'); }
  protected override toInsert(input: Omit<TemplateRecord, keyof WorkspaceRecord>) { const { variables, ...rest } = input; return { ...super.toInsert(rest as Omit<TemplateRecord, keyof WorkspaceRecord>), variables_json: variables }; }
  protected override toUpdate(input: Partial<Omit<TemplateRecord, keyof WorkspaceRecord>>) { const { variables, ...rest } = input; return { ...super.toUpdate(rest), ...(variables ? { variables_json: variables } : {}) }; }
  protected override toRecord(row: Row): TemplateRecord { const record = toCamelRecord(row); return { ...record, variables: record.variablesJson as string[] } as TemplateRecord; }
}
export class SupabaseWorkspaceSettingsRepository extends BaseSupabaseRepository<WorkspaceSettingsRecord, Omit<WorkspaceSettingsRecord, keyof WorkspaceRecord>, Partial<Omit<WorkspaceSettingsRecord, keyof WorkspaceRecord>>> {
  constructor(client: SupabaseClient) { super(client, 'workspace_settings'); }
  protected override toInsert(input: Omit<WorkspaceSettingsRecord, keyof WorkspaceRecord>) { return { settings_json: input.settings }; }
  protected override toUpdate(input: Partial<Omit<WorkspaceSettingsRecord, keyof WorkspaceRecord>>) { return input.settings ? { settings_json: input.settings } : {}; }
  protected override toRecord(row: Row): WorkspaceSettingsRecord { const record = toCamelRecord(row); return { ...record, settings: record.settingsJson as Record<string, unknown> } as WorkspaceSettingsRecord; }
}

export class SupabaseOptOutHistoryRepository extends BaseSupabaseRepository<OptOutHistoryRecord, Omit<OptOutHistoryRecord, keyof WorkspaceRecord>, Partial<Omit<OptOutHistoryRecord, keyof WorkspaceRecord>>> { constructor(client: SupabaseClient) { super(client, 'opt_out_history'); } }
export class SupabaseLeadNoteRepository extends BaseSupabaseRepository<LeadNoteRecord, Omit<LeadNoteRecord, keyof WorkspaceRecord>, Partial<Omit<LeadNoteRecord, keyof WorkspaceRecord>>> { constructor(client: SupabaseClient) { super(client, 'lead_notes'); } }
export class SupabaseActivityRepository extends BaseSupabaseRepository<ActivityRecord, Omit<ActivityRecord, keyof WorkspaceRecord>, Partial<Omit<ActivityRecord, keyof WorkspaceRecord>>> {
  constructor(client: SupabaseClient) { super(client, 'activities'); }
  protected override toInsert(input: Omit<ActivityRecord, keyof WorkspaceRecord>) { const { details, ...rest } = input; return { ...super.toInsert(rest as Omit<ActivityRecord, keyof WorkspaceRecord>), details_json: details }; }
  protected override toUpdate(input: Partial<Omit<ActivityRecord, keyof WorkspaceRecord>>) { const { details, ...rest } = input; return { ...super.toUpdate(rest), ...(details ? { details_json: details } : {}) }; }
  protected override toRecord(row: Row): ActivityRecord { const record = toCamelRecord(row); return { ...record, details: record.detailsJson as Record<string, unknown> } as ActivityRecord; }
}

export class SupabaseTagRelationsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async attachToContact(workspaceId: string, contactId: string, tagId: string): Promise<void> { const { error } = await this.client.from('contact_tags').insert({ workspace_id: workspaceId, contact_id: contactId, tag_id: tagId, created_at: timestamp() }); fail(error); }
  async attachToLead(workspaceId: string, leadId: string, tagId: string): Promise<void> { const { error } = await this.client.from('lead_tags').insert({ workspace_id: workspaceId, lead_id: leadId, tag_id: tagId, created_at: timestamp() }); fail(error); }
}

export function createSupabasePersistenceRepositories(client: SupabaseClient) {
  return { contacts: new SupabaseContactRepository(client), tags: new SupabaseTagRepository(client), templates: new SupabaseTemplateRepository(client), pipelines: new SupabasePipelineRepository(client), stages: new SupabaseStageRepository(client), leads: new SupabaseLeadRepository(client), campaigns: new SupabaseCampaignRepository(client), workspaceSettings: new SupabaseWorkspaceSettingsRepository(client), optOutHistory: new SupabaseOptOutHistoryRepository(client), leadNotes: new SupabaseLeadNoteRepository(client), activities: new SupabaseActivityRepository(client), tagRelations: new SupabaseTagRelationsRepository(client) };
}
