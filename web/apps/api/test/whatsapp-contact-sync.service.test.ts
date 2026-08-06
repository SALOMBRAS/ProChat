import { describe, expect, it, vi } from 'vitest';
import { MemoryContactSyncStore, WhatsAppContactSyncService, type ContactSyncJob, type ContactSyncOptions } from '../src/services/whatsapp-contact-sync.service.js';
import type { InternalWorkerClient } from '../src/internal-worker-client.js';
import type { ContactIdentityResolver } from '../src/services/contact-identity-resolver.service.js';
import type { RealtimeHub } from '../src/realtime.js';

class CountingStore extends MemoryContactSyncStore { saved: ContactSyncJob[] = []; override async save(job: ContactSyncJob) { this.saved.push({ ...job }); await super.save(job); } }
const waitFor = async (check: () => boolean) => { for (let attempt = 0; attempt < 100; attempt += 1) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('timed out'); };
const page = (items: Record<string, unknown>[], hasMore = false) => ({ success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { contactsPage: { items: items.map(item => ({ isMyContact: true, ...item })), unsupported: [], hasMore } } });
const lids = (items: Record<string, unknown>[], hasMore = false) => ({ success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { lidsPage: { items, unsupported: [], hasMore } } });
const chats = (items: Record<string, unknown>[], hasMore = false) => ({ success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { historyPage: { kind: 'chats' as const, items, unsupported: [], hasMore } } });
const failed = (code: string) => ({ success: false as const, correlationId: 'c', workspaceId: 'workspace-a', error: { code, message: code, details: {} } });
/** A corrida tem duas fases: agenda, depois conversas. Os mocks dos testes
 *  medem a agenda; este embrulho responde conversas vazias à segunda fase
 *  para que cada teste meça exatamente o que media antes das duas fases. */
const withChats = (answer: (request: any) => unknown) => (request: any) => request.command.type === 'history.page' ? chats([]) : answer(request);
const resolver = () => ({ resolve: vi.fn().mockResolvedValue(undefined), resolveDetailed: vi.fn() }) as unknown as ContactIdentityResolver & { resolve: ReturnType<typeof vi.fn> };
const harness = (send: ReturnType<typeof vi.fn>, options: ContactSyncOptions = {}, contacts = resolver()) => {
  const store = new CountingStore(); const identitySync = { enqueue: vi.fn() }; const realtime = { publish: vi.fn() };
  const service = new WhatsAppContactSyncService({ send } as unknown as InternalWorkerClient, contacts, store, identitySync, realtime as unknown as RealtimeHub, options);
  return { service, store, send, contacts, identitySync, realtime };
};

