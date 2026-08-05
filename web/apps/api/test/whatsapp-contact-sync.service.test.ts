import { describe, expect, it, vi } from 'vitest';
import { MemoryContactSyncStore, WhatsAppContactSyncService, type ContactSyncJob, type ContactSyncOptions } from '../src/services/whatsapp-contact-sync.service.js';
import type { InternalWorkerClient } from '../src/internal-worker-client.js';
import type { ContactIdentityResolver } from '../src/services/contact-identity-resolver.service.js';
import type { RealtimeHub } from '../src/realtime.js';

class CountingStore extends MemoryContactSyncStore { saved: ContactSyncJob[] = []; override async save(job: ContactSyncJob) { this.saved.push({ ...job }); await super.save(job); } }
const waitFor = async (check: () => boolean) => { for (let attempt = 0; attempt < 100; attempt += 1) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('timed out'); };
const page = (items: Record<string, unknown>[], hasMore = false) => ({ success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { contactsPage: { items, unsupported: [], hasMore } } });
const failed = (code: string) => ({ success: false as const, correlationId: 'c', workspaceId: 'workspace-a', error: { code, message: code, details: {} } });
const resolver = () => ({ resolve: vi.fn().mockResolvedValue(undefined), resolveDetailed: vi.fn() }) as unknown as ContactIdentityResolver & { resolve: ReturnType<typeof vi.fn> };
const harness = (send: ReturnType<typeof vi.fn>, options: ContactSyncOptions = {}, contacts = resolver()) => {
  const store = new CountingStore(); const identitySync = { enqueue: vi.fn() }; const realtime = { publish: vi.fn() };
  const service = new WhatsAppContactSyncService({ send } as unknown as InternalWorkerClient, contacts, store, identitySync, realtime as unknown as RealtimeHub, options);
  return { service, store, send, contacts, identitySync, realtime };
};

