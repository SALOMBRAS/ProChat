import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RealtimeHub } from '../realtime.js';
import { projectSlaCard, type SlaService } from './sla.service.js';
import { AppError } from '../errors.js';
import type { KanbanFilters, KanbanSource, SessionActivity } from './kanban.service.js';
import type { KanbanAutomationRequest, KanbanAutomationResult } from './kanban-automation.service.js';
import { isKanbanConflict, kanbanRetry, kanbanRetryDelayMs, type KanbanRetry } from './kanban-conflict.js';
import { manualWins, movedByOperator } from './kanban-manual-conflict.js';
import { identityFor, remoteIdentityLookup } from './waha-webhook.service.js';

const defaults = [['new', 'Novo'], ['in_progress', 'Em atendimento'], ['waiting_customer', 'Aguardando cliente'], ['waiting_operator', 'Aguardando operador'], ['resolved', 'Resolvido'], ['archived', 'Arquivado']] as const;
const mapped: Record<string, string> = { open: 'new', in_progress: 'in_progress', waiting_customer: 'waiting_customer', resolved: 'resolved', archived: 'archived' };
const fail = (error: any) => { throw new AppError(error?.code === '40001' ? 409 : 500, error?.code === '40001' ? 'CONFLICT' : 'SERVICE_UNAVAILABLE', error?.message ?? 'Kanban persistence failed'); };

