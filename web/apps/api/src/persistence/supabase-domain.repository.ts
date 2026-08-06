import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DomainRepository } from './domain.repository.js';
import { parseContactListQuery, type ContactListFilters } from './contact-query.js';
import { activeSessionNames, summarizeSessionsByStatus } from '../services/dashboard-sessions.js';
import { missingIdentifierHash, optOutIdentifierHash, supabaseAdoptOrphanOptOut, supabaseIdentifierHashReady } from '../services/opt-out-identity.js';

type Row = Record<string, unknown>;
type RpcError = { message: string; code?: string } | null;
const now = () => new Date().toISOString();
const snake = (value: Row) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), item]));
const camel = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(camel);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Row).map(([key, item]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), camel(item)]));
};
const error = (value: RpcError) => { if (value) throw new Error(`Supabase persistence error${value.code ? ` (${value.code})` : ''}: ${value.message}`); };
const normalizePhone = (value: string) => { const normalized = value.replace(/\D/g, ''); if (normalized.length < 8 || normalized.length > 15) throw new Error('Phone number must contain 8 to 15 digits'); return normalized; };
const templateVariables = (value: unknown): string[] => { if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string'); if (typeof value !== 'string') return []; try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } };
const variablesFromContent = (content: string) => [...new Set([...content.matchAll(/{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g)].map(match => match[1]))];
const normalizeTemplate = (value: unknown) => { const row = camel(value) as Row, { variablesJson, variables: legacyVariables, ...template } = row, names = templateVariables(legacyVariables ?? variablesJson); return { ...template, variables: names.length ? names : variablesFromContent(String(template.content ?? '')) }; };

/** PostgREST reads `or=` as a comma-separated list, so a raw search term
 * containing `,`, `(` or `"` would be parsed as extra clauses. Quoting the
 * value keeps the term opaque to the filter grammar. */
const filterValue = (value: string) => `"${value.replace(/["\\]/g, (character) => `\\${character}`)}"`;
/** Same columns and same partial, case-insensitive match as the SQLite
 * `LIKE '%term%'` in `contacts()`. */
const CONTACT_SEARCH_COLUMNS = ['display_name', 'phone_number', 'email'] as const;
const contactSearchFilter = (search: string) => CONTACT_SEARCH_COLUMNS.map((column) => `${column}.ilike.${filterValue(`%${search}%`)}`).join(',');
/** The tag and opt-out filters are embedded resources, so PostgREST returns
 * them alongside the contact. They are join machinery, not contact fields, and
 * the SQLite provider selects `c.*` only. */
const contactRow = (row: unknown) => { const { contact_tags: _tags, opt_out_history: _optOut, ...contact } = row as Row; return camel(contact); };
/** `contact_tags!inner` and `opt_out_history!inner` reproduce the SQLite `JOIN`
 * and `EXISTS`; the plain embed plus `is null` reproduces `NOT EXISTS`. */
const contactColumns = (filters: ContactListFilters) => ['*', ...(filters.tagId ? ['contact_tags!inner(tag_id)'] : []), ...(filters.optOut ? [`opt_out_history${filters.optOut === 'true' ? '!inner' : ''}(id)`] : [])].join(',');

/** Supabase implementation of the domain boundary. Compound mutations go through
 * versioned RPCs; reads and single-table changes keep using PostgREST tables. */
export class SupabaseDomainRepository implements DomainRepository {
  constructor(private readonly client: SupabaseClient) {}
  private async count(table: string, workspaceId: string, visibleOnly = false, sessions?: ReadonlySet<string>): Promise<number> { let query = this.client.from(table).select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId); if (visibleOnly) query = query.eq('visibility_state', 'visible'); if (sessions) query = query.in('waha_session', [...sessions]); const { count, error: queryError } = await query; error(queryError); return count ?? 0; }
  private async rpc(name: string, args: Row): Promise<unknown> { const { data, error: rpcError } = await this.client.rpc(name, args); error(rpcError); return camel(data); }
  private async rows(table: string, workspaceId: string): Promise<unknown[]> { const { data, error: queryError } = await this.client.from(table).select().eq('workspace_id', workspaceId).order('created_at'); error(queryError); return (data ?? []).map(camel); }
  private async one(table: string, workspaceId: string, id: string): Promise<unknown> { const { data, error: queryError } = await this.client.from(table).select().eq('workspace_id', workspaceId).eq('id', id).maybeSingle(); error(queryError); if (!data) throw new Error(`${table} not found in workspace`); return camel(data); }
  private async save(table: string, workspaceId: string, id: string | undefined, body: unknown): Promise<unknown> { const payload = snake(body as Row); if (id) { const { data, error: queryError } = await this.client.from(table).update({ ...payload, updated_at: now() }).eq('workspace_id', workspaceId).eq('id', id).select().maybeSingle(); error(queryError); if (!data) throw new Error(`${table} not found in workspace`); return camel(data); } const { data, error: queryError } = await this.client.from(table).insert({ id: randomUUID(), workspace_id: workspaceId, ...payload, created_at: now(), updated_at: now() }).select().single(); error(queryError); return camel(data); }
  private async remove(table: string, workspaceId: string, id: string): Promise<void> { const { error: queryError } = await this.client.from(table).delete().eq('workspace_id', workspaceId).eq('id', id); error(queryError); }
  private page(items: unknown[], query: Record<string, unknown>) { const page = Number(query.page ?? 1), pageSize = Math.min(Number(query.pageSize ?? 25), 100), start = (page - 1) * pageSize; return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length }; }

  /** Search, tag and opt-out all run in the database. Reading the workspace's
   * whole contact table to slice it in memory does not scale and silently
   * dropped `search`, so the Inbox saw an unfiltered list. O filtro de origem
   * chega pronto (`phonebookIds`): PostgREST não expressa EXISTS/NOT EXISTS
   * sobre outra tabela, então os ids da agenda vêm de uma consulta em lote. */
  private contactQuery(w: string, filters: ContactListFilters, head: boolean, phonebookIds?: ReadonlySet<string>) {
    let query = this.client.from('contacts').select(contactColumns(filters), head ? { count: 'exact', head: true } : { count: 'exact' }).eq('workspace_id', w);
    if (filters.tagId) query = query.eq('contact_tags.tag_id', filters.tagId);
    if (filters.optOut === 'false') query = query.is('opt_out_history', null);
    if (filters.search) query = query.or(contactSearchFilter(filters.search));
    if (filters.origin === 'phonebook' && phonebookIds) query = query.in('id', [...phonebookIds]);
    if (filters.origin === 'history' && phonebookIds?.size) query = query.not('id', 'in', `(${[...phonebookIds].join(',')})`);
    return query;
  }
  async contacts(w: string, q: Record<string, unknown>) {
    const filters = parseContactListQuery(q), offset = (filters.page - 1) * filters.pageSize;
    // A agenda do celular é pequena por definição (centenas), então os ids
    // cabem num filtro `in`. Falha fechada de propósito: sem saber a agenda,
    // 'phonebook' devolveria a base inteira como se fosse celular — pior que
    // um erro honesto. Vazia, a página é vazia sem nem bater na tabela.
    const phonebookIds = filters.origin ? await this.phonebookContactIds(w) : undefined;
    if (filters.origin === 'phonebook' && phonebookIds && !phonebookIds.size) return { items: [], page: filters.page, pageSize: filters.pageSize, total: 0 };
    const { data, count, error: queryError } = await this.contactQuery(w, filters, false, phonebookIds).order('created_at', { ascending: false }).range(offset, offset + filters.pageSize - 1);
    // PostgREST rejects an offset past the last row; SQLite answers an empty
    // page. Re-count so the caller still learns the real total.
    if (queryError?.code === 'PGRST103') { const { count: total, error: countError } = await this.contactQuery(w, filters, true, phonebookIds); error(countError); return { items: [], page: filters.page, pageSize: filters.pageSize, total: total ?? 0 }; }
    error(queryError);
    return { items: await this.withContactOrigin(w, await this.withWhatsAppIdentity(w, (data ?? []).map(contactRow) as Record<string, unknown>[])), page: filters.page, pageSize: filters.pageSize, total: count ?? 0 };
  }
  /** Ids dos contatos com algum identificador nascido da agenda do WhatsApp
   *  ('waha_contact_sync') — a base do filtro `origin` da listagem. */
  private async phonebookContactIds(workspaceId: string): Promise<Set<string>> {
    const { data, error: identifiersError } = await this.client.from('contact_identifiers').select('contact_id').eq('workspace_id', workspaceId).eq('source', 'waha_contact_sync');
    error(identifiersError);
    return new Set((data ?? []).map(row => String(row.contact_id)));
  }
  /** Origem do contato para as duas colunas do picker: 'phonebook' quando algum
   *  identificador dele nasceu da agenda do WhatsApp ('waha_contact_sync'),
   *  'history' nos demais casos (conversas, webhook, cadastro manual). Uma
   *  consulta em lote por página — mesma disciplina do enriquecimento de
   *  identidade. Falha aberta: sem a tabela de identificadores a listagem volta
   *  sem origem em vez de derrubar a tela. */
  private async withContactOrigin<T extends Record<string, unknown>>(workspaceId: string, items: T[]): Promise<T[]> {
    const ids = [...new Set(items.map(item => item.id).filter((value): value is string => typeof value === 'string' && value.length > 0))];
    if (!ids.length) return items;
    const { data, error: identifiersError } = await this.client.from('contact_identifiers').select('contact_id, source').eq('workspace_id', workspaceId).in('contact_id', ids);
    if (identifiersError) return items;
    const phonebook = new Set((data ?? []).filter(row => row.source === 'waha_contact_sync').map(row => String(row.contact_id)));
    return items.map(item => ({ ...item, origin: phonebook.has(String(item.id)) ? 'phonebook' : 'history' }));
  }
  /** Anexa foto/nome WhatsApp da identidade canônica de cada telefone da página.
   *  Uma segunda consulta em lote — nunca uma por linha — com o mesmo efeito do
   *  LEFT JOIN do provider SQLite: a identidade mais recente por telefone.
   *  Falha aberta: se a tabela de identidades não responder, a listagem volta
   *  sem enriquecimento em vez de derrubar a tela de contatos. */
  private async withWhatsAppIdentity<T extends Record<string, unknown>>(workspaceId: string, items: T[]): Promise<T[]> {
    const phones = [...new Set(items.map(item => item.phoneNumber).filter((value): value is string => typeof value === 'string' && value.length > 0))];
    if (!phones.length) return items;
    const { data, error: identityError } = await this.client.from('whatsapp_identities').select('phone, name, push_name, profile_picture_url, updated_at').eq('workspace_id', workspaceId).in('phone', phones).order('updated_at', { ascending: false });
    if (identityError) return items;
    const byPhone = new Map<string, { name: string | null; push_name: string | null; profile_picture_url: string | null }>();
    for (const row of data ?? []) { if (row.phone && !byPhone.has(row.phone)) byPhone.set(row.phone, row); }
    return items.map(item => {
      const identity = typeof item.phoneNumber === 'string' ? byPhone.get(item.phoneNumber) : undefined;
      return identity ? { ...item, photoUrl: identity.profile_picture_url ?? null, whatsappName: identity.name ?? null, whatsappPushName: identity.push_name ?? null } : item;
    });
  }
  contact(w: string, id: string) { return this.one('contacts', w, id); }
  async contactTags(w: string, id: string): Promise<string[]> {
    await this.one('contacts', w, id);
    const { data, error: queryError } = await this.client.from('contact_tags').select('tag_id').eq('workspace_id', w).eq('contact_id', id).order('tag_id');
    error(queryError);
    return (data ?? []).map((row) => String((row as Row).tag_id));
  }
  async createContact(w: string, body: unknown) { const input = body as Row; const contact = await this.rpc('chatpro_create_contact', { p_workspace_id: w, p_contact: { ...input, phoneNumber: normalizePhone(String(input.phoneNumber)) }, p_tag_ids: input.tagIds ?? [] }) as Row; await supabaseAdoptOrphanOptOut(this.client, w, String(contact?.id ?? ''), contact?.phoneNumber); return contact; }
  updateContact(w: string, id: string, body: unknown) { const input = body as Row; const payload = { ...input, ...(typeof input.phoneNumber === 'string' ? { phoneNumber: normalizePhone(input.phoneNumber) } : {}) }; return this.rpc('chatpro_update_contact', { p_workspace_id: w, p_contact_id: id, p_contact: payload, p_tag_ids: Array.isArray(input.tagIds) ? input.tagIds : null }); }
  deleteContact(w: string, id: string) { return this.remove('contacts', w, id); }
  async importContacts(w: string, body: unknown) { const csv = String((body as Row).csv ?? ''); const lines = csv.trim().split(/\r?\n/); const [header, ...rows] = lines.map((line) => line.split(',').map((item) => item.trim())); const name = header.indexOf('displayName'), phone = header.indexOf('phoneNumber'); if (name < 0 || phone < 0) throw new Error('CSV must contain displayName and phoneNumber headers'); await Promise.all(rows.map((row) => this.createContact(w, { displayName: row[name], phoneNumber: row[phone] }))); return { created: rows.length }; }
  async exportContacts(w: string) { const rows = await this.rows('contacts', w) as Row[]; return ['displayName,phoneNumber,email,company', ...rows.map((row) => [row.displayName, row.phoneNumber, row.email, row.company].map((item) => `"${String(item ?? '').replaceAll('"', '""')}"`).join(','))].join('\n'); }
  tags(w: string) { return this.rows('tags', w); } createTag(w: string, b: unknown) { return this.save('tags', w, undefined, b); } updateTag(w: string, id: string, b: unknown) { return this.save('tags', w, id, b); } deleteTag(w: string, id: string) { return this.rpc('chatpro_delete_tag', { p_workspace_id: w, p_tag_id: id }); }
  async templates(w: string) { return (await this.rows('templates', w)).map(normalizeTemplate); } async template(w: string, id: string) { return normalizeTemplate(await this.one('templates', w, id)); } async saveTemplate(w: string, id: string | undefined, b: unknown) { const input = b as Row; if ((!id && (typeof input.name !== 'string' || typeof input.content !== 'string')) || (id && typeof input.name !== 'string' && typeof input.content !== 'string')) throw new Error('Template name and content are required'); const payload = { ...input, ...(typeof input.content === 'string' ? { variablesJson: variablesFromContent(input.content) } : {}) }; return normalizeTemplate(await this.save('templates', w, id, payload)); } async templateActive(w: string, id: string, active: boolean) { return normalizeTemplate(await this.save('templates', w, id, { active })); } deleteTemplate(w: string, id: string) { return this.remove('templates', w, id); }
  async preview(w: string, id: string, body: unknown) { const template = await this.template(w, id) as Row; const data = (body as Row).data as Row; const variables = templateVariables(template.variables); const missing = variables.filter((name) => data[name] === undefined); if (missing.length) throw new Error(`Missing template variables: ${missing.join(', ')}`); return { content: String(template.content).replace(/{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g, (_, name: string) => String(data[name])), variables }; }
  pipelines(w: string) { return this.rows('pipelines', w); } savePipeline(w: string, id: string | undefined, b: unknown) { return this.save('pipelines', w, id, b); } async deletePipeline(w: string, id: string): Promise<void> { await this.rpc('chatpro_delete_pipeline', { p_workspace_id: w, p_pipeline_id: id }); } initPipeline(w: string, b: unknown) { return this.rpc('chatpro_initialize_pipeline', { p_workspace_id: w, p_name: (b as Row).name ?? 'Pipeline padrão' }); }
  async stages(w: string, pipelineId: string) { const { data, error: queryError } = await this.client.from('stages').select().eq('workspace_id', w).eq('pipeline_id', pipelineId).order('position'); error(queryError); return (data ?? []).map(camel); } saveStage(w: string, id: string | undefined, b: unknown) { return this.save('stages', w, id, b); } async reorderStages(w: string, pipelineId: string, b: unknown) { const ids = (b as Row).stageIds as string[]; await Promise.all(ids.map((id, position) => this.save('stages', w, id, { pipelineId, position }))); return this.stages(w, pipelineId); } async deleteStage(w: string, id: string): Promise<void> { await this.rpc('chatpro_delete_stage', { p_workspace_id: w, p_stage_id: id }); }
  async leads(w: string, q: Record<string, unknown>) { return this.page(await this.rows('leads', w), q); } saveLead(w: string, id: string | undefined, b: unknown) { return this.save('leads', w, id, b); } deleteLead(w: string, id: string) { return this.remove('leads', w, id); } moveLead(w: string, id: string, b: unknown) { return this.rpc('chatpro_move_lead', { p_workspace_id: w, p_lead_id: id, p_stage_id: (b as Row).stageId }); } leadTag(w: string, id: string, tagId: string, add: boolean) { return this.rpc('chatpro_set_lead_tag', { p_workspace_id: w, p_lead_id: id, p_tag_id: tagId, p_add: add }); } note(w: string, id: string, b: unknown) { return this.rpc('chatpro_add_note', { p_workspace_id: w, p_lead_id: id, p_body: (b as Row).body }); } async notes(w: string, id: string) { const { data, error: queryError } = await this.client.from('lead_notes').select().eq('workspace_id', w).eq('lead_id', id).order('created_at', { ascending: false }); error(queryError); return (data ?? []).map(camel); } async activities(w: string, id: string) { const { data, error: queryError } = await this.client.from('activities').select().eq('workspace_id', w).eq('lead_id', id).order('occurred_at', { ascending: false }); error(queryError); return (data ?? []).map(camel); } async funnel(w: string) { const stages = await this.rows('stages', w) as Row[], leads = await this.rows('leads', w) as Row[]; return stages.map((stage) => ({ stageId: stage.id, name: stage.name, position: stage.position, total: leads.filter((lead) => lead.stageId === stage.id).length })); }
  optOut(w: string, id: string, b: unknown) { return this.rpc('chatpro_record_opt_out', { p_workspace_id: w, p_contact_id: id, p_payload: b }); } /** Matches the contact's own rows and, when the contact that made the manifestation was purged, the orphaned row carrying the same phone hash. */
  async optOutStatus(w: string, id: string) { const contact = await this.one('contacts', w, id) as Row; const { data, error: queryError } = await this.client.from('opt_out_history').select().eq('workspace_id', w).eq('contact_id', id).order('occurred_at', { ascending: false }); error(queryError); const own = (data ?? []).map(camel) as Row[]; const orphans = await this.orphanOptOut(w, contact?.phoneNumber); const history = [...own, ...orphans].sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? ''))); return { contactId: id, optedOut: history.length > 0, history }; }
  /** Empty until migration M3 adds `identifier_hash`; kept as its own query so no PostgREST filter string has to embed the hash. */
  private async orphanOptOut(w: string, phoneNumber: unknown): Promise<Row[]> { if (!phoneNumber || !(await supabaseIdentifierHashReady(this.client))) return []; const { data, error: queryError } = await this.client.from('opt_out_history').select().eq('workspace_id', w).is('contact_id', null).eq('identifier_hash', optOutIdentifierHash(phoneNumber)).order('occurred_at', { ascending: false }); if (queryError && !missingIdentifierHash(queryError)) error(queryError); return (data ?? []).map(camel) as Row[]; } removeOptOut(w: string, id: string) { return this.rpc('chatpro_remove_opt_out', { p_workspace_id: w, p_contact_id: id }); } optOutContacts(w: string, q: Record<string, unknown>) { return this.contacts(w, { ...q, optOut: 'true' }); }
  async campaigns(w: string, q: Record<string, unknown>) { return this.page(await this.rows('campaigns', w), q); } campaign(w: string, id: string) { return this.one('campaigns', w, id); } saveCampaign(w: string, id: string | undefined, b: unknown) { const input = b as Row; return this.rpc('chatpro_save_campaign', { p_workspace_id: w, p_campaign_id: id ?? null, p_payload: input, p_contact_ids: Array.isArray(input.contactIds) ? input.contactIds : null }); } deleteCampaign(w: string, id: string) { return this.remove('campaigns', w, id); } async validateCampaign(w: string, id: string) { const campaign = await this.campaign(w, id) as Row; const problems: string[] = []; if (!campaign.templateId) problems.push('templateId is required'); return { valid: problems.length === 0, problems, recipients: 0 }; } prepareCampaign(w: string, id: string) { return this.rpc('chatpro_prepare_campaign', { p_workspace_id: w, p_campaign_id: id }); } async scheduleCampaign(w: string, id: string, b: unknown) { const prepared = await this.prepareCampaign(w, id) as Row; if ((prepared.campaign as Row).status === 'blocked') return prepared; return this.save('campaigns', w, id, { status: 'scheduled', scheduledAt: (b as Row).scheduledAt }); } cancelCampaign(w: string, id: string) { return this.save('campaigns', w, id, { status: 'cancelled' }); }
  async settings(w: string) { const { data, error: queryError } = await this.client.from('workspace_settings').select().eq('workspace_id', w).maybeSingle(); error(queryError); return data ? camel(data) : { workspaceId: w, settings: {} }; } saveSettings(w: string, b: unknown) { return this.rpc('chatpro_save_settings', { p_workspace_id: w, p_settings: b }); } // Mesma regra do SQLite: o KPI de conversas exclui sessão que a WAHA não
  // conhece mais, e volta a contar tudo quando a lista não é confiável.
  async dashboard(w: string, sessions: unknown[]) { const active = activeSessionNames(sessions); const [[contacts, tags, templates, leads, campaigns], [conversations, messages]] = await Promise.all([Promise.all(['contacts', 'tags', 'templates', 'leads', 'campaigns'].map((table) => this.rows(table, w))), Promise.all([this.count('conversations', w, true, active), this.count('whatsapp_messages', w)])]); return { contacts: contacts.length, optOutContacts: (await this.optOutContacts(w, {} ) as { total: number }).total, tags: tags.length, templates: templates.length, leads: leads.length, conversations, messages, leadsByStage: await this.funnel(w), recentActivities: [], campaignsByStatus: campaigns, sessionsByStatus: summarizeSessionsByStatus(sessions) }; }
}

export const createSupabaseDomainRepository = (client: SupabaseClient): DomainRepository => new SupabaseDomainRepository(client);
