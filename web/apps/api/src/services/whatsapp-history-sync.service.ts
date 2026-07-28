import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteDatabase } from '../persistence/database.js';
import { InternalWorkerClient } from '../internal-worker-client.js';
import type { RealtimeHub } from '../realtime.js';
import { log } from '../logging.js';
import { historyRecord, type WahaWebhookStore } from './waha-webhook.service.js';
import { isConversationChatId } from './conversation-identity.js';

export type SyncStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type SyncJob = { id: string; workspaceId: string; wahaSession: string; status: SyncStatus; currentChatId: string | null; chatCursor: string | null; messageCursor: string | null; chatsProcessed: number; messagesProcessed: number; startedAt: string; completedAt: string | null; lastErrorSafe: string | null; updatedAt: string };
export type SyncJobStatus = SyncJob & { jobId: string; currentChat: string | null; hasMore: boolean; progressLabel: string };
export type SyncJobStore = { get(workspaceId: string, wahaSession: string): Promise<SyncJob | undefined>; save(job: SyncJob): Promise<void> };
export type HistorySyncOptions = { chatPageSize?: number; messagePageSize?: number; maxChatsPerRun?: number; maxMessagesPerRun?: number; emergencyMaxMessages?: number; continuationDelayMs?: number; maxAttempts?: number; retryBaseMs?: number; maxConsecutiveChatTimeouts?: number; staleRunningAfterMs?: number; sleep?: (milliseconds: number) => Promise<void> };
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
    const now = new Date().toISOString();
    const job: SyncJob = previous && previous.status === 'completed'
      ? { ...previous, status: 'pending', currentChatId: null, chatCursor: '0', messageCursor: null, chatsProcessed: 0, messagesProcessed: 0, startedAt: now, completedAt: null, lastErrorSafe: null, updatedAt: now }
      : previous
        ? { ...previous, status: 'pending', completedAt: null, lastErrorSafe: null, updatedAt: now }
        : { id: randomUUID(), workspaceId, wahaSession, status: 'pending', currentChatId: null, chatCursor: '0', messageCursor: null, chatsProcessed: 0, messagesProcessed: 0, startedAt: now, completedAt: null, lastErrorSafe: null, updatedAt: now };
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
    let job = await this.jobs.get(workspaceId, wahaSession);
    if (!job || job.status === 'cancelled') return;
    try {
      job = await this.save({ ...job, status: 'running', updatedAt: new Date().toISOString() }, 'running');
      let chatsThisBatch = 0;
      let messagesThisBatch = 0;
      let messagesThisExecution = 0;
      let consecutiveChatTimeouts = 0;
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
          const page = await this.page(job, undefined, offset, this.options.chatPageSize);
          if (!page.items.length) {
            if (page.hasMore) {
              job = await this.save({ ...job, chatCursor: String(offset + this.options.chatPageSize), updatedAt: new Date().toISOString() }, 'skipped unsupported chat page');
              continue;
            }
            await this.save({ ...job, status: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 'completed');
            return;
          }
          const chatId = typeof page.items[0].id === 'string' && isConversationChatId(page.items[0].id) ? page.items[0].id : null;
          if (!chatId) {
            job = await this.save({ ...job, chatCursor: String(offset + 1), updatedAt: new Date().toISOString() }, 'skipped invalid chat');
            continue;
          }
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
          if ((await this.current(job)).status === 'cancelled') return;
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

  private async page(job: SyncJob, chatId: string | undefined, offset: number, limit: number): Promise<{ items: Record<string, unknown>[]; hasMore: boolean }> {
    let last: string | undefined;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const response = await this.worker.send({ correlationId: `history-sync-${randomUUID()}`, workspaceId: job.workspaceId, timeoutMs: 30_000, command: { type: 'history.page', payload: { wahaSession: job.wahaSession, ...(chatId ? { chatId } : {}), offset, limit } } });
      if (response.success) {
        const page = (response.data as { historyPage?: { items?: Record<string, unknown>[]; hasMore?: boolean } }).historyPage;
        if (!page) throw new Error('PROVIDER_CONTRACT_ERROR');
        return { items: page.items ?? [], hasMore: page.hasMore === true };
      }
      last = response.error.code;
      if (!retryable(last, chatId, offset) || attempt === this.options.maxAttempts) throw new Error(last);
      await this.options.sleep(Math.min(this.options.retryBaseMs * 2 ** (attempt - 1), 4_000));
    }
    throw new Error(last ?? 'SERVICE_UNAVAILABLE');
  }

  private async current(job: SyncJob): Promise<SyncJob> { return (await this.jobs.get(job.workspaceId, job.wahaSession)) ?? job; }

  private async save(job: SyncJob, event: string): Promise<SyncJob> {
    await this.jobs.save(job);
    const status = this.view(job);
    this.realtime.publish(job.workspaceId, 'conversation.sync.updated', { jobId: status.jobId, wahaSession: job.wahaSession, status: job.status, chatsProcessed: job.chatsProcessed, messagesProcessed: job.messagesProcessed, currentChat: status.currentChat, hasMore: status.hasMore, progressLabel: status.progressLabel, lastErrorSafe: job.lastErrorSafe, updatedAt: job.updatedAt });
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
  async save(job: SyncJob) { this.db.prepare('INSERT INTO whatsapp_sync_jobs (id,workspaceId,wahaSession,status,currentChatId,chatCursor,messageCursor,chatsProcessed,messagesProcessed,startedAt,completedAt,lastErrorSafe,updatedAt) VALUES (@id,@workspaceId,@wahaSession,@status,@currentChatId,@chatCursor,@messageCursor,@chatsProcessed,@messagesProcessed,@startedAt,@completedAt,@lastErrorSafe,@updatedAt) ON CONFLICT(workspaceId,wahaSession) DO UPDATE SET status=excluded.status,currentChatId=excluded.currentChatId,chatCursor=excluded.chatCursor,messageCursor=excluded.messageCursor,chatsProcessed=excluded.chatsProcessed,messagesProcessed=excluded.messagesProcessed,completedAt=excluded.completedAt,lastErrorSafe=excluded.lastErrorSafe,updatedAt=excluded.updatedAt').run(job); }
}

export class SupabaseWhatsAppHistorySyncStore implements SyncJobStore {
  constructor(private readonly client: SupabaseClient) {}
  async get(workspaceId: string, wahaSession: string) { const { data, error } = await this.client.from('whatsapp_sync_jobs').select().eq('workspace_id', workspaceId).eq('waha_session', wahaSession).maybeSingle(); if (error) throw error; return data ? remoteJob(data) : undefined; }
  async save(job: SyncJob) { const { error } = await this.client.from('whatsapp_sync_jobs').upsert({ id: job.id, workspace_id: job.workspaceId, waha_session: job.wahaSession, status: job.status, current_chat_id: job.currentChatId, chat_cursor: job.chatCursor, message_cursor: job.messageCursor, chats_processed: job.chatsProcessed, messages_processed: job.messagesProcessed, started_at: job.startedAt, completed_at: job.completedAt, last_error_safe: job.lastErrorSafe, updated_at: job.updatedAt }, { onConflict: 'workspace_id,waha_session' }); if (error) throw error; }
}

function sqliteJob(row: Record<string, unknown>): SyncJob { return row as unknown as SyncJob; }
function remoteJob(row: Record<string, any>): SyncJob { return { id: row.id, workspaceId: row.workspace_id, wahaSession: row.waha_session, status: row.status, currentChatId: row.current_chat_id, chatCursor: row.chat_cursor, messageCursor: row.message_cursor, chatsProcessed: row.chats_processed, messagesProcessed: row.messages_processed, startedAt: row.started_at, completedAt: row.completed_at, lastErrorSafe: row.last_error_safe, updatedAt: row.updated_at }; }
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
function retryable(code: string, chatId: string | undefined, offset: number): boolean {
  return transientCodes.has(code) && !(code === 'TIMEOUT' && chatId !== undefined && offset > 0);
}
/** `page` rejects with the provider error code as the message; this reads it back. */
function errorCode(error: unknown): string { return error instanceof Error ? error.message : ''; }
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