export class SupabaseKanbanService {
  constructor(private readonly client: SupabaseClient, private readonly realtime: RealtimeHub, private readonly sla: SlaService, private readonly retry: KanbanRetry = kanbanRetry(), private readonly activity?: SessionActivity) {}
  async boards(workspaceId: string) { const board = await this.ensureBoard(workspaceId); return [await this.detail(workspaceId, board.id)]; }
  async detail(workspaceId: string, id: string) { const board = await this.board(workspaceId, id); if (!board) throw new AppError(404, 'NOT_FOUND', 'Board not found'); return board; }
  async createBoard(workspaceId: string, name: string) { const now = new Date().toISOString(), id = randomUUID(); const { error } = await this.client.from('kanban_boards').insert({ id, workspace_id: workspaceId, name, is_default: false, created_at: now, updated_at: now }); if (error) fail(error); return this.detail(workspaceId, id); }
  async createStage(workspaceId: string, boardId: string, input: any) { await this.detail(workspaceId, boardId); const { data, error } = await this.client.from('kanban_stages').select('position').eq('board_id', boardId).order('position', { ascending: false }).limit(1); if (error) fail(error); const stage = { id: randomUUID(), board_id: boardId, key: input.key, name: input.name, position: Number(data?.[0]?.position ?? 0) + 1, is_terminal: !!input.isTerminal, is_archived_stage: !!input.isArchivedStage, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; const result = await this.client.from('kanban_stages').insert(stage); if (result.error) fail(result.error); const output = this.stage(stage); this.realtime.publish(workspaceId, 'kanban.stage.created', { boardId, stage: output }); return output; }
  async updateStage(workspaceId: string, stageId: string, input: any) { const stage = await this.requireStage(workspaceId, stageId); const { error } = await this.client.from('kanban_stages').update({ name: input.name ?? stage.name, is_terminal: input.isTerminal ?? stage.isTerminal, is_archived_stage: input.isArchivedStage ?? stage.isArchivedStage, updated_at: new Date().toISOString() }).eq('id', stageId); if (error) fail(error); const output = { ...stage, ...input }; this.realtime.publish(workspaceId, 'kanban.stage.updated', { boardId: stage.boardId, stage: output }); return output; }
  async reorder(workspaceId: string, stageIds: string[]) { const stages = await Promise.all(stageIds.map((id) => this.requireStage(workspaceId, id))); if (!stages.length || stages.some((stage) => stage.boardId !== stages[0].boardId)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid stages'); for (const [index, id] of stageIds.entries()) { const { error } = await this.client.from('kanban_stages').update({ position: index + 1, updated_at: new Date().toISOString() }).eq('id', id); if (error) fail(error); } this.realtime.publish(workspaceId, 'kanban.stage.reordered', { boardId: stages[0].boardId, stageIds }); }
  private activeSessions(workspaceId: string) { return this.activity?.activeSessions({ workspaceId, correlationId: `kanban:${workspaceId}` }) ?? Promise.resolve(undefined); }
  async conversations(workspaceId: string, boardId: string, stageId: string, page: number, pageSize: number, filters: KanbanFilters) {
    await this.detail(workspaceId, boardId); const stage = await this.requireStage(workspaceId, stageId); if (stage.boardId !== boardId) throw new AppError(404, 'NOT_FOUND', 'Stage not found');
    const from = (page - 1) * pageSize;
    // `position` sozinho não é ordem total, e a coluna pagina por `range`. Medido
    // na base em 03/08/2026: 627 cartões em "Novo" ocupam 541 posições — 83 valores
    // repetidos cobrindo 169 cartões, e `position = 1` sozinho é de 5, porque é o
    // que `ensureState` grava em todo cartão novo. Postgres não promete ordem entre
    // linhas empatadas, então o mesmo cartão podia sair em duas páginas ou em
    // nenhuma conforme o operador rolava o quadro.
    //
    // O desempate é atividade primeiro e `conversation_id` por último. O id não é
    // ordem que faça sentido para ninguém: está aqui só para fechar a ordem total
    // quando até a última mensagem empata, que é o que torna a paginação estável.
    // `last_message_at` é NOT NULL nos dois provedores (003_conversations.sql),
    // então não há caso de nulo a tratar de um lado e não do outro.
    // `conversation_metadata` e `conversation_sla_metrics` vêm aninhadas dentro
    // de `conversations`, e não no topo, porque o PostgREST só embeda o que tem
    // chave estrangeira declarada. As duas apontam para `conversations`, não
    // para `conversation_kanban_state`: pedi-las no topo devolve
    // "Could not find a relationship ... in the schema cache" e o quadro não
    // carrega. O SQLite faz JOIN livre e não reclama, então o defeito só
    // aparecia contra o Supabase.
    //
    // Aninhar mantém **uma** consulta: o ganho da #92 fica de pé, e não é
    // preciso criar chave estrangeira nova no banco.
    let query = this.client.from('conversation_kanban_state').select('conversation_id,stage_id,position,updated_at,conversations!inner(id,workspace_id,visibility_state,chat_id,waha_session,contact_id,last_message,last_message_at,unread_count,conversation_type,assigned_user_id,assigned_team_id,routing_queue_id,priority,conversation_metadata(tags),conversation_sla_metrics(sla_status,waiting_since_at,first_response_at,frozen_at))', { count: 'exact' }).eq('workspace_id', workspaceId).eq('board_id', boardId).eq('stage_id', stageId).eq('conversations.visibility_state', 'visible').order('position', { ascending: false }).order('conversations(last_message_at)', { ascending: false }).order('conversation_id', { ascending: true }).range(from, from + pageSize - 1);
    if (filters.unread) query = query.gt('conversations.unread_count', 0); if (filters.type) query = query.eq('conversations.conversation_type', filters.type);
    const { data, error, count } = await query; if (error) fail(error);
    const rows = (data ?? []).filter((row: any) => !filters.search || `${row.conversations.chat_id} ${row.conversations.last_message ?? ''}`.toLowerCase().includes(filters.search.toLowerCase()));
    const config = rows.some((row: any) => row.conversations.conversation_sla_metrics) ? await this.sla.config(workspaceId) : undefined;
    // O nome de quem está do outro lado, para o card não mostrar JID. São três
    // consultas em lote **por página**, as mesmas que a lista da Inbox faz —
    // não uma por cartão. Página vazia não consulta nada.
    const identidades = rows.length ? await remoteIdentityLookup(this.client, rows.map((row: any) => row.conversations)) : undefined;
    return { items: rows.map((row: any) => { const metric = Array.isArray(row.conversations.conversation_sla_metrics) ? row.conversations.conversation_sla_metrics[0] : row.conversations.conversation_sla_metrics; return { conversationId: row.conversation_id, stageId: row.stage_id, position: Number(row.position), updatedAt: row.updated_at, maskedId: row.conversations.chat_id.replace(/\d(?=\d{4})/g, '•'), identity: identidades ? identityFor({ chatId: row.conversations.chat_id, contactId: row.conversations.contact_id, conversationType: row.conversations.conversation_type }, identidades.identity(row.conversations), identidades.group(row.conversations), identidades.contact(row.conversations)) : null, lastMessage: (row.conversations.last_message ?? '').slice(0, 180), lastMessageAt: row.conversations.last_message_at, unreadCount: row.conversations.unread_count, conversationType: row.conversations.conversation_type, assignedUserId: row.conversations.assigned_user_id, assignedTeamId: row.conversations.assigned_team_id, routingQueueId: row.conversations.routing_queue_id, priority: row.conversations.priority, tags: (Array.isArray(row.conversations.conversation_metadata) ? row.conversations.conversation_metadata[0] : row.conversations.conversation_metadata)?.tags ?? [], slaStatus: metric?.sla_status ?? null, sla: metric && config ? projectSlaCard({ slaStatus: metric.sla_status, waitingSinceAt: metric.waiting_since_at, firstResponseAt: metric.first_response_at, frozenAt: metric.frozen_at }, config) : null }; }), page, pageSize, total: count ?? 0 };
  }
  async move(workspaceId: string, actorId: string, conversationId: string, input: any) {
    const stage = await this.requireStage(workspaceId, input.stageId); const position = await this.position(workspaceId, input.boardId, stage.id, input.beforeConversationId, input.afterConversationId);
    const call = (expected: string | null) => this.client.rpc('chatpro_kanban_move', { p_workspace_id: workspaceId, p_conversation_id: conversationId, p_board_id: input.boardId, p_stage_id: input.stageId, p_position: position, p_source: input.source as KanbanSource, p_actor_id: actorId, p_expected_updated_at: expected });
    let { data, error } = await call(input.expectedUpdatedAt ?? null);
    if (error?.code === '40001' && input.source === 'manual') ({ data, error } = await this.retakeForOperator(workspaceId, conversationId, input.boardId, call));
    if (error) fail(error);
    await this.sla.applyOperationalStatus(workspaceId, conversationId, stage.key); const row = Array.isArray(data) ? data[0] : data; this.realtime.publish(workspaceId, 'conversation.kanban.moved', { conversationId, boardId: input.boardId, fromStageId: row?.from_stage_id ?? null, toStageId: stage.id, state: { updatedAt: row?.updated_at } }); return row;
  }
  /**
   *  Uma pessoa arrastou o card e perdeu a corrida. Relê o estado e pergunta
   *  **quem** ganhou: automação, e a pessoa passa por cima com a versão fresca;
   *  outro operador, e ela recebe um 409 que diz para onde o card foi.
   *
   *  Uma tentativa só. Um laço aqui disputaria com a automação indefinidamente
   *  numa conversa movimentada, e o primeiro `move` manual já grava
   *  `manual_override`, que tira a automação daquele card — então a segunda
   *  tentativa é a que basta.
   */
  private async retakeForOperator(workspaceId: string, conversationId: string, boardId: string, call: (expected: string | null) => any) {
    const { data, error } = await this.client.from('conversation_kanban_state').select('stage_id,updated_at,last_transition_source,kanban_stages!inner(name)').eq('workspace_id', workspaceId).eq('conversation_id', conversationId).eq('board_id', boardId).maybeSingle();
    if (error) fail(error);
    if (!data) return call(null); // A linha sumiu entre as duas leituras: não há versão a defender.
    if (!manualWins(data.last_transition_source)) throw movedByOperator({ id: data.stage_id, name: (data.kanban_stages as any).name });
    return call(data.updated_at);
  }
  async history(workspaceId: string, conversationId: string) { const { data, error } = await this.client.from('conversation_kanban_events').select('*').eq('workspace_id', workspaceId).eq('conversation_id', conversationId).order('created_at', { ascending: false }); if (error) fail(error); return data ?? []; }
  async automated(request: KanbanAutomationRequest): Promise<KanbanAutomationResult> {
    if (request.historical || request.imported || request.replay || request.technical || request.quarantined || !request.visible) return { status: 'skipped', reason: 'ineligible_origin' };
    const board = await this.ensureBoard(request.workspaceId);
    let claimed = false;
    let stateEnsured = false;
    // Each attempt re-reads the state, so the retry asks a fresh question. The
    // message is claimed once: it is the same delivery being settled, not a new one.
    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      const { data, error } = await this.client.from('conversation_kanban_state').select('stage_id,manual_override,updated_at,kanban_stages!inner(key)').eq('workspace_id', request.workspaceId).eq('conversation_id', request.conversationId).eq('board_id', board.id).maybeSingle(); if (error) fail(error);
      if (!data && !stateEnsured) { stateEnsured = true; if (await this.ensureState(request.workspaceId, request.conversationId, board)) continue; }
      if (!data || data.manual_override) return { status: 'skipped', reason: data?.manual_override ? 'manual_override' : 'missing_state' };
      const key = (data.kanban_stages as any).key, target = request.direction === 'inbound' && key === 'waiting_customer' ? 'waiting_operator' : request.direction === 'outbound' && ['new', 'waiting_operator', 'in_progress'].includes(key) ? 'waiting_customer' : undefined;
      if (!target) return { status: 'skipped', reason: 'stage_rule' };
      if (!claimed) { const claim = await this.client.from('kanban_automation_deliveries').insert({ workspace_id: request.workspaceId, conversation_id: request.conversationId, message_id: request.messageId, direction: request.direction }); if (claim.error?.code === '23505') return { status: 'skipped', reason: 'duplicate' }; if (claim.error) fail(claim.error); claimed = true; }
      const next = board.stages.find((item: any) => item.key === target);
      if (!next) return { status: 'skipped', reason: 'missing_target' };
      try { await this.move(request.workspaceId, '00000000-0000-4000-8000-000000000001', request.conversationId, { boardId: board.id, stageId: next.id, source: request.direction, expectedUpdatedAt: data.updated_at }); return { status: 'moved' }; }
      catch (moveError) { if (!isKanbanConflict(moveError) || attempt === this.retry.attempts) throw moveError; await this.retry.sleep(kanbanRetryDelayMs(attempt, this.retry.random)); }
    }
    return { status: 'failed', reason: 'conflict_exhausted' };
  }
  /**
   *  O quadro e as etapas padrão, sem tocar em conversa nenhuma. É O(1) — um
   *  quadro, seis etapas — e é o que sobrou de `ensure()` nos caminhos quentes.
   *  Devolve id e etapas cruas: quem precisa das contagens por etapa chama
   *  `detail()`, que é onde as seis requisições `HEAD` moram.
   */
  protected async ensureBoard(workspaceId: string): Promise<{ id: string; stages: Array<{ id: string; key: string }> }> { const now = new Date().toISOString(); const { data: existing, error: findError } = await this.client.from('kanban_boards').select('id').eq('workspace_id', workspaceId).eq('is_default', true).maybeSingle(); if (findError) fail(findError); let id = existing?.id; if (!id) { id = randomUUID(); const result = await this.client.from('kanban_boards').insert({ id, workspace_id: workspaceId, name: 'Opera\u00e7\u00e3o', is_default: true, created_at: now, updated_at: now }); if (result.error) { const retry = await this.client.from('kanban_boards').select('id').eq('workspace_id', workspaceId).eq('is_default', true).single(); if (retry.error || !retry.data) fail(retry.error ?? { message: 'default board missing' }); id = retry.data!.id; } } const found = await this.client.from('kanban_stages').select('id,key,position').eq('board_id', id); if (found.error) fail(found.error); const known = new Set((found.data ?? []).map((stage: any) => stage.key)); let position = Math.max(0, ...(found.data ?? []).map((stage: any) => Number(stage.position))); const missing = defaults.filter(([key]) => !known.has(key)).map(([key, name]) => ({ id: randomUUID(), board_id: id!, key, name, position: ++position, is_terminal: key === 'resolved' || key === 'archived', is_archived_stage: key === 'archived', created_at: now, updated_at: now })); if (!missing.length) return { id: id!, stages: (found.data ?? []).map((stage: any) => ({ id: stage.id, key: stage.key })) }; const inserted = await this.client.from('kanban_stages').insert(missing); if (inserted.error) fail(inserted.error); return { id: id!, stages: [...(found.data ?? []).map((stage: any) => ({ id: stage.id, key: stage.key })), ...missing.map(stage => ({ id: stage.id, key: stage.key }))] }; }
  /**
   *  O reparo em massa: dá linha de estado a toda conversa visível que ainda não
   *  tem. É O(conversas) — uma leitura sem limite mais uma escrita do mesmo
   *  tamanho — e por isso saiu do caminho de leitura e do de ingestão. Idempotente.
   */
  async backfillStates(workspaceId: string) { const board = await this.ensureBoard(workspaceId); const now = new Date().toISOString(); const byKey = Object.fromEntries(board.stages.map(stage => [stage.key, stage.id])); /* O filtro fica aqui porque este é o único caminho que ainda varre conversa: `ensureBoard` é O(1) e `automated` cria só a linha da conversa que a mensagem toca. */ const active = await this.activeSessions(workspaceId); let visibleQuery = this.client.from('conversations').select('id,status').eq('workspace_id', workspaceId).eq('visibility_state', 'visible'); if (active) visibleQuery = visibleQuery.in('waha_session', [...active]); const visible = await visibleQuery; if (visible.error) fail(visible.error); const rows = (visible.data ?? []).map((conversation: any, index: number) => ({ workspace_id: workspaceId, conversation_id: conversation.id, board_id: board.id, stage_id: byKey[mapped[conversation.status] ?? 'new'], position: index + 1, manual_override: false, last_transition_source: 'system', last_transition_by: null, last_transition_at: now, created_at: now, updated_at: now })); if (!rows.length) return { boardId: board.id, examined: 0, created: 0 }; const inserted = await this.client.from('conversation_kanban_state').upsert(rows, { onConflict: 'conversation_id,board_id', ignoreDuplicates: true }).select('conversation_id'); if (inserted.error) fail(inserted.error); return { boardId: board.id, examined: rows.length, created: (inserted.data ?? []).length }; }
  /**
   *  A linha de estado da conversa que ESTA mensagem toca, e só dela — o que
   *  substitui, na ingestão, a varredura de todas as conversas. Não cobre origem
   *  que `automated()` recusa antes de chegar aqui; essas dependem do reparo.
   */
  protected async ensureState(workspaceId: string, conversationId: string, board: { id: string; stages: Array<{ id: string; key: string }> }) { const { data, error } = await this.client.from('conversations').select('status').eq('workspace_id', workspaceId).eq('id', conversationId).eq('visibility_state', 'visible').maybeSingle(); if (error) fail(error); if (!data) return false; const stage = board.stages.find(item => item.key === (mapped[data.status] ?? 'new')); if (!stage) return false; const now = new Date().toISOString();
    // O cartão nasce NO TOPO do seu estágio, não em `position = 1`.
    //
    // A leitura ordena `position DESC`, então 1 é o fim da fila: gravar 1 punha
    // toda conversa nova no rodapé da coluna. Medido na produção em 03/08/2026,
    // antes desta correção — os cartões em `position = 1` eram os de 01/08, 02/08
    // e 03/08, isto é, as conversas mais recentes da base estavam no fim de 627.
    //
    // O PostgREST não expõe `max()`, então o topo é `order desc limit 1`. É uma
    // leitura a mais e ela só acontece aqui, no caminho que já sabe que a linha
    // não existe (`!data` no chamador): cartão que já tem estado não paga nada.
    //
    // Duas mensagens simultâneas podem ler o mesmo topo e gravar a mesma posição.
    // O empate é inofensivo desde a #113: a leitura desempata por última mensagem
    // e por id, então a ordem continua total.
    const highest = await this.client.from('conversation_kanban_state').select('position').eq('workspace_id', workspaceId).eq('board_id', board.id).eq('stage_id', stage.id).order('position', { ascending: false }).limit(1).maybeSingle();
    if (highest.error) fail(highest.error);
    const position = Number(highest.data?.position ?? 0) + 1;
    const inserted = await this.client.from('conversation_kanban_state').upsert([{ workspace_id: workspaceId, conversation_id: conversationId, board_id: board.id, stage_id: stage.id, position, manual_override: false, last_transition_source: 'system', last_transition_by: null, last_transition_at: now, created_at: now, updated_at: now }], { onConflict: 'conversation_id,board_id', ignoreDuplicates: true }); if (inserted.error) fail(inserted.error); return true; }
  private async board(workspaceId: string, id: string) { const { data, error } = await this.client.from('kanban_boards').select('*,kanban_stages(*)').eq('workspace_id', workspaceId).eq('id', id).maybeSingle(); if (error) fail(error); if (!data) return undefined; const active = await this.activeSessions(workspaceId); const stages = await Promise.all((data.kanban_stages ?? []).sort((a: any, b: any) => Number(a.position) - Number(b.position)).map(async (stage: any) => { let query = this.client.from('conversation_kanban_state').select('conversation_id,conversations!inner(visibility_state,waha_session)', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('board_id', id).eq('stage_id', stage.id).eq('conversations.visibility_state', 'visible'); if (active) query = query.in('conversations.waha_session', [...active]); const result = await query; if (result.error) fail(result.error); return { ...this.stage(stage), count: result.count ?? 0 }; })); return { id: data.id, workspaceId: data.workspace_id, name: data.name, isDefault: data.is_default, createdAt: data.created_at, updatedAt: data.updated_at, stages }; }
  private async requireStage(workspaceId: string, id: string) { const { data, error } = await this.client.from('kanban_stages').select('*,kanban_boards!inner(workspace_id)').eq('id', id).maybeSingle(); if (error) fail(error); if (!data || (data.kanban_boards as any).workspace_id !== workspaceId) throw new AppError(404, 'NOT_FOUND', 'Stage not found'); return this.stage(data); }
  private stage(value: any) { return { id: value.id, boardId: value.board_id, key: value.key, name: value.name, position: Number(value.position), isTerminal: !!value.is_terminal, isArchivedStage: !!value.is_archived_stage, createdAt: value.created_at, updatedAt: value.updated_at }; }
  private async position(workspaceId: string, boardId: string, stageId: string, before?: string, after?: string) { const get = async (id?: string) => { if (!id) return undefined; const { data, error } = await this.client.from('conversation_kanban_state').select('position').eq('workspace_id', workspaceId).eq('board_id', boardId).eq('conversation_id', id).maybeSingle(); if (error) fail(error); return data; }; const [afterRow, beforeRow] = await Promise.all([get(after), get(before)]); if (afterRow?.position !== undefined && beforeRow?.position !== undefined) return (Number(afterRow.position) + Number(beforeRow.position)) / 2; if (afterRow?.position !== undefined) return Number(afterRow.position) + 1; if (beforeRow?.position !== undefined) return Number(beforeRow.position) - 1; const { data, error } = await this.client.from('conversation_kanban_state').select('position').eq('workspace_id', workspaceId).eq('board_id', boardId).eq('stage_id', stageId).order('position', { ascending: false }).limit(1); if (error) fail(error); return Number(data?.[0]?.position ?? 0) + 1; }
}
