import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteDatabase } from '../persistence/database.js';
import { InternalWorkerClient } from '../internal-worker-client.js';
import type { RealtimeHub } from '../realtime.js';
import { log } from '../logging.js';
import { historyRecord, type WahaWebhookStore } from './waha-webhook.service.js';
import { isConversationChatId } from './conversation-identity.js';

export type SyncStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type SyncJob = { id: string; workspaceId: string; wahaSession: string; status: SyncStatus; currentChatId: string | null; chatCursor: string | null; messageCursor: string | null; chatsProcessed: number; messagesProcessed: number; chatsTotal: number | null; startedAt: string; completedAt: string | null; lastErrorSafe: string | null; updatedAt: string };
export type SyncJobStatus = SyncJob & { jobId: string; currentChat: string | null; hasMore: boolean; progressLabel: string };
export type SyncJobStore = { get(workspaceId: string, wahaSession: string): Promise<SyncJob | undefined>; save(job: SyncJob): Promise<void> };
export type HistorySyncOptions = { chatPageSize?: number; messagePageSize?: number; maxChatsPerRun?: number; maxMessagesPerRun?: number; emergencyMaxMessages?: number; continuationDelayMs?: number; maxAttempts?: number; retryBaseMs?: number; maxConsecutiveChatTimeouts?: number; staleRunningAfterMs?: number; maxCountedChats?: number; sleep?: (milliseconds: number) => Promise<void> };
export type HistorySyncRunLimits = { maxChatsPerRun?: number; maxMessagesPerRun?: number };
const transientCodes = new Set(['TIMEOUT', 'SERVICE_UNAVAILABLE']);
// A provider timeout while paginating one chat is scoped to that chat. The WAHA
// WEBJS engine pays a cost proportional to the requested offset, so a chat long
// enough can never be paginated to its end: every retry asks for the same deep
// offset and times out again. Closing that chat with the history already
// persisted keeps the remaining chats syncing instead of failing the whole job.
const chatScopedCodes = new Set(['TIMEOUT']);

export class WhatsAppHistorySyncService {
  private readonly active = new Set<string>();
  private readonly cancelling = new Set<string>();
  private readonly starts = new Map<string, Promise<SyncJobStatus>>();
  private readonly options: Required<Omit<HistorySyncOptions, 'sleep'>> & { sleep: (milliseconds: number) => Promise<void> };

  constructor(private readonly worker: InternalWorkerClient, private readonly messages: WahaWebhookStore, private readonly jobs: SyncJobStore, private readonly realtime: RealtimeHub, options: HistorySyncOptions = {}) {
    this.options = {
      chatPageSize: options.chatPageSize ?? 25,
      messagePageSize: options.messagePageSize ?? 100,
      maxChatsPerRun: options.maxChatsPerRun ?? 25,
      maxMessagesPerRun: options.maxMessagesPerRun ?? 1_000,
      emergencyMaxMessages: options.emergencyMaxMessages ?? 100_000,
      continuationDelayMs: options.continuationDelayMs ?? 1_000,
      maxAttempts: options.maxAttempts ?? 3,
      retryBaseMs: options.retryBaseMs ?? 250,
      maxConsecutiveChatTimeouts: options.maxConsecutiveChatTimeouts ?? 5,
      staleRunningAfterMs: options.staleRunningAfterMs ?? 300_000,
      maxCountedChats: options.maxCountedChats ?? 200_000,
      sleep: options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    };
  }

  start(workspaceId: string, wahaSession: string, limits: HistorySyncRunLimits = {}): Promise<SyncJobStatus> {
    const key = this.key(workspaceId, wahaSession);
    const starting = this.starts.get(key);
    if (starting) return starting;
    const result = this.createStart(workspaceId, wahaSession, this.limits(limits)).finally(() => this.starts.delete(key));
    this.starts.set(key, result);
    return result;
  }

