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
export type HistorySyncOptions = { chatPageSize?: number; messagePageSize?: number; maxChatsPerRun?: number; maxMessagesPerRun?: number; maxChatsTotal?: number; maxMessagesTotal?: number; continuationDelayMs?: number; maxAttempts?: number; retryBaseMs?: number; sleep?: (milliseconds: number) => Promise<void> };
export type HistorySyncRunLimits = { maxChatsPerRun?: number; maxMessagesPerRun?: number };
const transientCodes = new Set(['TIMEOUT', 'SERVICE_UNAVAILABLE']);

export class WhatsAppHistorySyncService {
  private readonly active = new Set<string>();
  private readonly starts = new Map<string, Promise<SyncJobStatus>>();
  private readonly options: Required<Omit<HistorySyncOptions, 'sleep'>> & { sleep: (milliseconds: number) => Promise<void> };

  constructor(private readonly worker: InternalWorkerClient, private readonly messages: WahaWebhookStore, private readonly jobs: SyncJobStore, private readonly realtime: RealtimeHub, options: HistorySyncOptions = {}) {
    this.options = {
      chatPageSize: options.chatPageSize ?? 20,
      messagePageSize: options.messagePageSize ?? 50,
      maxChatsPerRun: options.maxChatsPerRun ?? 10,
      maxMessagesPerRun: options.maxMessagesPerRun ?? 300,
      maxChatsTotal: options.maxChatsTotal ?? 500,
      maxMessagesTotal: options.maxMessagesTotal ?? 50_000,
      continuationDelayMs: options.continuationDelayMs ?? 100,
      maxAttempts: options.maxAttempts ?? 3,
      retryBaseMs: options.retryBaseMs ?? 250,
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
    if ((this.active.has(key) || previous?.status === 'running') && previous) return this.view(previous);
    const now = new Date().toISOString();
    const job: SyncJob = previous && previous.status === 'completed'
      ? { ...previous, status: 'pending', currentChatId: null, chatCursor: '0', messageCursor: null, chatsProcessed: 0, messagesProcessed: 0, startedAt: now, completedAt: null, lastErrorSafe: null, updatedAt: now }
      : previous
        ? { ...previous, status: 'pending', completedAt: null, lastErrorSafe: null, updatedAt: now }
        : { id: randomUUID(), workspaceId, wahaSession, status: 'pending', currentChatId: null, chatCursor: '0', messageCursor: null, chatsProcessed: 0, messagesProcessed: 0, startedAt: now, completedAt: null, lastErrorSafe: null, updatedAt: now };
    await this.save(job, previous?.status === 'failed' || previous?.status === 'cancelled' ? 'resumed manually' : 'started');
    this.launch(job, limits);
    return this.view(job);
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
      while (job.status === 'running') {
        job = await this.current(job);
        if (job.status === 'cancelled') return;
        if (this.globalLimitReached(job)) {
          await this.save({ ...job, status: 'pending', updatedAt: new Date().toISOString() }, 'paused at global safety limit');
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
        const remainingGlobalMessages = this.options.maxMessagesTotal - job.messagesProcessed;
        const page = await this.page(job, job.currentChatId, offset, Math.min(this.options.messagePageSize, remainingMessages, remainingGlobalMessages));
        for (const message of page.items) {
          if ((await this.current(job)).status === 'cancelled') return;
          const record = historyRecord(workspaceId, wahaSession, message, job.currentChatId);
          if (record) await this.messages.ingest(record);
          messagesThisBatch += 1;
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
      if (!transientCodes.has(last) || attempt === this.options.maxAttempts) throw new Error(last);
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
    const globalLimitReached = this.globalLimitReached(job);
    const progressLabel = job.status === 'completed'
      ? 'Histórico sincronizado.'
      : job.status === 'running'
        ? 'Sincronizando histórico…'
        : job.status === 'pending' && globalLimitReached
          ? 'Pausado: limite global de segurança atingido.'
          : job.status === 'pending'
            ? 'Próximo lote agendado…'
            : job.status === 'failed'
              ? 'Falhou; corrija o problema e retome.'
              : 'Sincronização cancelada.';
    return { ...job, jobId: job.id, currentChat: job.currentChatId, hasMore: job.status === 'running' || (job.status === 'pending' && !globalLimitReached), progressLabel };
  }

  private globalLimitReached(job: SyncJob): boolean { return job.chatsProcessed >= this.options.maxChatsTotal || job.messagesProcessed >= this.options.maxMessagesTotal; }
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