describe('WhatsAppContactSyncService', () => {
  it('paginates the whole address book and completes with per-page checkpoints', async () => {
    const send = vi.fn().mockImplementation(withChats((request: any) => request.command.payload.offset === 0 ? page([{ id: '5511999990001@c.us' }, { id: '5511999990002@c.us' }], true) : page([{ id: '5511999990003@c.us' }])));
    const { service, store, send: sent, identitySync } = harness(send, { pageSize: 2 });
    const started = await service.start('workspace-a', 'session-a');
    expect(started.status).toBe('pending'); expect(started.syncKind).toBe('contacts');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    const job = (await service.status('workspace-a', 'session-a'))!;
    expect(job).toMatchObject({ status: 'completed', cursor: '0', contactsProcessed: 3, contactsResolved: 3, contactsSkipped: 0, hasMore: false, progressLabel: 'Agenda de contatos sincronizada.' });
    expect(sent.mock.calls.map((call: any[]) => call[0].command)).toEqual([
      { type: 'contacts.page', payload: { wahaSession: 'session-a', offset: 0, limit: 2 } },
      { type: 'contacts.page', payload: { wahaSession: 'session-a', offset: 2, limit: 2 } },
      // Segunda fase: esgotada a agenda, as conversas completam a coluna do histórico.
      { type: 'history.page', payload: { wahaSession: 'session-a', offset: 0, limit: 2 } },
    ]);
    expect(identitySync.enqueue).toHaveBeenCalledTimes(3);
    expect(identitySync.enqueue).toHaveBeenCalledWith({ workspaceId: 'workspace-a', wahaSession: 'session-a', chatId: '5511999990001@c.us' });
  });

  it('syncs the address book first and the synced chats second, one origin per column', async () => {
    const send = vi.fn().mockImplementation((request: any) => request.command.type === 'contacts.page'
      ? page([{ id: '5511999990001@c.us', name: 'Ana' }])
      : chats([{ id: '5511999990002@c.us', name: 'Bruno' }, { id: '5511999990001@c.us', name: 'Ana' }]));
    const { service, store, contacts } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 3, lastErrorSafe: null });
    // Agenda com origem de agenda; conversa com origem de histórico — é o que
    // separa "Salvos no celular" de "Histórico de conversas" no picker. A Ana
    // reaparece nas conversas e resolve de novo: idempotente, sem duplicar.
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '5511999990001@c.us', phone: '5511999990001', displayName: 'Ana', source: 'waha_contact_sync' });
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '5511999990002@c.us', phone: '5511999990002', displayName: 'Bruno', source: 'waha_chat_history' });
    expect(send.mock.calls.map((call: any[]) => call[0].command.type)).toEqual(['contacts.page', 'history.page']);
  });

  it('labels only the phone-own contacts as address book, because the provider loads everyone the session knows', async () => {
    // Medido na sessão real: ~9 mil itens em contacts/all, ~180 com
    // isMyContact — a agenda do telefone é o flag, não a página. Quem só
    // divide grupo com a conta vem junto e vai para a coluna do histórico.
    // Resposta crua, sem o helper: ele injeta o flag em todo item, e aqui o
    // teste é justamente a presença/ausência dele.
    const raw = (items: Record<string, unknown>[]) => ({ success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { contactsPage: { items, unsupported: [], hasMore: false } } });
    const send = vi.fn().mockImplementation(withChats(() => raw([
      { id: '558592369359@c.us', name: 'Sal', isMyContact: true }, // salvo no celular
      { id: '5524999513298@c.us', pushname: 'Colega de grupo', isMyContact: false }, // só divide grupo
      { id: '5511999990003@c.us', pushname: 'Sem o flag' }, // provedor antigo sem o campo: histórico
    ])));
    const { service, store, contacts } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 3, contactsResolved: 3 });
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '558592369359@c.us', phone: '558592369359', displayName: 'Sal', source: 'waha_contact_sync' });
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '5524999513298@c.us', phone: '5524999513298', displayName: 'Colega de grupo', source: 'waha_chat_history' });
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '5511999990003@c.us', phone: '5511999990003', displayName: 'Sem o flag', source: 'waha_chat_history' });
  });

  it('skips groups, broadcast channels and non-conversation identifiers without calling the resolver', async () => {
    const items = [
      { id: '120363@g.us' }, { id: '55@g.us', isGroup: true }, { id: 'status@broadcast' }, { id: '1@broadcast' }, { id: '2@newsletter' }, { id: 'not-an-address' }, { name: 'sem id' },
      { id: '5511999990001@c.us', number: '+55 (11) 99999-0001', name: ' Ada ' }, { id: '222@lid', pushname: 'Lovelace' },
    ];
    const send = vi.fn().mockImplementation(withChats(() => page(items)));
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
    const send = vi.fn().mockImplementation(withChats(() => page(items)));
    const { service, store, contacts, identitySync } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ contactsProcessed: 7, contactsResolved: 3, contactsSkipped: 4 });
    expect(contacts.resolve).toHaveBeenCalledTimes(3);
    expect(identitySync.enqueue).toHaveBeenCalledTimes(3);
  });

  it('keeps synchronizing when one contact fails in the resolver', async () => {
    const contacts = resolver(); contacts.resolve.mockRejectedValueOnce(new Error('database unavailable'));
    const send = vi.fn().mockImplementation(withChats(() => page([{ id: '5511999990001@c.us' }, { id: '5511999990002@c.us' }])));
    const { service, store } = harness(send, {}, contacts);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 2, contactsResolved: 1, contactsSkipped: 1, lastErrorSafe: null });
  });

  it('retries transient provider failures with bounded exponential backoff', async () => {
    const answers = [failed('TIMEOUT'), failed('SERVICE_UNAVAILABLE'), page([])];
    const send = vi.fn().mockImplementation(withChats(() => answers.shift() ?? page([])));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { service, store } = harness(send, { sleep, retryBaseMs: 10 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'contacts.page')).toHaveLength(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10); expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it('does not retry permanent provider failures and preserves the checkpoint', async () => {
    const send = vi.fn().mockImplementation(withChats((request: any) => request.command.payload.offset === 0 ? page([{ id: '1@c.us' }, { id: '2@c.us' }], true) : failed('NOT_FOUND')));
    const { service, store } = harness(send, { pageSize: 2 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'failed');
    expect(send).toHaveBeenCalledTimes(2);
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'failed', cursor: '2', contactsProcessed: 2, lastErrorSafe: 'NOT_FOUND' });
  });

  it('resumes a failed run from the recorded cursor instead of starting over', async () => {
    const send = vi.fn().mockImplementation(withChats((request: any) => request.command.payload.offset === 0 ? page([{ id: '5511999990001@c.us' }, { id: '5511999990002@c.us' }], true) : failed('NOT_FOUND')));
    const { service, store } = harness(send, { pageSize: 2 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'failed');
    send.mockImplementation(withChats((request: any) => request.command.payload.offset === 2 ? page([{ id: '5511999990003@c.us' }]) : page([])));
    const resumed = await service.start('workspace-a', 'session-a');
    expect(resumed.status).toBe('pending'); expect(resumed.cursor).toBe('2');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', cursor: '0', contactsProcessed: 3, contactsResolved: 3 });
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'contacts.page' && call[0].command.payload.offset === 0)).toHaveLength(1);
  });

  it('checkpoints a full batch, pauses and continues automatically', async () => {
    const send = vi.fn().mockImplementation(withChats((request: any) => request.command.payload.offset === 0 ? page([{ id: '1@c.us' }, { id: '2@c.us' }], true) : page([{ id: '3@c.us' }])));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { service, store } = harness(send, { pageSize: 2, maxContactsPerRun: 2, continuationDelayMs: 1, sleep });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 3, cursor: '0' });
    expect(sleep).toHaveBeenCalledWith(1);
    expect(store.saved.some(job => job.status === 'pending' && job.cursor === '2')).toBe(true);
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'contacts.page').map((call: any[]) => call[0].command.payload.offset)).toEqual([0, 2]);
  });

  it('cancels between two contacts and never transitions to completed', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn().mockImplementation(withChats(async (request: any) => { if (request.command.payload.offset === 0) return page([{ id: '1@c.us' }], true); await blocked; return page([{ id: '2@c.us' }]); }));
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
    const send = vi.fn().mockImplementation(withChats(() => page([])));
    const { service } = harness(send);
    const [first, second] = await Promise.all([service.start('workspace-a', 'session-a'), service.start('workspace-a', 'session-a')]);
    expect(first.id).toBe(second.id);
    await waitFor(() => first.id === second.id && send.mock.calls.length > 0);
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'contacts.page')).toHaveLength(1);
  });

  it('a completed run starts over from the first page, because the address book may have grown', async () => {
    const send = vi.fn().mockImplementation(withChats(() => page([{ id: '1@c.us' }])));
    const { service, store } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    const restarted = await service.start('workspace-a', 'session-a');
    expect(restarted).toMatchObject({ status: 'pending', cursor: '0', contactsProcessed: 0 });
    await waitFor(() => store.saved.at(-1)?.status === 'completed' && store.saved.at(-1)!.contactsProcessed === 1);
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'contacts.page')).toHaveLength(2);
    expect(send.mock.calls.every((call: any[]) => call[0].command.payload.offset === 0)).toBe(true);
  });

  it('publishes every transition with syncKind contacts and the progress label', async () => {
    const send = vi.fn().mockImplementation(withChats(() => page([{ id: '5511999990001@c.us' }])));
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
    const send = vi.fn().mockImplementation(withChats((request: any) => request.command.payload.offset === 0 ? page([], true) : page([])));
    const { service, store } = harness(send, { pageSize: 2 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'contacts.page').map((call: any[]) => call[0].command.payload.offset)).toEqual([0, 2]);
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 0 });
  });

  it('falls back to the synced chats when the address book keeps timing out', async () => {
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
    let chatsAnswer: unknown = chats([{ id: '1@c.us' }, { id: '2@c.us' }]);
    const send = vi.fn().mockImplementation((request: any) => request.command.type === 'contacts.page' ? answer : chatsAnswer);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { service, store } = harness(send, { sleep, retryBaseMs: 1 });
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    answer = page([{ id: '3@c.us' }]); chatsAnswer = chats([]);
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

  it('repairs a technical display name with the WhatsApp name after resolving, because resolution only names on creation', async () => {
    // O caso da base: contato criado pelo webhook com LID como "nome". A
    // resolução não renomeia quem já existe — o reparo troca o rótulo técnico
    // pelo nome que veio no payload da agenda.
    const contacts = resolver(); contacts.resolve.mockResolvedValue({ id: 'contact-1', phoneNumber: '96139068104886' });
    const nameRepair = { repairIfTechnical: vi.fn().mockResolvedValue(undefined) };
    const send = vi.fn().mockImplementation(withChats(() => page([{ id: '96139068104886@c.us', pushname: 'Felipe' }])));
    const { service, store } = harness(send, { nameRepair }, contacts);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect(nameRepair.repairIfTechnical).toHaveBeenCalledWith('workspace-a', 'contact-1', 'Felipe');
  });

  it('does not repair when the contact has no real name to offer', async () => {
    const contacts = resolver(); contacts.resolve.mockResolvedValue({ id: 'contact-1', phoneNumber: '5511999990001' });
    const nameRepair = { repairIfTechnical: vi.fn().mockResolvedValue(undefined) };
    const send = vi.fn().mockImplementation(withChats(() => page([{ id: '5511999990001@c.us' }])));
    const { service, store } = harness(send, { nameRepair }, contacts);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect(nameRepair.repairIfTechnical).not.toHaveBeenCalled();
  });

  it('keeps the contact resolved when the name repair itself fails', async () => {
    const contacts = resolver(); contacts.resolve.mockResolvedValue({ id: 'contact-1', phoneNumber: '5511999990001' });
    const nameRepair = { repairIfTechnical: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const send = vi.fn().mockImplementation(withChats(() => page([{ id: '5511999990001@c.us', name: 'Ana' }])));
    const { service, store } = harness(send, { nameRepair }, contacts);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsResolved: 1, contactsSkipped: 0 });
  });

  it('resolves the real phone of a lid from the session mappings before ingesting', async () => {
    const send = vi.fn().mockImplementation(withChats((request: any) => request.command.type === 'lids.page'
      ? lids([{ lid: '96139068104886@lid', pn: '558197744203@c.us' }, { lid: '192694311768124@lid', pn: '559184484543@c.us' }, { lid: '200339068317778@lid', pn: '5585988887777@c.us' }])
      : page([
          { id: '96139068104886@lid', name: 'Felipe' }, // LID com nome: entra rotulado e discável
          { id: '192694311768124@lid' }, // LID sem nome mas com pn: entra, e o resolver rotula com o telefone
          { id: '200339068317778@lid', name: '200339068317778' }, // nome = id: conta como sem nome, entra pelo pn
          { id: '200339068317777@lid' }, // sem nome e fora do mapa: continua fantasma, fora
        ])));
    const { service, store, contacts } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 4, contactsResolved: 3, contactsSkipped: 1 });
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '96139068104886@lid', phone: '558197744203', displayName: 'Felipe', source: 'waha_contact_sync' });
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '192694311768124@lid', phone: '559184484543', displayName: null, source: 'waha_contact_sync' });
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '200339068317778@lid', phone: '5585988887777', displayName: null, source: 'waha_contact_sync' });
    // O mapa é carregado uma vez por corrida, por mais LIDs que a página tenha.
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'lids.page')).toHaveLength(1);
  });

  it('pages the lid mappings until the provider says the set is over', async () => {
    const send = vi.fn().mockImplementation(withChats((request: any) => {
      if (request.command.type === 'lids.page') return request.command.payload.offset === 0 ? lids([{ lid: '96139068104886@lid', pn: '558197744203@c.us' }], true) : lids([{ lid: '192694311768124@lid', pn: '559184484543@c.us' }]);
      return page([{ id: '192694311768124@lid' }]);
    }));
    const { service, store, contacts } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    expect(send.mock.calls.filter((call: any[]) => call[0].command.type === 'lids.page').map((call: any[]) => call[0].command.payload.offset)).toEqual([0, 1]);
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '192694311768124@lid', phone: '559184484543', displayName: null, source: 'waha_contact_sync' });
  });

  it('keeps the previous behavior when the lid mappings endpoint does not answer', async () => {
    const send = vi.fn().mockImplementation(withChats((request: any) => request.command.type === 'lids.page' ? failed('NOT_IMPLEMENTED') : page([{ id: '96139068104886@lid', name: 'Felipe' }, { id: '192694311768124@lid' }])));
    const { service, store, contacts } = harness(send);
    await service.start('workspace-a', 'session-a');
    await waitFor(() => store.saved.at(-1)?.status === 'completed');
    // Fail-open de propósito: sem mapa, o LID com nome entra como antes (sem
    // telefone — `phoneFromIdentifier` não extrai de `@lid`) e o sem nome é
    // ignorado. Uma sessão sem o endpoint não pode derrubar a sincronização.
    expect((await service.status('workspace-a', 'session-a'))!).toMatchObject({ status: 'completed', contactsProcessed: 2, contactsResolved: 1, contactsSkipped: 1 });
    expect(contacts.resolve).toHaveBeenCalledWith({ workspaceId: 'workspace-a', identifier: '96139068104886@lid', phone: null, displayName: 'Felipe', source: 'waha_contact_sync' });
  });
});