  private async createStart(workspaceId: string, wahaSession: string, limits: Required<HistorySyncRunLimits>): Promise<SyncJobStatus> {
    const key = this.key(workspaceId, wahaSession);
    const previous = await this.jobs.get(workspaceId, wahaSession);
    if (previous && (this.active.has(key) || (previous.status === 'running' && !this.abandoned(previous)))) return this.view(previous);
    this.cancelling.delete(key);
    const now = new Date().toISOString();
    const job: SyncJob = previous && previous.status === 'completed'
      // Corrida nova conta de novo: a conta pode ter crescido desde a anterior.
      ? { ...previous, status: 'pending', currentChatId: null, chatCursor: '0', messageCursor: null, chatsProcessed: 0, messagesProcessed: 0, chatsTotal: null, startedAt: now, completedAt: null, lastErrorSafe: null, updatedAt: now }
      : previous
        ? { ...previous, status: 'pending', completedAt: null, lastErrorSafe: null, updatedAt: now }
        : { id: randomUUID(), workspaceId, wahaSession, status: 'pending', currentChatId: null, chatCursor: '0', messageCursor: null, chatsProcessed: 0, messagesProcessed: 0, chatsTotal: null, startedAt: now, completedAt: null, lastErrorSafe: null, updatedAt: now };
    await this.save(job, previous?.status === 'running' ? 'adopted after an interrupted run' : previous?.status === 'failed' || previous?.status === 'cancelled' ? 'resumed manually' : 'started');
    this.launch(job, limits);
    return this.view(job);
  }

  /**
   * `active` only knows about runs started by this process, so a job whose run
   * died with the process stays `running` in the store forever: `start` would
   * keep returning that view without relaunching, and the Inbox disables the
   * button while the status reads `running`. A live run writes its checkpoint on
   * every page, so silence far longer than one page means nobody owns the job
   * and its checkpoint can be adopted.
   */
  private abandoned(job: SyncJob): boolean {
    const updatedAt = Date.parse(job.updatedAt);
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= this.options.staleRunningAfterMs;
  }

  async status(workspaceId: string, wahaSession: string): Promise<SyncJobStatus | undefined> {
    const job = await this.jobs.get(workspaceId, wahaSession);
    return job ? this.view(job) : undefined;
  }

  async cancel(workspaceId: string, wahaSession: string): Promise<SyncJobStatus | undefined> {
    const job = await this.jobs.get(workspaceId, wahaSession);
    if (!job || job.status === 'completed') return job ? this.view(job) : undefined;
    // A run in this process reads this instead of the store while it walks a
    // page, so cancelling still takes effect between two messages.
    this.cancelling.add(this.key(workspaceId, wahaSession));
    return this.view(await this.save({ ...job, status: 'cancelled', updatedAt: new Date().toISOString() }, 'cancelled'));
  }

  private launch(job: SyncJob, limits: Required<HistorySyncRunLimits>): void {
    const key = this.key(job.workspaceId, job.wahaSession);
    if (this.active.has(key)) return;
    this.active.add(key);
    setImmediate(() => {
      // A detached task must always consume its own rejection. `finally` returns
      // a rejecting promise too, which previously surfaced as an unhandled
      // rejection and could terminate Node.
      void this.run(job.workspaceId, job.wahaSession, limits)
        .catch(error => log('error', 'WhatsApp history synchronization failed', { workspaceId: job.workspaceId, wahaSession: job.wahaSession, error: error instanceof Error ? error.stack ?? error.message : String(error) }))
        .finally(() => this.active.delete(key));
    });
  }

