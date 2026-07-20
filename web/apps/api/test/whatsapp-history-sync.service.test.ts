import { describe, expect, it, vi } from 'vitest';
import { WhatsAppHistorySyncService, type SyncJob, type SyncJobStore } from '../src/services/whatsapp-history-sync.service.js';
import type { InternalWorkerClient } from '../src/internal-worker-client.js';
import type { WahaWebhookStore } from '../src/services/waha-webhook.service.js';
import type { RealtimeHub } from '../src/realtime.js';

class MemoryStore implements SyncJobStore { job?: SyncJob; async get() { return this.job ? { ...this.job } : undefined; } async save(job: SyncJob) { this.job = { ...job }; } }
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
  it('honors a small message limit without skipping the next history page', async () => {
    const store = new MemoryStore(); const messages = Array.from({ length: 30 }, (_, index) => ({ id: `m-${index}`, chatId: '1@c.us', timestamp: index + 1 })); const send = vi.fn().mockImplementation((request: any) => request.command.payload.chatId ? response(messages, true) : response([{ id: '1@c.us' }])); const service = new WhatsAppHistorySyncService({ send } as unknown as InternalWorkerClient, { ingest: vi.fn().mockResolvedValue({ duplicate: false }) } as unknown as WahaWebhookStore, store, { publish: vi.fn() } as unknown as RealtimeHub);
    await service.start('workspace-a', 'session-a', { maxChatsPerRun: 10, maxMessagesPerRun: 30 }); await waitFor(() => store.job?.status === 'pending' && store.job.messagesProcessed === 30); expect(store.job).toMatchObject({ messageCursor: '30', messagesProcessed: 30 }); expect(send.mock.calls.find((call: any[]) => call[0].command.payload.chatId)?.[0].command.payload.limit).toBe(30);
  });
});
