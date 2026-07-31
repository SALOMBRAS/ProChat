import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteDatabase } from '../persistence/database.js';
import type { RealtimeHub } from '../realtime.js';
import { log } from '../logging.js';

export type SlaStatus = 'waiting_operator' | 'waiting_customer' | 'answered' | 'resolved' | 'expired' | 'archived';
export type SlaConfig = { firstResponseThresholdMs: number; operatorWaitingThresholdMs: number; customerWaitingThresholdMs: number; warningRatio: number };
export type SlaMetrics = { conversationId: string; status: SlaStatus; firstInboundAt: string; firstResponseAt: string | null; lastInboundAt: string; lastOutboundAt: string | null; lastActivityAt: string; firstResponseTime: number | null; averageResponseTime: number | null; waitingTime: number; conversationDuration: number; idleTime: number; slaIndicator: 'green' | 'yellow' | 'red'; deadlineAt: string | null; frozenAt: string | null };
export type SlaCardProjection = { status: SlaStatus; indicator: 'green' | 'yellow' | 'red' | 'neutral'; deadlineAt: string | null };
type Row = { workspaceId: string; conversationId: string; slaStatus: SlaStatus; firstInboundAt: string; firstResponseAt: string | null; lastInboundAt: string; lastOutboundAt: string | null; lastActivityAt: string; waitingSinceAt: string | null; operatorWaitingMs: number; customerWaitingMs: number; totalResponseMs: number; responseCount: number; resolvedAt: string | null; archivedAt: string | null; frozenAt: string | null; updatedAt: string };
type CriticalConversationIdentity = { conversationId: string; chatId: string; profileName: string | null; pushName: string | null; contactName: string | null; phoneNumber: string | null; assignedUserId: string | null; routingQueueId: string | null };
export interface SlaStore { getConfig(workspaceId: string): Promise<SlaConfig>; saveConfig(workspaceId: string, input: SlaConfig): Promise<SlaConfig>; get(workspaceId: string, conversationId: string): Promise<Row | undefined>; save(row: Row): Promise<void>; listDue(workspaceId?: string): Promise<Row[]>; criticalConversationIdentities(workspaceId: string, conversationIds: string[]): Promise<CriticalConversationIdentity[]>; conversationIdForMessage(workspaceId: string, session: string, messageId: string): Promise<string | undefined>; }
const defaults: SlaConfig = { firstResponseThresholdMs: 300000, operatorWaitingThresholdMs: 900000, customerWaitingThresholdMs: 86400000, warningRatio: .8 };
// Teto da amostra crítica devolvida por `summary`. O limite não é de render — o
// dashboard rola 1000 linhas a 60 fps — nem de banco: o `IN` do SQLite resolve
// 100 ids em 0,2 ms. Quem manda é o provider Supabase, onde
// `criticalConversationIdentities` vira um filtro `.in('id', [...])` serializado
// na URL: 100 ids dão ~4,5 KB, 200 já dão ~8,9 KB e estouram o limite prático de
// header (~8 KB). Some-se que a API não tem compressão, então cada item custa
// ~300 B na rede a cada atualização de 60 s. 100 dá 5x de folga sobre o pior caso
// real observado (49) e mantém o payload em ~30 KB. Para subir além disso é
// preciso paginar o filtro de identidades em lotes, não só mexer neste número.
// O `totals` continua contando a população inteira, e a UI diz quantos de quantos
// está mostrando quando a amostra é menor que o total.
export const criticalSampleLimit = 100;
const ms = (a: string, b: string) => Math.max(0, new Date(a).getTime() - new Date(b).getTime());
export function projectSla(row: Row, config: SlaConfig, now = new Date().toISOString()): SlaMetrics {
  const live = !row.frozenAt && row.waitingSinceAt ? ms(now, row.waitingSinceAt) : 0;
  const operator = row.operatorWaitingMs + (row.slaStatus === 'waiting_operator' || row.slaStatus === 'expired' ? live : 0);
  const customer = row.customerWaitingMs + (row.slaStatus === 'waiting_customer' ? live : 0);
  const waiting = row.slaStatus === 'waiting_customer' ? customer : operator;
  const threshold = row.slaStatus === 'waiting_customer' ? config.customerWaitingThresholdMs : !row.firstResponseAt ? config.firstResponseThresholdMs : config.operatorWaitingThresholdMs;
  const indicator = row.slaStatus === 'expired' || waiting >= threshold ? 'red' : waiting >= threshold * config.warningRatio ? 'yellow' : 'green';
  return { conversationId: row.conversationId, status: row.slaStatus, firstInboundAt: row.firstInboundAt, firstResponseAt: row.firstResponseAt, lastInboundAt: row.lastInboundAt, lastOutboundAt: row.lastOutboundAt, lastActivityAt: row.lastActivityAt, firstResponseTime: row.firstResponseAt ? ms(row.firstResponseAt, row.firstInboundAt) : null, averageResponseTime: row.responseCount ? Math.round(row.totalResponseMs / row.responseCount) : null, waitingTime: waiting, conversationDuration: ms(row.frozenAt ?? now, row.firstInboundAt), idleTime: ms(now, row.lastActivityAt), slaIndicator: indicator, deadlineAt: row.frozenAt || row.slaStatus === 'resolved' || row.slaStatus === 'archived' || !row.waitingSinceAt ? null : new Date(new Date(row.waitingSinceAt).getTime() + threshold).toISOString(), frozenAt: row.frozenAt };
}
export function projectSlaCard(row: Pick<Row, 'slaStatus' | 'waitingSinceAt' | 'firstResponseAt' | 'frozenAt'>, config: SlaConfig, now = new Date().toISOString()): SlaCardProjection {
  if (row.frozenAt || row.slaStatus === 'resolved' || row.slaStatus === 'archived') return { status: row.slaStatus, indicator: 'neutral', deadlineAt: null };
  const threshold = row.slaStatus === 'waiting_customer' ? config.customerWaitingThresholdMs : !row.firstResponseAt ? config.firstResponseThresholdMs : config.operatorWaitingThresholdMs;
  const deadlineAt = row.waitingSinceAt ? new Date(new Date(row.waitingSinceAt).getTime() + threshold).toISOString() : null;
  const elapsed = row.waitingSinceAt ? ms(now, row.waitingSinceAt) : 0;
  const indicator = row.slaStatus === 'expired' || elapsed >= threshold ? 'red' : elapsed >= threshold * config.warningRatio ? 'yellow' : 'green';
  return { status: row.slaStatus, indicator, deadlineAt };
}
// A configuração de SLA é uma linha por workspace, alterada por ação humana na
// tela de configurações, e é lida em todo caminho quente: a projeção de cada
// conversa, cada publicação de evento e cada página de etapa do Kanban precisam
// dela. Sem memória, cada uma dessas leituras é uma ida ao banco.
//
// Medido na base de produção em 2026-07-31, com o provider Supabase: um único
// workspace; `conversation_sla_metrics` com 61 linhas, todas com `frozenAt`
// nulo; 657 conversas. Quem o tick percorre é a primeira contagem, não a
// segunda — confundir as duas superestima o problema em dez vezes. Uma leitura
// remota da configuração custa ~155 ms (mediana de 12 amostras desta máquina),
// então o tick gastava 61 leituras da mesma linha, ~9,5 s só nisso, e cada
// mensagem recebida, cada consulta de métricas e cada etapa de Kanban carregada
// somava mais uma. Os ~10 GETs por segundo observados são a soma desses
// caminhos; o tick sozinho não os explica. `workspace_sla_config` está vazia:
// todas essas leituras voltavam com os padrões declarados acima.
//
// Escolhemos cache com invalidação explícita, e não apenas içar a busca para
// fora de cada laço, porque içar resolve uma operação de cada vez e deixa de pé
// o caminho por mensagem e por conversa aberta, que são justamente os que
// escalam com o tráfego. A invalidação é exata: toda escrita passa por
// `SlaService.config`, que grava o valor novo no cache no mesmo passo.
//
// O TTL de 60 s não existe para corrigir a escrita local — essa é imediata. Ele
// cobre o caso de outra instância da API gravar a configuração, e 60 s é o
// próprio período do tick: nenhum limiar obsoleto sobrevive a mais de uma
// passagem do relógio de SLA, que é a granularidade em que esses limiares são
// avaliados de qualquer forma.
export const slaConfigTtlMs = 60_000;
export class SlaService {
  private readonly configCache = new Map<string, { value: SlaConfig; expiresAt: number }>();
  private ticking = false;
  constructor(private readonly store: SlaStore, private readonly realtime: RealtimeHub) {}
  private async configFor(workspaceId: string) {
    const now = Date.now(); const cached = this.configCache.get(workspaceId);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await this.store.getConfig(workspaceId);
    this.configCache.set(workspaceId, { value, expiresAt: now + slaConfigTtlMs });
    return value;
  }
  async message(workspaceId: string, conversationId: string, direction: 'inbound' | 'outbound', occurredAt: string, historical: boolean) {
    if (historical) return;
    const now = new Date().toISOString(); let row = await this.store.get(workspaceId, conversationId);
    if (!row && direction === 'outbound') return;
    if (!row) row = { workspaceId, conversationId, slaStatus: 'waiting_operator', firstInboundAt: occurredAt, firstResponseAt: null, lastInboundAt: occurredAt, lastOutboundAt: null, lastActivityAt: occurredAt, waitingSinceAt: occurredAt, operatorWaitingMs: 0, customerWaitingMs: 0, totalResponseMs: 0, responseCount: 0, resolvedAt: null, archivedAt: null, frozenAt: null, updatedAt: now };
    if (row.frozenAt) return;
    const elapsed = row.waitingSinceAt ? ms(occurredAt, row.waitingSinceAt) : 0;
    if (direction === 'inbound') { if (row.slaStatus === 'waiting_customer') row.customerWaitingMs += elapsed; else if (row.slaStatus === 'waiting_operator' || row.slaStatus === 'expired') row.operatorWaitingMs += elapsed; row.slaStatus = 'waiting_operator'; row.lastInboundAt = occurredAt; row.waitingSinceAt = occurredAt; }
    else { if (row.slaStatus === 'waiting_operator' || row.slaStatus === 'expired') { row.operatorWaitingMs += elapsed; row.totalResponseMs += ms(occurredAt, row.lastInboundAt); row.responseCount++; if (!row.firstResponseAt) row.firstResponseAt = occurredAt; } row.slaStatus = 'waiting_customer'; row.lastOutboundAt = occurredAt; row.waitingSinceAt = occurredAt; }
    row.lastActivityAt = occurredAt; row.updatedAt = now; await this.store.save(row); await this.publish(workspaceId, row);
  }
  // Ponto único de tradução entre "status operacional" e relógio de SLA. A Inbox
  // manda um status de conversa e o Kanban manda a chave da etapa; os dois
  // vocabulários concordam nos dois nomes terminais, e é só isso que importa aqui.
  // Tudo que não é terminal reabre, então mover um card de volta ou reabrir pela
  // Inbox descongela pelo mesmo caminho e as duas alavancas não podem divergir.
  async applyOperationalStatus(workspaceId: string, conversationId: string, key: string) {
    return key === 'resolved' || key === 'archived'
      ? this.status(workspaceId, conversationId, key)
      : this.reopen(workspaceId, conversationId);
  }
  async status(workspaceId: string, conversationId: string, status: 'resolved' | 'archived') { const row = await this.store.get(workspaceId, conversationId); if (!row || (row.frozenAt && row.slaStatus === status)) return; const now = new Date().toISOString(); if (!row.frozenAt) { const elapsed = row.waitingSinceAt ? ms(now, row.waitingSinceAt) : 0; if (row.slaStatus === 'waiting_customer') row.customerWaitingMs += elapsed; else row.operatorWaitingMs += elapsed; row.waitingSinceAt = null; row.frozenAt = now; } row.slaStatus = status; row.resolvedAt = status === 'resolved' ? now : null; row.archivedAt = status === 'archived' ? now : null; row.updatedAt = now; await this.store.save(row); await this.publish(workspaceId, row); }
  // O tempo parado não é dívida do time: o relógio recomeça agora, não no
  // congelamento. De quem é a vez sai do histórico preservado — se a última
  // mensagem foi nossa, a bola voltou para o cliente.
  async reopen(workspaceId: string, conversationId: string) { const row = await this.store.get(workspaceId, conversationId); if (!row || !row.frozenAt) return; const now = new Date().toISOString(); const answered = !!row.lastOutboundAt && new Date(row.lastOutboundAt).getTime() >= new Date(row.lastInboundAt).getTime(); row.slaStatus = answered ? 'waiting_customer' : 'waiting_operator'; row.waitingSinceAt = now; row.frozenAt = null; row.resolvedAt = null; row.archivedAt = null; row.updatedAt = now; await this.store.save(row); await this.publish(workspaceId, row); }
  async metrics(workspaceId: string, conversationId: string) { const row = await this.store.get(workspaceId, conversationId); return row ? projectSla(row, await this.configFor(workspaceId)) : undefined; }
  async summary(workspaceId: string) { const rows = await this.store.listDue(workspaceId); const config = await this.configFor(workspaceId); const values = rows.map(row => ({ row, metrics: projectSla(row, config) })); const active = values.filter(x => !x.metrics.frozenAt); const count = (indicator: 'green'|'yellow'|'red') => active.filter(x => x.metrics.slaIndicator === indicator).length; const average = (values: Array<number | null>) => { const present = values.filter((value): value is number => value !== null); return present.length ? Math.round(present.reduce((total, value) => total + value, 0) / present.length / 1000) : null; }; const criticalMetrics = active.filter(x => x.metrics.slaIndicator !== 'green').sort((a,b) => { const rank = (x: typeof a) => x.metrics.slaIndicator === 'red' ? 0 : 1; return rank(a) - rank(b) || (new Date(a.metrics.deadlineAt ?? 0).getTime() - new Date(b.metrics.deadlineAt ?? 0).getTime()); }).slice(0, criticalSampleLimit); const identities = new Map((await this.store.criticalConversationIdentities(workspaceId, criticalMetrics.map(x => x.metrics.conversationId))).map(identity => [identity.conversationId, identity])); const critical = criticalMetrics.map(x => { const identity = identities.get(x.metrics.conversationId); const displayName = identity ? preferredName(identity) : null; const phoneNumber = identity ? normalizedPhone(identity.phoneNumber) ?? normalizedPhone(identity.chatId) : null; return { conversationId:x.metrics.conversationId, displayName, phoneNumber, assignedUserId:identity?.assignedUserId ?? null, routingQueueId:identity?.routingQueueId ?? null, status:x.metrics.status, indicator:x.metrics.slaIndicator, deadlineAt:x.metrics.deadlineAt, lastActivityAt:x.metrics.lastActivityAt }; }); return { generatedAt:new Date().toISOString(), totals:{ active:active.length, waitingOperator:active.filter(x => x.metrics.status === 'waiting_operator' || x.metrics.status === 'expired').length, waitingCustomer:active.filter(x => x.metrics.status === 'waiting_customer').length, withinSla:count('green'), warning:count('yellow'), overdue:count('red'), frozen:values.length-active.length }, averages:{ firstResponseSeconds:average(values.map(x => x.metrics.firstResponseTime)), operatorWaitSeconds:average(active.filter(x => x.metrics.status !== 'waiting_customer').map(x => x.metrics.waitingTime)), customerWaitSeconds:average(active.filter(x => x.metrics.status === 'waiting_customer').map(x => x.metrics.waitingTime)) }, percentages:{ withinSla:active.length ? Math.round(count('green') / active.length * 100) : 0 }, critical }; }
  // A escrita é o único ponto de invalidação porque é o único ponto de mudança
  // nesta instância: guardar o valor salvo aqui mantém o cache correto sem uma
  // releitura, e a leitura sem `input` continua servindo o cache.
  async config(workspaceId: string, input?: Partial<SlaConfig>) { if (!input) return this.configFor(workspaceId); const saved = await this.store.saveConfig(workspaceId, { ...await this.configFor(workspaceId), ...input }); this.configCache.set(workspaceId, { value: saved, expiresAt: Date.now() + slaConfigTtlMs }); return saved; }
  // Only an operator-side wait can expire. A customer who goes quiet past the
  // customer threshold is a stale conversation, not a missed team target, and
  // `expired` is grouped with `waiting_operator` everywhere downstream: it would
  // report the customer's silence as operator waiting time and count the
  // conversation as an SLA breach the team never caused.
  //
  // O custo de um tick é a população de workspaces, não a de conversas: as
  // configurações são resolvidas uma vez, antes do laço. Isso repete o efeito do
  // cache de propósito — um tick que demore mais que o TTL não pode voltar a
  // consultar o banco no meio do próprio percurso.
  //
  // A guarda de reentrância é preventiva, e não o diagnóstico: `setInterval` não
  // espera a execução anterior, então um tick mais lento que 60 s passa a se
  // sobrepor a si mesmo e cada cópia refaz o trabalho inteiro. Não é o que
  // acontecia aqui — os ~9,5 s de leituras de configuração medidos acima estão
  // longe dos 60 s —, mas é o que transformaria uma regressão de desempenho em
  // carga multiplicada, que é justamente o caminho de volta ao problema que esta
  // mudança corrige. Pular o disparo é correto porque o próximo vem em 60 s e
  // reavalia o mesmo estado; não há trabalho perdido, só adiado.
  async tick() {
    // Nível de erro de propósito: em operação saudável isto nunca dispara, e
    // quando dispara significa que o relógio de SLA deixou de cumprir a própria
    // cadência — hoje não existe sinal nenhum para essa condição.
    if (this.ticking) { log('error', 'SLA tick skipped: previous run still in progress'); return; }
    this.ticking = true;
    try {
      const rows = await this.store.listDue(); let failed = 0;
      const configs = new Map(await Promise.all([...new Set(rows.map(row => row.workspaceId))].map(async workspaceId => [workspaceId, await this.configFor(workspaceId)] as const)));
      for (const row of rows) try { const config = configs.get(row.workspaceId)!; const projected = projectSla(row, config); if (projected.slaIndicator === 'red' && row.slaStatus === 'waiting_operator') { row.slaStatus = 'expired'; row.updatedAt = new Date().toISOString(); await this.store.save(row); await this.publish(row.workspaceId, row, config); } } catch (error) { failed++; log('error', 'SLA tick item failed', { workspaceId: row.workspaceId, conversationId: row.conversationId, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
      if (failed) log('error', 'SLA tick completed with failures', { due: rows.length, failed });
    } finally { this.ticking = false; }
  }
  private async publish(workspaceId: string, row: Row, config?: SlaConfig) { this.realtime.publish(workspaceId, 'conversation.sla.updated', { conversationId: row.conversationId, metrics: projectSla(row, config ?? await this.configFor(workspaceId)) }); }
}
export class SqliteSlaStore implements SlaStore {
  constructor(private readonly db: SqliteDatabase) {}
  async getConfig(workspaceId: string) { const row = this.db.prepare('SELECT * FROM workspace_sla_config WHERE workspaceId = ?').get(workspaceId) as Record<string, unknown> | undefined; if (!row) return defaults; return { firstResponseThresholdMs: Number(row.firstResponseThresholdMs), operatorWaitingThresholdMs: Number(row.operatorWaitingThresholdMs), customerWaitingThresholdMs: Number(row.customerWaitingThresholdMs), warningRatio: Number(row.warningRatio) }; }
  async saveConfig(workspaceId: string, input: SlaConfig) { this.db.prepare('INSERT INTO workspace_sla_config (workspaceId, firstResponseThresholdMs, operatorWaitingThresholdMs, customerWaitingThresholdMs, warningRatio, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspaceId) DO UPDATE SET firstResponseThresholdMs=excluded.firstResponseThresholdMs, operatorWaitingThresholdMs=excluded.operatorWaitingThresholdMs, customerWaitingThresholdMs=excluded.customerWaitingThresholdMs, warningRatio=excluded.warningRatio, updatedAt=excluded.updatedAt').run(workspaceId, input.firstResponseThresholdMs, input.operatorWaitingThresholdMs, input.customerWaitingThresholdMs, input.warningRatio, new Date().toISOString()); return input; }
  async get(workspaceId: string, conversationId: string) { return this.db.prepare('SELECT * FROM conversation_sla_metrics WHERE workspaceId=? AND conversationId=?').get(workspaceId, conversationId) as Row | undefined; }
  async save(row: Row) { const keys = Object.keys(row); this.db.prepare(`INSERT INTO conversation_sla_metrics (${keys.join(',')}) VALUES (${keys.map(k => '@' + k).join(',')}) ON CONFLICT(workspaceId,conversationId) DO UPDATE SET ${keys.filter(k => !['workspaceId','conversationId'].includes(k)).map(k => `${k}=excluded.${k}`).join(',')}`).run(row); }
  async listDue(workspaceId?: string) { return this.db.prepare(`SELECT * FROM conversation_sla_metrics WHERE frozenAt IS NULL${workspaceId ? ' AND workspaceId = ?' : ''}`).all(...(workspaceId ? [workspaceId] : [])) as Row[]; }
  async criticalConversationIdentities(workspaceId: string, conversationIds: string[]) { if (!conversationIds.length) return []; const placeholders = conversationIds.map(() => '?').join(','); return this.db.prepare(`SELECT c.id conversationId, c.chatId, c.assignedUserId, c.routingQueueId, i.name profileName, i.pushName, i.phone identityPhone, ct.displayName contactName, ct.phoneNumber contactPhone FROM conversations c LEFT JOIN whatsapp_identities i ON i.workspaceId=c.workspaceId AND i.wahaSession=c.wahaSession AND i.whatsappId=c.chatId LEFT JOIN contacts ct ON ct.workspaceId=c.workspaceId AND ct.id=c.contactId WHERE c.workspaceId=? AND c.id IN (${placeholders})`).all(workspaceId, ...conversationIds).map((row: any) => ({ conversationId: row.conversationId, chatId: row.chatId, profileName: row.profileName, pushName: row.pushName, contactName: row.contactName, phoneNumber: row.identityPhone ?? row.contactPhone, assignedUserId: row.assignedUserId, routingQueueId: row.routingQueueId })) as CriticalConversationIdentity[]; }
  async conversationIdForMessage(workspaceId: string, session: string, messageId: string) { const row = this.db.prepare('SELECT c.id FROM whatsapp_messages m JOIN conversations c ON c.workspaceId=m.workspaceId AND c.wahaSession=m.wahaSession AND c.chatId=m.chatId WHERE m.workspaceId=? AND m.wahaSession=? AND m.externalMessageId=?').get(workspaceId, session, messageId) as { id: string } | undefined; return row?.id; }
}
export class SupabaseSlaStore implements SlaStore {
  constructor(private readonly client: SupabaseClient) {}
  async getConfig(workspaceId: string) { const { data, error } = await this.client.from('workspace_sla_config').select('*').eq('workspace_id', workspaceId).maybeSingle(); if (error) throw error; return data ? { firstResponseThresholdMs: Number(data.first_response_threshold_ms), operatorWaitingThresholdMs: Number(data.operator_waiting_threshold_ms), customerWaitingThresholdMs: Number(data.customer_waiting_threshold_ms), warningRatio: Number(data.warning_ratio) } : defaults; }
  async saveConfig(workspaceId: string, input: SlaConfig) { const { error } = await this.client.from('workspace_sla_config').upsert({ workspace_id: workspaceId, first_response_threshold_ms: input.firstResponseThresholdMs, operator_waiting_threshold_ms: input.operatorWaitingThresholdMs, customer_waiting_threshold_ms: input.customerWaitingThresholdMs, warning_ratio: input.warningRatio, updated_at: new Date().toISOString() }); if (error) throw error; return input; }
  async get(workspaceId: string, conversationId: string) { const { data, error } = await this.client.from('conversation_sla_metrics').select('*').eq('workspace_id', workspaceId).eq('conversation_id', conversationId).maybeSingle(); if (error) throw error; return data ? fromRemote(data) : undefined; }
  async save(row: Row) { const { error } = await this.client.from('conversation_sla_metrics').upsert(toRemote(row)); if (error) throw error; }
  async listDue(workspaceId?: string) { let q = this.client.from('conversation_sla_metrics').select('*').is('frozen_at', null); if (workspaceId) q = q.eq('workspace_id', workspaceId); const { data, error } = await q; if (error) throw error; return (data ?? []).map(fromRemote); }
  async criticalConversationIdentities(workspaceId: string, conversationIds: string[]) { if (!conversationIds.length) return []; const { data: conversations, error: conversationError } = await this.client.from('conversations').select('id,chat_id,contact_id,waha_session,assigned_user_id,routing_queue_id').eq('workspace_id', workspaceId).in('id', conversationIds); if (conversationError) throw conversationError; const rows = conversations ?? []; const sessions = [...new Set(rows.map((row: any) => row.waha_session))]; const chatIds = [...new Set(rows.map((row: any) => row.chat_id))]; const contactIds = [...new Set(rows.flatMap((row: any) => row.contact_id ? [row.contact_id] : []))]; const [identities, contacts] = await Promise.all([sessions.length && chatIds.length ? this.client.from('whatsapp_identities').select('waha_session,whatsapp_id,name,push_name,phone').eq('workspace_id', workspaceId).in('waha_session', sessions).in('whatsapp_id', chatIds) : Promise.resolve({ data: [], error: null }), contactIds.length ? this.client.from('contacts').select('id,display_name,phone_number').eq('workspace_id', workspaceId).in('id', contactIds) : Promise.resolve({ data: [], error: null })]); if (identities.error) throw identities.error; if (contacts.error) throw contacts.error; const identityByChat = new Map((identities.data ?? []).map((row: any) => [`${row.waha_session}:${row.whatsapp_id}`, row])); const contactById = new Map((contacts.data ?? []).map((row: any) => [row.id, row])); return rows.map((row: any) => { const identity = identityByChat.get(`${row.waha_session}:${row.chat_id}`); const contact = row.contact_id ? contactById.get(row.contact_id) : undefined; return { conversationId: row.id, chatId: row.chat_id, profileName: identity?.name ?? null, pushName: identity?.push_name ?? null, contactName: contact?.display_name ?? null, phoneNumber: identity?.phone ?? contact?.phone_number ?? null, assignedUserId: row.assigned_user_id ?? null, routingQueueId: row.routing_queue_id ?? null }; }); }
  async conversationIdForMessage(workspaceId: string, session: string, messageId: string) { const { data: message, error } = await this.client.from('whatsapp_messages').select('chat_id').eq('workspace_id', workspaceId).eq('waha_session', session).eq('external_message_id', messageId).maybeSingle(); if (error) throw error; if (!message) return undefined; const { data, error: conversationError } = await this.client.from('conversations').select('id').eq('workspace_id', workspaceId).eq('waha_session', session).eq('chat_id', message.chat_id).maybeSingle(); if (conversationError) throw conversationError; return data?.id; }
}
function toRemote(r: Row) { return { workspace_id:r.workspaceId, conversation_id:r.conversationId, sla_status:r.slaStatus, first_inbound_at:r.firstInboundAt, first_response_at:r.firstResponseAt, last_inbound_at:r.lastInboundAt, last_outbound_at:r.lastOutboundAt, last_activity_at:r.lastActivityAt, waiting_since_at:r.waitingSinceAt, operator_waiting_ms:r.operatorWaitingMs, customer_waiting_ms:r.customerWaitingMs, total_response_ms:r.totalResponseMs, response_count:r.responseCount, resolved_at:r.resolvedAt, archived_at:r.archivedAt, frozen_at:r.frozenAt, updated_at:r.updatedAt }; }
function fromRemote(r: Record<string, unknown>): Row { return { workspaceId:r.workspace_id as string, conversationId:r.conversation_id as string, slaStatus:r.sla_status as SlaStatus, firstInboundAt:r.first_inbound_at as string, firstResponseAt:r.first_response_at as string | null, lastInboundAt:r.last_inbound_at as string, lastOutboundAt:r.last_outbound_at as string | null, lastActivityAt:r.last_activity_at as string, waitingSinceAt:r.waiting_since_at as string | null, operatorWaitingMs:Number(r.operator_waiting_ms), customerWaitingMs:Number(r.customer_waiting_ms), totalResponseMs:Number(r.total_response_ms), responseCount:Number(r.response_count), resolvedAt:r.resolved_at as string | null, archivedAt:r.archived_at as string | null, frozenAt:r.frozen_at as string | null, updatedAt:r.updated_at as string }; }
function technicalIdentifier(value: string) { return /@(?:lid|s\.whatsapp\.net|g\.us|broadcast|newsletter)\b/i.test(value) || /^(?:[a-z0-9_-]+:){2,}[a-z0-9_-]+$/i.test(value); }
function safeName(value: string | null | undefined) { const trimmed = value?.trim(); return trimmed && !technicalIdentifier(trimmed) ? trimmed : null; }
function normalizedPhone(value: string | null | undefined) { if (!value || (technicalIdentifier(value) && !/@c\.us$/i.test(value))) return null; const digits = value.replace(/\D/g, ''); return digits.length >= 8 && digits.length <= 15 ? digits : null; }
function preferredName(identity: CriticalConversationIdentity) { return safeName(identity.profileName) ?? safeName(identity.pushName) ?? safeName(identity.contactName); }