  private async run(workspaceId: string, wahaSession: string, limits: Required<HistorySyncRunLimits>): Promise<void> {
    const key = this.key(workspaceId, wahaSession);
    let job = await this.jobs.get(workspaceId, wahaSession);
    if (!job || job.status === 'cancelled') return;
    try {
      job = await this.save({ ...job, status: 'running', updatedAt: new Date().toISOString() }, 'running');
      // O denominador do progresso. Contado aqui dentro, e não em `start`, para o
      // endpoint não pagar a latência; a Inbox está em polling e pega o número no
      // tique seguinte. Falha aberta: sem total, a corrida segue sem porcentagem.
      if (job.chatsTotal === null) {
        const chatsTotal = await this.countChats(job);
        if (chatsTotal !== null) job = await this.save({ ...job, chatsTotal, updatedAt: new Date().toISOString() }, 'chat total counted');
      }
      let chatsThisBatch = 0;
      let messagesThisBatch = 0;
      let messagesThisExecution = 0;
      let consecutiveChatTimeouts = 0;
      let listing: { offset: number; items: Record<string, unknown>[] } | undefined;
      const visited = new Set<string>();
      while (job.status === 'running') {
        job = await this.current(job);
        if (job.status === 'cancelled') return;
        if (messagesThisExecution >= this.options.emergencyMaxMessages) {
          await this.save({ ...job, status: 'pending', updatedAt: new Date().toISOString() }, 'paused at emergency execution guard');
          return;
        }
        if (chatsThisBatch >= limits.maxChatsPerRun || messagesThisBatch >= limits.maxMessagesPerRun) {
          job = await this.save({ ...job, status: 'pending', updatedAt: new Date().toISOString() }, 'batch checkpoint persisted; continuing automatically');
          await this.options.sleep(this.options.continuationDelayMs);
          job = await this.current(job);
          if (job.status === 'cancelled') return;
          job = await this.save({ ...job, status: 'running', updatedAt: new Date().toISOString() }, 'next batch started');
          chatsThisBatch = 0;
          messagesThisBatch = 0;
          continue;
        }
        if (!job.currentChatId) {
          const offset = integerCursor(job.chatCursor);
          // One listing served one chat, so a run over 550 conversations asked
          // WAHA for 550 pages of 25 to use one entry from each. Keeping the page
          // until it runs out asks once per 25 conversations, and every chat in
          // it comes from the same snapshot: WAHA sorts chats by recency, so
          // re-deriving a position from a freshly ordered list between two chats
          // is what let an arriving message shift the cursor under the job.
          if (!listing || offset < listing.offset || offset - listing.offset >= listing.items.length) {
            const page = await this.page(job, undefined, offset, this.options.chatPageSize);
            if (!page.items.length) {
              if (page.hasMore) {
                job = await this.save({ ...job, chatCursor: String(offset + this.options.chatPageSize), chatsProcessed: job.chatsProcessed + this.options.chatPageSize, updatedAt: new Date().toISOString() }, 'skipped unsupported chat page');
                continue;
              }
              await this.save({ ...job, status: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 'completed');
              return;
            }
            listing = { offset, items: page.items };
          }
          const candidate = listing.items[offset - listing.offset];
          const chatId = typeof candidate.id === 'string' && isConversationChatId(candidate.id) ? candidate.id : null;
          if (!chatId) {
            job = await this.save({ ...job, chatCursor: String(offset + 1), chatsProcessed: job.chatsProcessed + 1, updatedAt: new Date().toISOString() }, 'skipped invalid chat');
            continue;
          }
          // A chat that receives a message jumps to the top of the listing and
          // pushes the ones behind it down, so the cursor can land on a chat this
          // run already walked. Its history is on disk and anything newer arrives
          // by webhook, so paginating it again would only re-read it.
          if (visited.has(chatId)) {
            job = await this.save({ ...job, chatCursor: String(offset + 1), chatsProcessed: job.chatsProcessed + 1, updatedAt: new Date().toISOString() }, 'skipped a chat already synchronized in this run');
            continue;
          }
          visited.add(chatId);
          job = await this.save({ ...job, currentChatId: chatId, messageCursor: '0', updatedAt: new Date().toISOString() }, 'chat selected');
          continue;
        }
        const offset = integerCursor(job.messageCursor);
        const remainingMessages = limits.maxMessagesPerRun - messagesThisBatch;
        let page: { items: Record<string, unknown>[]; hasMore: boolean };
        try {
          page = await this.page(job, job.currentChatId, offset, Math.min(this.options.messagePageSize, remainingMessages));
          // Any page that comes back proves the provider is answering, so the
          // degraded-provider count below only ever reaches its threshold
          // through chats that yielded nothing at all. That is what keeps a run
          // of very long conversations, which always read their first pages
          // before timing out deeper, from being mistaken for an outage.
          consecutiveChatTimeouts = 0;
        } catch (error) {
          if (!chatScopedCodes.has(errorCode(error))) throw error;
          consecutiveChatTimeouts += 1;
          // Consecutive timeouts across different chats mean the provider itself
          // is degraded, not that one chat is too long. Fail the job so the
          // operator sees it, instead of marking every chat as processed.
          if (consecutiveChatTimeouts >= this.options.maxConsecutiveChatTimeouts) throw error;
          const closedChatId = job.currentChatId;
          chatsThisBatch += 1;
          job = await this.save({ ...job, currentChatId: null, messageCursor: null, chatCursor: String(integerCursor(job.chatCursor) + 1), chatsProcessed: job.chatsProcessed + 1, lastErrorSafe: safeError(error), updatedAt: new Date().toISOString() }, 'chat closed early after repeated provider timeout');
          log('info', 'WhatsApp history sync closed a chat early', { workspaceId, wahaSession, jobId: job.id, chatId: closedChatId, offset, attempts: offset > 0 ? 1 : this.options.maxAttempts });
          continue;
        }
        for (const message of page.items) {
          // Re-reading the stored job between every two messages cost one
          // database round trip per message — 162 ms each against the remote
          // instance, about a fifth of a run's wall time — to answer a question
          // only `cancel` can change, and `cancel` runs in this process. The
          // store is still read once per page below, which also covers a cancel
          // written by anything outside it.
          if (this.cancelling.has(key)) return;
          const record = historyRecord(workspaceId, wahaSession, message, job.currentChatId);
          if (record) await this.messages.ingest(record);
          messagesThisBatch += 1;
          messagesThisExecution += 1;
        }
        job = await this.current(job);
        if (job.status === 'cancelled') return;
        if (page.hasMore) {
          job = await this.save({ ...job, messageCursor: String(offset + page.items.length), messagesProcessed: job.messagesProcessed + page.items.length, updatedAt: new Date().toISOString() }, 'message page persisted');
        } else {
          chatsThisBatch += 1;
          job = await this.save({ ...job, currentChatId: null, messageCursor: null, chatCursor: String(integerCursor(job.chatCursor) + 1), chatsProcessed: job.chatsProcessed + 1, messagesProcessed: job.messagesProcessed + page.items.length, updatedAt: new Date().toISOString() }, 'chat completed');
        }
      }
    } catch (error) {
      if (!job) return;
      const latest = await this.current(job);
      if (latest.status !== 'cancelled') await this.save({ ...latest, status: 'failed', lastErrorSafe: safeError(error), updatedAt: new Date().toISOString() }, 'failed');
    }
  }

  /** Quantos chats a sessão tem, para o progresso ter denominador.
   *
   *  A WAHA 2026.7.1 não tem rota de contagem para chats — tem para grupos e para
   *  LIDs, não para chats. `GET /api/{sessão}/chats` devolve array puro, sem
   *  envelope e sem cabeçalho de total, então contar significaria receber os
   *  552 objetos (2,7 MB medidos nesta conta) só para tirar o `length`.
   *
   *  Em vez disso: rampa exponencial e busca binária sobre o `offset`, pedindo uma
   *  página de **um** item. O WEBJS fatia antes de serializar, então cada sonda
   *  transfere um chat, não a lista. Medido nesta conta: 552 exatos em 20 sondas,
   *  299 KB, 0,136 s — contra 2,7 MB e 0,47 s de varrer tudo. E não degrada quando
   *  a conta cresce, que é por que a busca binária foi escolhida em vez da
   *  varredura (ver web/docs/history-sync-chats-total.md).
   *
   *  **Ramifica em `hasMore`, nunca em `items.length`.** `hasMore` é medido antes
   *  do filtro (`listChats` em waha-client.ts), e é isso que torna a sonda uma
   *  pergunta sobre a posição existir. `items.length` é depois do filtro, e
   *  `status@broadcast` ocupa uma posição real: com a ordenação por recência ele
   *  pode cair no offset 0, e uma sonda que olhasse `items.length` leria a lista
   *  inteira como vazia.
   */
  private async countChats(job: SyncJob): Promise<number | null> {
    // Uma sonda pergunta "existe chat nesta posição?" — nada mais.
    const occupied = async (offset: number) => (await this.page(job, undefined, offset, 1)).hasMore;
    // Zero desliga a contagem: é a válvula operacional para uma conta grande, e o
    // que os testes que não são sobre contagem usam para manter a sequência de
    // chamadas ao provedor sob análise.
    if (this.options.maxCountedChats <= 0) return null;
    try {
      if (!(await occupied(0))) return 0;
      // Rampa: dobra até passar do fim, para a busca binária começar com limites.
      let low = 0;
      let high = 1;
      while (await occupied(high)) {
        low = high;
        high *= 2;
        // Teto de sanidade. Uma conta maior que isto não existe no WhatsApp, e sem
        // o limite um `hasMore` sempre verdadeiro sondaria para sempre.
        if (high > this.options.maxCountedChats) return null;
      }
      // `low` está ocupado, `high` não. O total é o primeiro offset vazio.
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (await occupied(middle)) low = middle; else high = middle;
      }
      return high;
    } catch (error) {
      // Falha aberta: a corrida vale mais que a barra de progresso.
      log('info', 'WhatsApp history sync could not count chats', { workspaceId: job.workspaceId, wahaSession: job.wahaSession, jobId: job.id, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private async page(job: SyncJob, chatId: string | undefined, offset: number, limit: number): Promise<{ items: Record<string, unknown>[]; hasMore: boolean }> {
    let last: ProviderFailure | undefined;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      // No deadline of its own: the transport client already carries the budget
      // the deployment configured, and the worker spends that same budget across
      // however many provider calls one page needs. A second number here is what
      // used to let the two drift apart.
      const response = await this.worker.send({ correlationId: `history-sync-${randomUUID()}`, workspaceId: job.workspaceId, command: { type: 'history.page', payload: { wahaSession: job.wahaSession, ...(chatId ? { chatId } : {}), offset, limit } } });
      if (response.success) {
        const page = (response.data as { historyPage?: { items?: Record<string, unknown>[]; hasMore?: boolean } }).historyPage;
        if (!page) throw new ProviderFailure('PROVIDER_CONTRACT_ERROR');
        return { items: page.items ?? [], hasMore: page.hasMore === true };
      }
      last = new ProviderFailure(response.error.code, response.error.message);
      if (!retryable(last.code, chatId, offset) || attempt === this.options.maxAttempts) throw last;
      await this.options.sleep(Math.min(this.options.retryBaseMs * 2 ** (attempt - 1), 4_000));
    }
    throw last ?? new ProviderFailure('SERVICE_UNAVAILABLE');
  }

  private async current(job: SyncJob): Promise<SyncJob> { return (await this.jobs.get(job.workspaceId, job.wahaSession)) ?? job; }

  private async save(job: SyncJob, event: string): Promise<SyncJob> {
    await this.jobs.save(job);
    const status = this.view(job);
    this.realtime.publish(job.workspaceId, 'conversation.sync.updated', { jobId: status.jobId, wahaSession: job.wahaSession, status: job.status, chatsProcessed: job.chatsProcessed, messagesProcessed: job.messagesProcessed, chatsTotal: job.chatsTotal, currentChat: status.currentChat, hasMore: status.hasMore, progressLabel: status.progressLabel, lastErrorSafe: job.lastErrorSafe, updatedAt: job.updatedAt });
    log('info', 'WhatsApp history sync', { workspaceId: job.workspaceId, wahaSession: job.wahaSession, jobId: job.id, event, status: job.status, chatsProcessed: job.chatsProcessed, messagesProcessed: job.messagesProcessed });
    return job;
  }

  private view(job: SyncJob): SyncJobStatus {
    const progressLabel = job.status === 'completed'
      ? job.lastErrorSafe
        // A completed run that closed at least one chat early is not a failure,
        // but hiding the truncation would misreport the history as exhaustive.
        ? 'Histórico sincronizado; conversas muito longas foram truncadas.'
        : 'Histórico sincronizado.'
      : job.status === 'running'
        ? 'Sincronizando histórico…'
        : job.status === 'pending'
            ? 'Aguardando próximo ciclo…'
            : job.status === 'failed'
              ? 'Falhou; corrija o problema e retome.'
              : 'Sincronização cancelada.';
    return { ...job, jobId: job.id, currentChat: job.currentChatId, hasMore: job.status === 'running' || job.status === 'pending', progressLabel };
  }

  private limits(limits: HistorySyncRunLimits): Required<HistorySyncRunLimits> { return { maxChatsPerRun: limits.maxChatsPerRun ?? this.options.maxChatsPerRun, maxMessagesPerRun: limits.maxMessagesPerRun ?? this.options.maxMessagesPerRun }; }
  private key(workspaceId: string, wahaSession: string): string { return `${workspaceId}:${wahaSession}`; }
}

export class SqliteWhatsAppHistorySyncStore implements SyncJobStore {
  constructor(private readonly db: SqliteDatabase) {}
  async get(workspaceId: string, wahaSession: string) { const row = this.db.prepare('SELECT * FROM whatsapp_sync_jobs WHERE workspaceId=? AND wahaSession=?').get(workspaceId, wahaSession) as Record<string, unknown> | undefined; return row ? sqliteJob(row) : undefined; }
  async save(job: SyncJob) { this.db.prepare('INSERT INTO whatsapp_sync_jobs (id,workspaceId,wahaSession,status,currentChatId,chatCursor,messageCursor,chatsProcessed,messagesProcessed,chatsTotal,startedAt,completedAt,lastErrorSafe,updatedAt) VALUES (@id,@workspaceId,@wahaSession,@status,@currentChatId,@chatCursor,@messageCursor,@chatsProcessed,@messagesProcessed,@chatsTotal,@startedAt,@completedAt,@lastErrorSafe,@updatedAt) ON CONFLICT(workspaceId,wahaSession) DO UPDATE SET status=excluded.status,currentChatId=excluded.currentChatId,chatCursor=excluded.chatCursor,messageCursor=excluded.messageCursor,chatsProcessed=excluded.chatsProcessed,messagesProcessed=excluded.messagesProcessed,chatsTotal=excluded.chatsTotal,completedAt=excluded.completedAt,lastErrorSafe=excluded.lastErrorSafe,updatedAt=excluded.updatedAt').run(job); }
}

export class SupabaseWhatsAppHistorySyncStore implements SyncJobStore {
  constructor(private readonly client: SupabaseClient) {}
  async get(workspaceId: string, wahaSession: string) { const { data, error } = await this.client.from('whatsapp_sync_jobs').select().eq('workspace_id', workspaceId).eq('waha_session', wahaSession).maybeSingle(); if (error) throw error; return data ? remoteJob(data) : undefined; }
  async save(job: SyncJob) {
    const linha = { id: job.id, workspace_id: job.workspaceId, waha_session: job.wahaSession, status: job.status, current_chat_id: job.currentChatId, chat_cursor: job.chatCursor, message_cursor: job.messageCursor, chats_processed: job.chatsProcessed, messages_processed: job.messagesProcessed, chats_total: job.chatsTotal, started_at: job.startedAt, completed_at: job.completedAt, last_error_safe: job.lastErrorSafe, updated_at: job.updatedAt };
    const { error } = await this.client.from('whatsapp_sync_jobs').upsert(linha, { onConflict: 'workspace_id,waha_session' });
    if (!error) return;
    if (!missingChatsTotal(error)) throw error;
    // A migration que cria `chats_total` pode não ter chegado a este ambiente —
    // foi o que aconteceu em produção, e o efeito não foi perder o denominador
    // do banner: foi a sincronização inteira parar de funcionar, porque TODO
    // checkpoint passa por aqui e o 42703 subia como 500 no `POST /sync/start`.
    //
    // O contador é ornamento; o job é o trabalho. Regravar sem ele preserva o
    // trabalho e perde só a barra de progresso, que a Inbox já sabe exibir sem
    // denominador. Repetir em vez de sondar uma vez é deliberado: a sondagem
    // cacheada de `supabaseIdentifierHashReady` exige reiniciar o processo
    // depois que a migration entra, e esta se cura sozinha na gravação seguinte.
    const { chats_total: _semColuna, ...semContador } = linha;
    const repetida = await this.client.from('whatsapp_sync_jobs').upsert(semContador, { onConflict: 'workspace_id,waha_session' });
    if (repetida.error) throw repetida.error;
  }
}

function sqliteJob(row: Record<string, unknown>): SyncJob { return row as unknown as SyncJob; }
function remoteJob(row: Record<string, any>): SyncJob { return { id: row.id, workspaceId: row.workspace_id, wahaSession: row.waha_session, status: row.status, currentChatId: row.current_chat_id, chatCursor: row.chat_cursor, messageCursor: row.message_cursor, chatsProcessed: row.chats_processed, messagesProcessed: row.messages_processed, chatsTotal: row.chats_total ?? null, startedAt: row.started_at, completedAt: row.completed_at, lastErrorSafe: row.last_error_safe, updatedAt: row.updated_at }; }
function integerCursor(value: string | null): number { const number = Number(value ?? 0); return Number.isInteger(number) && number >= 0 ? number : 0; }
/**
 * Reading messages costs the WAHA WEBJS engine time proportional to the offset
 * asked for: measured against the group this job is stuck on, offset 0 answers
 * in 0.7s, offset 1000 in 15s and offset 2000 in 45-54s, past both the provider
 * and the transport deadlines. A timeout that deep is a property of the offset,
 * not a transient fault, so the extra attempts cannot succeed — they only spend
 * the deadline again and leave more concurrent deep reads on the provider that
 * is already the bottleneck. Chat listings and offset 0 cost the same every
 * time, so a timeout there really is transient and stays worth retrying.
 */
/**
 * A coluna `chats_total` ausente do schema, nas DUAS formas que o PostgREST usa —
 * e elas são diferentes, o que custou uma rodada de diagnóstico:
 *
 *   leitura   42703     column whatsapp_sync_jobs.chats_total does not exist
 *   escrita   PGRST204  Could not find the 'chats_total' column of
 *                       'whatsapp_sync_jobs' in the schema cache
 *
 * Casar só o código da leitura não pega o `upsert`, que é justamente onde dói.
 * O nome da coluna entra no predicado de propósito: engolir qualquer PGRST204
 * esconderia erro de verdade em qualquer outra coluna.
 */
function missingChatsTotal(error: { code?: string; message?: string } | null | undefined): boolean {
  return (error?.code === '42703' || error?.code === 'PGRST204') && /chats_total/.test(error.message ?? '');
}

function retryable(code: string, chatId: string | undefined, offset: number): boolean {
  return transientCodes.has(code) && !(code === 'TIMEOUT' && chatId !== undefined && offset > 0);
}
/**
 * Carries the provider error code, which drives retry and chat-closing
 * decisions, next to the message that says what actually failed. Collapsing the
 * two used to persist a bare `TIMEOUT` for three different causes: WAHA not
 * answering, the command budget running out, and the API aborting its own
 * request.
 */
class ProviderFailure extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail && detail !== code ? `${code}: ${detail}` : code);
    this.name = 'ProviderFailure';
  }
}
/** `page` rejects with the provider error code; this reads it back. */
function errorCode(error: unknown): string { return error instanceof ProviderFailure ? error.code : error instanceof Error ? error.message : ''; }
function safeError(error: unknown): string {
  const source = error instanceof Error
    ? error.message
    : error && typeof error === 'object'
      ? [
          typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined,
          typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : undefined,
          typeof (error as { details?: unknown }).details === 'string' ? (error as { details: string }).details : undefined,
        ].filter(Boolean).join(': ')
      : '';
  return (source || 'History synchronization failed').replace(/(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 240);
}
