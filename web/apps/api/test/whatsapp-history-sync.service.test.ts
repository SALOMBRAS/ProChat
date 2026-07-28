import { describe, expect, it, vi } from 'vitest';
import { WhatsAppHistorySyncService, type SyncJob, type SyncJobStore } from '../src/services/whatsapp-history-sync.service.js';
import type { InternalWorkerClient } from '../src/internal-worker-client.js';
import type { WahaWebhookStore } from '../src/services/waha-webhook.service.js';
import type { RealtimeHub } from '../src/realtime.js';

class MemoryStore implements SyncJobStore { job?: SyncJob; reads = 0; async get() { this.reads += 1; return this.job ? { ...this.job } : undefined; } async save(job: SyncJob) { this.job = { ...job }; } }
const waitFor = async (check: () => boolean) => { for (let attempt = 0; attempt < 80; attempt += 1) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('timed out'); };
const response = (items: Record<string, unknown>[], hasMore = false) => ({ success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { historyPage: { kind: 'chats' as const, items, unsupported: [], hasMore } } });
const failed = (code: string) => ({ success: false as const, correlationId: 'c', workspaceId: 'workspace-a', error: { code, message: code, details: {} } });

describe('WhatsAppHistorySyncService', () => {
  it('shares one active run between concurrent starts', async () => {
    const store = new MemoryStore(); const send = vi.fn().mockResolvedValue(response([])); const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn() } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub);
    const [first, second] = await Promise.all([service.start('workspace-a', 'session-a'), service.start('workspace-a', 'session-a')]);
    expect(first.id).toBe(second.id); await waitFor(() => store.job?.status === 'completed'); expect(send).toHaveBeenCalledTimes(1);
  });
  it('retries transient worker failures with bounded exponential backoff', async () => {
    const store = new MemoryStore(); const send = vi.fn().mockResolvedValueOnce(failed('TIMEOUT')).mockResolvedValueOnce(failed('SERVICE_UNAVAILABLE')).mockResolvedValueOnce(response([])); const sleep = vi.fn().mockResolvedValue(undefined); const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn() } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep, retryBaseMs: 10 });
    await service.start('workspace-a', 'session-a'); await waitFor(() => store.job?.status === 'completed'); expect(send).toHaveBeenCalledTimes(3); expect(sleep).toHaveBeenNthCalledWith(1, 10); expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });
  it('does not retry permanent worker failures and preserves the checkpoint', async () => {
    const store = new MemoryStore(); const send = vi.fn().mockResolvedValue(failed('NOT_FOUND')); const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn() } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub);
    await service.start('workspace-a', 'session-a'); await waitFor(() => store.job?.status === 'failed'); expect(send).toHaveBeenCalledTimes(1); expect(store.job).toMatchObject({ status: 'failed', chatCursor: '0', messagesProcessed: 0, lastErrorSafe: 'NOT_FOUND' });
  });
  it('only advances a message checkpoint after every message in its page persists', async () => {
    const store = new MemoryStore(); const send = vi.fn().mockImplementation((request: any) => request.command.payload.chatId ? response([{ id: 'm-1', chatId: '1@c.us', timestamp: 1 }, { id: 'm-2', chatId: '1@c.us', timestamp: 2 }], true) : response([{ id: '1@c.us' }], false)); const ingest = vi.fn().mockResolvedValueOnce({ duplicate: false }).mockRejectedValueOnce(new Error('database unavailable')); const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub);
    await service.start('workspace-a', 'session-a'); await waitFor(() => store.job?.status === 'failed'); expect(store.job).toMatchObject({ currentChatId: '1@c.us', messageCursor: '0', messagesProcessed: 0 });
  });
  it('cancels without transitioning the job to completed', async () => {
    const store = new MemoryStore(); let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; }); const send = vi.fn().mockImplementation(async (request: any) => { if (!request.command.payload.chatId) return response([{ id: '1@c.us' }]); await blocked; return response([]); }); const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn() } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub);
    await service.start('workspace-a', 'session-a'); await waitFor(() => store.job?.currentChatId === '1@c.us'); await service.cancel('workspace-a', 'session-a'); release(); await waitFor(() => store.job?.status === 'cancelled'); expect(store.job?.completedAt).toBeNull();
  });
  it('continues automatically after a batch checkpoint until the full history is complete', async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockImplementation((request: any) => {
      if (!request.command.payload.chatId) return request.command.payload.offset === 0 ? response([{ id: '1@c.us' }]) : response([]);
      return request.command.payload.offset === 0
        ? response([{ id: 'm-1', chatId: '1@c.us', timestamp: 1 }, { id: 'm-2', chatId: '1@c.us', timestamp: 2 }], true)
        : response([{ id: 'm-3', chatId: '1@c.us', timestamp: 3 }]);
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn().mockResolvedValue({ duplicate: false }) } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { maxMessagesPerRun: 2, continuationDelayMs: 1, sleep });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'completed');
    expect(store.job).toMatchObject({ chatCursor: '1', messagesProcessed: 3, chatsProcessed: 1 });
    expect(sleep).toHaveBeenCalledWith(1);
    expect(send.mock.calls.filter((call: any[]) => call[0].command.payload.chatId).map((call: any[]) => call[0].command.payload.offset)).toEqual([0, 2]);
  });

  it('preserves the checkpoint at the emergency execution guard', async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockImplementation((request: any) => request.command.payload.chatId ? response([{ id: 'm-1', chatId: '1@c.us', timestamp: 1 }, { id: 'm-2', chatId: '1@c.us', timestamp: 2 }]) : response([{ id: '1@c.us' }]));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn().mockResolvedValue({ duplicate: false }) } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { emergencyMaxMessages: 2, sleep });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'pending' && store.job.messagesProcessed === 2);
    const status = await service.status('workspace-a', 'session-a');
    expect(status).toMatchObject({ status: 'pending', hasMore: true, messagesProcessed: 2, messageCursor: null });
    expect(status?.progressLabel).not.toMatch(/limite global/i);
    expect(send.mock.calls.find((call: any[]) => call[0].command.payload.chatId)?.[0].command.payload.limit).toBe(100);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('closes a chat that keeps timing out and still finishes the remaining history', async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockImplementation((request: any) => {
      const { chatId, offset } = request.command.payload;
      if (!chatId) return offset === 0 ? response([{ id: '1@c.us' }]) : offset === 1 ? response([{ id: '2@c.us' }]) : response([]);
      return chatId === '1@c.us' ? failed('TIMEOUT') : response([{ id: 'm-1', chatId: '2@c.us', timestamp: 1 }]);
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn().mockResolvedValue({ duplicate: false }) } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep, retryBaseMs: 1 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'completed');
    expect(store.job).toMatchObject({ status: 'completed', chatsProcessed: 2, messagesProcessed: 1, chatCursor: '2', currentChatId: null, lastErrorSafe: 'TIMEOUT' });
    expect(send.mock.calls.filter((call: any[]) => call[0].command.payload.chatId === '1@c.us')).toHaveLength(3);
    expect((await service.status('workspace-a', 'session-a'))?.progressLabel).toMatch(/truncadas/);
  });

  it('stops retrying a timeout that is deep inside a chat, because the cost is the offset itself', async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockImplementation((request: any) => {
      const { chatId, offset } = request.command.payload;
      if (!chatId) return offset === 0 ? response([{ id: '1@c.us' }]) : response([]);
      return offset === 0 ? response([{ id: 'm-1', chatId: '1@c.us', timestamp: 1 }], true) : failed('TIMEOUT');
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn().mockResolvedValue({ duplicate: false }) } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep, retryBaseMs: 1, messagePageSize: 1 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'completed');
    const closure = logged.mock.calls.map(call => JSON.parse(String(call[0]))).find(entry => entry.message === 'WhatsApp history sync closed a chat early');
    logged.mockRestore();
    expect(store.job).toMatchObject({ status: 'completed', chatsProcessed: 1, messagesProcessed: 1, lastErrorSafe: 'TIMEOUT' });
    expect(send.mock.calls.filter((call: any[]) => call[0].command.payload.chatId === '1@c.us' && call[0].command.payload.offset === 1)).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(closure).toMatchObject({ chatId: '1@c.us', offset: 1, attempts: 1 });
  });

  it('still retries a timeout on the first page of a chat, where the cost does not depend on the offset', async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockImplementation((request: any) => {
      const { chatId, offset } = request.command.payload;
      if (!chatId) return offset === 0 ? response([{ id: '1@c.us' }]) : response([]);
      return send.mock.calls.filter((call: any[]) => call[0].command.payload.chatId === '1@c.us').length < 3 ? failed('TIMEOUT') : response([{ id: 'm-1', chatId: '1@c.us', timestamp: 1 }]);
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn().mockResolvedValue({ duplicate: false }) } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep, retryBaseMs: 10 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'completed');
    expect(store.job).toMatchObject({ status: 'completed', chatsProcessed: 1, messagesProcessed: 1, lastErrorSafe: null });
    expect(send.mock.calls.filter((call: any[]) => call[0].command.payload.chatId === '1@c.us')).toHaveLength(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
  });

  it('keeps synchronizing when one long chat after another times out deep in its history', async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockImplementation((request: any) => {
      const { chatId, offset } = request.command.payload;
      if (!chatId) return offset < 6 ? response([{ id: `${offset + 1}@c.us` }]) : response([]);
      return offset === 0 ? response([{ id: `m-${chatId}`, chatId, timestamp: 1 }], true) : failed('TIMEOUT');
    });
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn().mockResolvedValue({ duplicate: false }) } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep: vi.fn().mockResolvedValue(undefined), retryBaseMs: 1, messagePageSize: 1, maxConsecutiveChatTimeouts: 2 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'completed');
    expect(store.job).toMatchObject({ status: 'completed', chatsProcessed: 6, messagesProcessed: 6, chatCursor: '6' });
  });

  it('resumes a failed job from its checkpoint instead of restarting the history', async () => {
    const store = new MemoryStore();
    store.job = { id: 'job-a', workspaceId: 'workspace-a', wahaSession: 'session-a', status: 'failed', currentChatId: '120363@g.us', chatCursor: '4', messageCursor: '300', chatsProcessed: 4, messagesProcessed: 300, startedAt: '2026-07-22T14:00:38.458Z', completedAt: null, lastErrorSafe: 'TIMEOUT', updatedAt: '2026-07-24T13:10:34.089Z' };
    const send = vi.fn().mockImplementation((request: any) => {
      const { chatId, offset } = request.command.payload;
      if (!chatId) return response([]);
      return offset === 300 ? response([{ id: 'm-1', chatId: '120363@g.us', timestamp: 1 }]) : response([]);
    });
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn().mockResolvedValue({ duplicate: false }) } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep: vi.fn().mockResolvedValue(undefined) });
    const started = await service.start('workspace-a', 'session-a');
    expect(started).toMatchObject({ id: 'job-a', currentChat: '120363@g.us', messageCursor: '300', chatsProcessed: 4, lastErrorSafe: null });
    await waitFor(() => store.job?.status === 'completed');
    expect(send.mock.calls.filter((call: any[]) => call[0].command.payload.chatId).map((call: any[]) => call[0].command.payload.offset)).toEqual([300]);
    expect(store.job).toMatchObject({ chatsProcessed: 5, messagesProcessed: 301, chatCursor: '5', startedAt: '2026-07-22T14:00:38.458Z' });
  });

  it('adopts a job abandoned as running by an interrupted process, and refuses to duplicate a live one', async () => {
    const store = new MemoryStore();
    const running = { id: 'job-a', workspaceId: 'workspace-a', wahaSession: 'session-a', status: 'running' as const, currentChatId: null, chatCursor: '7', messageCursor: null, chatsProcessed: 7, messagesProcessed: 70, startedAt: '2026-07-22T14:00:38.458Z', completedAt: null, lastErrorSafe: null, updatedAt: new Date(Date.now() - 600_000).toISOString() };
    const send = vi.fn().mockResolvedValue(response([]));
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn() } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep: vi.fn().mockResolvedValue(undefined) });
    store.job = { ...running };
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'completed');
    expect(store.job).toMatchObject({ id: 'job-a', chatCursor: '7', chatsProcessed: 7 });
    expect(send).toHaveBeenCalledTimes(1);

    store.job = { ...running, updatedAt: new Date().toISOString() };
    expect(await service.start('workspace-a', 'session-a')).toMatchObject({ status: 'running', chatCursor: '7' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('records which timeout actually happened instead of a bare code, and never names a deadline of its own', async () => {
    const causes = [
      { message: 'command budget ran out before WAHA answered', expected: 'TIMEOUT: command budget ran out before WAHA answered' },
      { message: 'WAHA request timed out', expected: 'TIMEOUT: WAHA request timed out' },
      { message: 'Internal worker command timed out', expected: 'TIMEOUT: Internal worker command timed out' },
    ];
    for (const cause of causes) {
      const store = new MemoryStore();
      const send = vi.fn().mockResolvedValue({ success: false as const, correlationId: 'c', workspaceId: 'workspace-a', error: { code: 'TIMEOUT', message: cause.message, details: {} } });
      const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn() } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep: vi.fn().mockResolvedValue(undefined), retryBaseMs: 1 });
      await service.start('workspace-a', 'session-a');
      await waitFor(() => store.job?.status === 'failed');
      expect(store.job?.lastErrorSafe).toBe(cause.expected);
      // The deployment configures one budget on the transport client; a literal
      // here is what let the API and the worker disagree about it.
      expect(send.mock.calls[0][0]).not.toHaveProperty('timeoutMs');
    }
  });

  it('reads the stored job once per page instead of once per message', async () => {
    const store = new MemoryStore();
    const page = Array.from({ length: 100 }, (_, index) => ({ id: `m-${index}`, chatId: '1@c.us', timestamp: index + 1 }));
    const send = vi.fn().mockImplementation((request: any) => {
      const { chatId, offset } = request.command.payload;
      if (!chatId) return offset === 0 ? response([{ id: '1@c.us' }]) : response([]);
      return offset === 0 ? response(page, true) : response([]);
    });
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn().mockResolvedValue({ duplicate: false }) } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep: vi.fn().mockResolvedValue(undefined) });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'completed');
    expect(store.job).toMatchObject({ status: 'completed', messagesProcessed: 100, chatsProcessed: 1 });
    // One hundred messages used to cost one hundred extra reads on their own.
    expect(store.reads).toBeLessThan(20);
  });

  it('stops between two messages of a page when the run is cancelled', async () => {
    const store = new MemoryStore();
    const page = Array.from({ length: 50 }, (_, index) => ({ id: `m-${index}`, chatId: '1@c.us', timestamp: index + 1 }));
    const send = vi.fn().mockImplementation((request: any) => request.command.payload.chatId ? response(page, true) : response([{ id: '1@c.us' }]));
    let ingested = 0;
    const ingest = vi.fn().mockImplementation(async () => { ingested += 1; if (ingested === 5) await service.cancel('workspace-a', 'session-a'); return { duplicate: false }; });
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep: vi.fn().mockResolvedValue(undefined) });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ingested).toBe(5);
    expect(store.job).toMatchObject({ status: 'cancelled', messageCursor: '0', messagesProcessed: 0 });
  });

  it('does not carry a cancellation into the next resume', async () => {
    const store = new MemoryStore();
    const page = Array.from({ length: 10 }, (_, index) => ({ id: `m-${index}`, chatId: '1@c.us', timestamp: index + 1 }));
    const send = vi.fn().mockImplementation((request: any) => {
      const { chatId, offset } = request.command.payload;
      if (!chatId) return offset === 0 ? response([{ id: '1@c.us' }]) : response([]);
      return offset === 0 ? response(page) : response([]);
    });
    let cancelDuringIngest = true;
    const ingest = vi.fn().mockImplementation(async () => { if (cancelDuringIngest) { cancelDuringIngest = false; await service.cancel('workspace-a', 'session-a'); } return { duplicate: false }; });
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep: vi.fn().mockResolvedValue(undefined) });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'cancelled');
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'completed');
    expect(store.job).toMatchObject({ status: 'completed', messagesProcessed: 10, chatsProcessed: 1 });
  });

  it('fails the job when consecutive chats time out, instead of marking them processed', async () => {
    const store = new MemoryStore();
    const send = vi.fn().mockImplementation((request: any) => request.command.payload.chatId ? failed('TIMEOUT') : response([{ id: `${request.command.payload.offset + 1}@c.us` }]));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn() } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub, { sleep, retryBaseMs: 1, maxConsecutiveChatTimeouts: 2 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.job?.status === 'failed');
    expect(store.job).toMatchObject({ status: 'failed', chatsProcessed: 1, lastErrorSafe: 'TIMEOUT' });
  });
});