describe('WhatsAppContactSyncService', () => {
  it('paginates the whole address book and completes with per-page checkpoints', async () => {
    const send = vi.fn().mockImplementation((request: any) => request.command.payload.offset === 0 ? page([{ id: '5511999990001@c.us' }, { id: '5511999990002@c.us' }], true) : page([{ id: '5511999990003@c.us' }]));
    const { service, store, send: sent, identitySync } = harness(send, { pageSize: 2 });
    const started = await service.start('workspace-a', 'session-a');
    expect(started.status).toBe('pending'); expect(started.syncKind).toBe('contacts');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    const job = (await service.status('workspace-a', 'session-a'))!;
    expect(job).toMatchObject({ status: 'completed', cursor: '3', contactsProcessed: 3, contactsResolved: 3, contactsSkipped: 0, hasMore: false, progressLabel: 'Agenda de contatos sincronizada.' });
    expect(sent.mock.calls.map((call: any[]) => call[0].command)).toEqual([
      { type: 'contacts.page', payload: { wahaSession: 'session-a', offset: 0, limit: 2 } },
      { type: 'contacts.page', payload: { wahaSession: 'session-a', offset: 2, limit: 2 } },
    ]);
    expect(identitySync.enqueue).toHaveBeenCalledTimes(3);
    expect(identitySync.enqueue).toHaveBeenCalledWith({ workspaceId: 'workspace-a', wahaSession: 'session-a', chatId: '5511999990001@c.us' });
  });

  it('skips groups, broadcast channels and non-conversation identifiers without calling the resolver', async () => {
    const items = [
      { id: '120363@g.us' }, { id: '55@g.us', isGroup: true }, { id: 'status@broadcast' }, { id: '1@broadcast' }, { id: '2@newsletter' }, { id: 'not-an-address' }, { name: 'sem id' },
      { id: '5511999990001@c.us', number: '+55 (11) 99999-0001', name: ' Ada ' }, { id: '222@lid', pushname: 'Lovelace' },
    ];
    const send = vi.fn().mockResolvedValue(page(items));
    const { service, store, contacts, identitySync } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ contactsProcessed: 9, contactsResolved: 2, contactsSkipped: 7 });
    expect(contacts.resolve).toHaveBeenCalledTimes(2);
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '5511999990001@c.us', phone: '5511999990001', displayName: 'Ada', source: 'waha_contact_sync' });
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '222@lid', phone: null, displayName: 'Lovelace', source: 'waha_contact_sync' });
    expect(identitySync.enqueue).toHaveBeenCalledTimes(2);
  });

  it('skips identifiers with neither a name nor a dialable phone, because they only render as empty rows', async () => {
    const items = [
      { id: '192694311768124@lid' }, // LID sem nome: não exibe, não busca, não liga
      { id: '96139068104886@lid', name: 'Felipe' }, // LID com nome entra
      { id: '999@c.us' }, // telefone curto demais e sem nome
      { id: '5511999990001@c.us' }, // telefone sem nome entra: dá para discar
      { id: '200339068317777@lid', name: '200339068317777' }, // nome = id não é nome: fantasma
      { id: '200339068317778@c.us', name: '200339068317778' }, // idem em @c.us com 15 dígitos
      { id: '5511999990002@c.us', name: '5511999990002' }, // nome = telefone DISCÁVEL entra: dá para ligar
    ];
    const send = vi.fn().mockResolvedValue(page(items));
    const { service, store, contacts, identitySync } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ contactsProcessed: 7, contactsResolved: 3, contactsSkipped: 4 });
    expect(contacts.resolve).toHaveBeenCalledTimes(3);
    expect(identitySync.enqueue).toHaveBeenCalledTimes(3);
  });

  it('keeps synchronizing when one contact fails in the resolver', async () => {
    const contacts = resolver(); contacts.resolve.mockRejectedValueOnce(new Error('database unavailable'));
    const send = vi.fn().mockResolvedValue(page([{ id: '5511999990001@c.us' }, { id: '5511999990002@c.us' }]));
    const { service, store } = harness(send, {}, contacts);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 2, contactsResolved: 1, contactsSkipped: 1, lastErrorSafe: null });
  });

  it('retries transient provider failures with bounded exponential backoff', async () => {
    const send = vi.fn().mockResolvedValueOnce(failed('TIMEOUT')).mockResolvedValueOnce(failed('SERVICE_UNAVAILABLE')).mockResolvedValueOnce(page([]));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { service, store } = harness(send, { sleep, retryBaseMs: 10 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10); expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it('does not retry permanent provider failures and preserves the checkpoint', async () => {
    const send = vi.fn().mockImplementation((request: any) => request.command.payload.offset === 0 ? page([{ id: '1@c.us' }, { id: '2@c.us' }], true) : failed('NOT_FOUND'));
    const { service, store } = harness(send, { pageSize: 2 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'failed');
    expect(send).toHaveBeenCalledTimes(2);
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'failed', cursor: '2', contactsProcessed: 2, lastErrorSafe: 'NOT_FOUND' });
  });

  it('resumes a failed run from the recorded cursor instead of starting over', async () => {
    const send = vi.fn().mockImplementation((request: any) => request.command.payload.offset === 0 ? page([{ id: '5511999990001@c.us' }, { id: '5511999990002@c.us' }], true) : failed('NOT_FOUND'));
    const { service, store } = harness(send, { pageSize: 2 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'failed');
    send.mockImplementation((request: any) => request.command.payload.offset === 2 ? page([{ id: '5511999990003@c.us' }]) : page([]));
    const resumed = await service.start('workspace-a', 'session-a');
    expect(resumed.status).toBe('pending'); expect(resumed.cursor).toBe('2');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', cursor: '3', contactsProcessed: 3, contactsResolved: 3 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.filter((call: any[]) => call[0].command.payload.offset === 0)).toHaveLength(1);
  });

  it('checkpoints a full batch, pauses and continues automatically', async () => {
    const send = vi.fn().mockImplementation((request: any) => request.command.payload.offset === 0 ? page([{ id: '1@c.us' }, { id: '2@c.us' }], true) : page([{ id: '3@c.us' }]));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { service, store } = harness(send, { pageSize: 2, maxContactsPerRun: 2, continuationDelayMs: 1, sleep });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 3, cursor: '3' });
    expect(sleep).toHaveBeenCalledWith(1);
    expect(store.saved.some(job => job.status === 'pending' && job.cursor === '2')).toBe(true);
    expect(send.mock.calls.map((call: any[]) => call[0].command.payload.offset)).toEqual([0, 2]);
  });

  it('cancels between two contacts and never transitions to completed', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn().mockImplementation(async (request: any) => { if (request.command.payload.offset === 0) return page([{ id: '1@c.us' }], true); await blocked; return page([{ id: '2@c.us' }]); });
    const { service, store } = harness(send, { pageSize: 1 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.some(job => job.cursor === '1'));
    await service.cancel('workspace-a', 'session-a');
    release();
    await waitFor(() => store.saved.at(-1)?.status === 'cancelled');
    const job = (await service.status('workspace-a', 'session-a'))!;
    expect(job).toMatchObject({ status: 'cancelled', completedAt: null, progressLabel: 'Sincronização cancelada.' });
  });

  it('shares one active run between concurrent starts', async () => {
    const send = vi.fn().mockResolvedValue(page([]));
    const { service } = harness(send);
    const [first, second] = await Promise.all([service.start('workspace-a', 'session-a'), service.start('workspace-a', 'session-a')]);
    expect(first.id).toBe(second.id);
    await waitFor(() => first.id === second.id && send.mock.calls.length > 0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a completed run starts over from the first page, because the address book may have grown', async () => {
    const send = vi.fn().mockResolvedValue(page([{ id: '1@c.us' }]));
    const { service, store } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    const restarted = await service.start('workspace-a', 'session-a');
    expect(restarted).toMatchObject({ status: 'pending', cursor: '0', contactsProcessed: 0 });
    await waitFor(() => store.saved.at(-1)?.status === 'completed' && store.saved.at(-1)!.contactsProcessed === 1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every((call: any[]) => call[0].command.payload.offset === 0)).toBe(true);
  });

  it('publishes every transition with syncKind contacts and the progress label', async () => {
    const send = vi.fn().mockResolvedValue(page([{ id: '5511999990001@c.us' }]));
    const { service, store, realtime } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    const events = realtime.publish.mock.calls.map((call: any[]) => ({ workspace: call[0], type: call[1], payload: call[2] }));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.workspace).toBe('workspace-a'); expect(event.type).toBe('conversation.sync.updated');
      expect(event.payload).toMatchObject({ syncKind: 'contacts', wahaSession: 'session-a' });
      expect(typeof event.payload.progressLabel).toBe('string');
    }
    expect(events.at(-1)!.payload).toMatchObject({ status: 'completed', contactsProcessed: 1, contactsResolved: 1, hasMore: false, progressLabel: 'Agenda de contatos sincronizada.' });
  });

  it('survives an empty page that still reports hasMore, because the provider set shrinks under the job', async () => {
    const send = vi.fn().mockImplementation((request: any) => request.command.payload.offset === 0 ? page([], true) : page([]));
    const { service, store } = harness(send, { pageSize: 2 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect(send.mock.calls.map((call: any[]) => call[0].command.payload.offset)).toEqual([0, 2]);
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 0 });
  });

  it('falls back to the synced chats when the address book keeps timing out', async () => {
    const chats = (items: Record<string, unknown>[], hasMore = false) => ({ success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { historyPage: { kind: 'chats' as const, items, unsupported: [], hasMore } } });
    const send = vi.fn().mockImplementation((request: any) => request.command.type === 'contacts.page' ? failed('TIMEOUT') : chats([{ id: '120363@g.us', name: 'Grupo' }, { id: '1@c.us', name: 'Ana' }, { id: '2@c.us', name: 'Bruno' }]));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { service, store, contacts, identitySync } = harness(send, { sleep, retryBaseMs: 1 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    const job = (await service.status('workspace-a', 'session-a'))!;
    expect(job).toMatchObject({ status: 'completed', contactsProcessed: 3, contactsResolved: 2, contactsSkipped: 1 });
    expect(job.lastErrorSafe).toContain('conversas');
    // Três tentativas na agenda (com backoff) e então as conversas, do zero.
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'contacts.page')).toHaveLength(3);
    const chatsCalls = send.mock.calls.filter((call: any[]) => call[0].command.type === 'history.page');
    expect(chatsCalls).toHaveLength(1);
    expect(chatsCalls[0][0].command.payload).toMatchObject({ wahaSession: 'session-a', offset: 0 });
    // O grupo da lista de conversas não vira contato; os dois diretos, sim — e
    // com a origem de histórico, não de agenda: é o que separa as duas colunas
    // do picker ("celular" de "conversas").
    expect(contacts.resolve).toHaveBeenCalledTimes(2);
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '1@c.us', phone: null, displayName: 'Ana', source: 'waha_chat_history' });
    expect(identitySync.enqueue).toHaveBeenCalledTimes(2);
  });

  it('tries the address book again on a fresh start after a fallback run', async () => {
    let answer: unknown = failed('TIMEOUT');
    const send = vi.fn().mockImplementation((request: any) => request.command.type === 'contacts.page' ? answer : ({ success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { historyPage: { kind: 'chats' as const, items: [{ id: '1@c.us' }, { id: '2@c.us' }], unsupported: [], hasMore: false } } }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { service, store } = harness(send, { sleep, retryBaseMs: 1 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    answer = page([{ id: '3@c.us' }]);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed' && store.saved.at(-1)!.contactsProcessed === 1);
    // 3 TIMEOUTs da primeira corrida + 1 sucesso da segunda: o fallback é estado
    // da corrida, não do job — uma agenda que voltou a responder é usada de novo.
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'contacts.page')).toHaveLength(4);
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', lastErrorSafe: null });
  });

  it('fails the run when neither the address book nor the chats answer', async () => {
    const send = vi.fn().mockResolvedValue(failed('TIMEOUT'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { service, store } = harness(send, { sleep, retryBaseMs: 1 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'failed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'failed', lastErrorSafe: 'TIMEOUT' });
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'contacts.page')).toHaveLength(3);
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'history.page')).toHaveLength(3);
  });
});
