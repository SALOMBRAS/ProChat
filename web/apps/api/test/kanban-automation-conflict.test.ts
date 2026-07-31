import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { RealtimeHub } from '../src/realtime.js';
import { KanbanService } from '../src/services/kanban.service.js';
import { SupabaseKanbanService } from '../src/services/supabase-kanban.service.js';
import { kanbanRetry, kanbanRetryDelayMs, type KanbanRetry } from '../src/services/kanban-conflict.js';
import { KanbanAutomationCoordinator } from '../src/services/kanban-automation.service.js';
import { InternalInboxService } from '../src/services/internal-inbox.service.js';
import { AppError } from '../src/errors.js';

const directories: string[] = [];
const migrations = join(process.cwd(), 'migrations');
const workspaceId = 'workspace-a';
const conversationId = '00000000-0000-4000-8000-000000000051';
const sla = { status: async () => undefined, reopen: async () => undefined, applyOperationalStatus: async () => undefined } as any;

/** Loses the race a fixed number of times before deferring to the real move, which
 *  is what a concurrent writer looks like from inside `automated()`. */
class RacingKanbanService extends KanbanService {
  public attempts = 0;
  public readonly inputs: Array<Record<string, unknown>> = [];
  constructor(database: SqlitePersistenceDatabase, realtime: RealtimeHub, retry: KanbanRetry, private readonly conflicts: number) { super(database.sqlite, realtime, sla, retry); }
  async move(workspace: string, actorId: string, conversation: string, input: any) {
    this.attempts += 1; this.inputs.push(input);
    if (this.attempts <= this.conflicts) throw new AppError(409, 'CONFLICT', 'Conversation was moved by another operator');
    return super.move(workspace, actorId, conversation, input);
  }
}

function setup(conflicts = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-kanban-conflict-')); directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), migrations); database.migrate();
  const stamp = new Date().toISOString();
  database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(conversationId, workspaceId, 'primary', '5511999990000@c.us', null, 'open', 'Olá', stamp, 0, stamp, stamp);
  const waits: number[] = [];
  const retry = kanbanRetry({ sleep: async milliseconds => { waits.push(milliseconds); }, random: () => 0.5 });
  const service = new RacingKanbanService(database, new RealtimeHub(), retry, conflicts);
  return { database, service, waits };
}

/** The board only advances an inbound message out of `waiting_customer`, so every
 *  test starts the card there — anywhere else the rule declines before the race. */
async function waitingCustomer(database: SqlitePersistenceDatabase, service: KanbanService) {
  const [board] = await service.boards(workspaceId);
  const stage = board.stages.find(item => item.key === 'waiting_customer')!;
  database.sqlite.prepare('UPDATE conversation_kanban_state SET stageId=? WHERE workspaceId=? AND conversationId=? AND boardId=?').run(stage.id, workspaceId, conversationId, board.id);
  return board;
}

const stageKey = (database: SqlitePersistenceDatabase) => (database.sqlite.prepare('SELECT k.key FROM conversation_kanban_state s JOIN kanban_stages k ON k.id=s.stageId WHERE s.conversationId=?').get(conversationId) as { key: string }).key;
const total = (database: SqlitePersistenceDatabase, sql: string, ...args: unknown[]) => (database.sqlite.prepare(sql).get(...args) as { total: number }).total;

afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('Kanban automation under conflict', () => {
  it('leaves a card from the history sync where it is instead of advancing its stage', async () => {
    const { database, service } = setup(); try {
      await waitingCustomer(database, service);
      const result = await service.automated({ workspaceId, conversationId, messageId: 'history-message', direction: 'inbound', historical: true, visible: true });
      expect(result).toEqual({ status: 'skipped', reason: 'ineligible_origin' });
      expect(stageKey(database)).toBe('waiting_customer');
      expect(service.attempts).toBe(0);
      expect(total(database, 'SELECT count(*) total FROM conversation_kanban_events WHERE conversationId=?', conversationId)).toBe(0);
      expect(total(database, 'SELECT count(*) total FROM kanban_automation_deliveries WHERE messageId=?', 'history-message')).toBe(0);
    } finally { database.close(); }
  });

  it('re-reads the state and settles the move after a conflict instead of repeating the losing attempt', async () => {
    const { database, service, waits } = setup(1); try {
      await waitingCustomer(database, service);
      const result = await service.automated({ workspaceId, conversationId, messageId: 'live-message', direction: 'inbound', visible: true });
      expect(result).toEqual({ status: 'moved' });
      expect(service.attempts).toBe(2);
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThan(0);
      expect(stageKey(database)).toBe('waiting_operator');
      expect(total(database, 'SELECT count(*) total FROM kanban_automation_deliveries WHERE messageId=?', 'live-message')).toBe(1);
    } finally { database.close(); }
  });

  it('gives up at the attempt cap instead of retrying the conflict without end', async () => {
    const { database, service, waits } = setup(99); try {
      await waitingCustomer(database, service);
      await expect(service.automated({ workspaceId, conversationId, messageId: 'doomed-message', direction: 'inbound', visible: true })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(service.attempts).toBe(3);
      expect(waits).toHaveLength(2);
      expect(waits[1]).toBeGreaterThan(waits[0]);
      expect(stageKey(database)).toBe('waiting_customer');
      expect(total(database, 'SELECT count(*) total FROM kanban_automation_deliveries WHERE messageId=?', 'doomed-message')).toBe(1);
    } finally { database.close(); }
  });

  it('carries the version it read into the automated move instead of moving unconditionally', async () => {
    const { database, service } = setup(); try {
      const board = await waitingCustomer(database, service);
      const before = database.sqlite.prepare('SELECT updatedAt FROM conversation_kanban_state WHERE conversationId=? AND boardId=?').get(conversationId, board.id) as { updatedAt: string };
      await service.automated({ workspaceId, conversationId, messageId: 'versioned-message', direction: 'inbound', visible: true });
      expect(service.inputs[0]).toMatchObject({ expectedUpdatedAt: before.updatedAt });
    } finally { database.close(); }
  });

  it('spreads every wait and never returns a zero delay', () => {
    expect(kanbanRetryDelayMs(1, () => 0)).toBeGreaterThan(0);
    expect(kanbanRetryDelayMs(2, () => 0)).toBeGreaterThan(kanbanRetryDelayMs(1, () => 0));
    expect(kanbanRetryDelayMs(1, () => 1)).toBeGreaterThan(kanbanRetryDelayMs(1, () => 0));
    expect(kanbanRetryDelayMs(20, () => 1)).toBe(400);
  });

  // Supabase is the provider that actually raises 40001, so its loop is covered on
  // its own: `boards` and `move` are stubbed and only the two client calls the loop
  // itself makes — reading the state and claiming the delivery — stay real.
  it('re-reads the remote state and claims the delivery once across attempts', async () => {
    const stageState = { stage_id: 'stage-waiting-customer', manual_override: false, updated_at: '2026-07-30T00:00:00.000Z', kanban_stages: { key: 'waiting_customer' } };
    const inserts: unknown[] = []; let reads = 0;
    const chain = (value: unknown) => { const link: any = { then: (resolve: any) => Promise.resolve(value).then(resolve), maybeSingle: () => Promise.resolve(value) }; for (const method of ['select', 'eq']) link[method] = () => link; return link; };
    const client = { from: (table: string) => table === 'conversation_kanban_state' ? (reads += 1, chain({ data: stageState, error: null })) : { insert: (row: unknown) => { inserts.push(row); return Promise.resolve(inserts.length === 1 ? { error: null } : { error: { code: '23505' } }); } } } as never;
    const board = { id: 'board-1', stages: [{ id: 'stage-waiting-operator', key: 'waiting_operator' }] };
    const waits: number[] = [];
    class RacingRemote extends SupabaseKanbanService {
      public attempts = 0;
      async boards() { return [board] as any; }
      async move() { this.attempts += 1; if (this.attempts === 1) throw new AppError(409, 'CONFLICT', 'Conversation was moved by another operator'); return {} as any; }
    }
    const service = new RacingRemote(client, new RealtimeHub(), sla, kanbanRetry({ sleep: async milliseconds => { waits.push(milliseconds); }, random: () => 0.5 }));
    expect(await service.automated({ workspaceId, conversationId, messageId: 'remote-message', direction: 'inbound', visible: true })).toEqual({ status: 'moved' });
    expect(service.attempts).toBe(2);
    expect(reads).toBe(2);
    expect(inserts).toHaveLength(1);
    expect(waits).toHaveLength(1);
  });

  it('keeps a historical message off the remote board without even reading its state', async () => {
    let reads = 0;
    const client = { from: () => { reads += 1; return {} as any; } } as never;
    class Remote extends SupabaseKanbanService {
      public moves = 0;
      async boards() { reads += 1; return [{ id: 'board-1', stages: [] }] as any; }
      async move() { this.moves += 1; return {} as any; }
    }
    const service = new Remote(client, new RealtimeHub(), sla);
    expect(await service.automated({ workspaceId, conversationId, messageId: 'remote-history', direction: 'inbound', historical: true, visible: true })).toEqual({ status: 'skipped', reason: 'ineligible_origin' });
    expect(reads).toBe(0);
    expect(service.moves).toBe(0);
  });

  // The ingest cannot report a historical outbound today, because outboundRecord
  // never stamps `_history`. The field is passed anyway so that the day it can,
  // the board does not start reacting to a backfilled send — the SLA call on the
  // very next line has always passed it.
  it('tells the board an outbound message is historical instead of leaving the field out', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const coordinator = new KanbanAutomationCoordinator({ automated: async request => { seen.push(request as never); return { status: 'skipped', reason: 'ineligible_origin' }; } });
    const conversation = { id: 'conversation-a', chatId: '5585999990001@c.us', deliveryChatId: null, whatsappSessionId: 'session-a' };
    const store = { getConversation: async () => conversation, recordOutbound: async () => ({ id: 'wamid-a', direction: 'outbound', content: null, timestamp: '2026-07-28T12:00:00.000Z', status: 'sent', messageType: 'location', chatId: conversation.chatId, metadata: {}, persistence: { messageInserted: true, conversationId: 'conversation-a', duplicate: false, historical: true } }) } as never;
    const worker = { send: async () => ({ success: true, correlationId: 'c', workspaceId, data: { sentMessage: { id: 'wamid-a', timestamp: '2026-07-28T12:00:00.000Z' } } }) } as never;
    const service = new InternalInboxService(worker, store, { publish: () => undefined } as never, coordinator);
    await service.sendLocation({ workspaceId, correlationId: 'correlation-a', userId: 'user-a' } as never, 'conversation-a', { latitude: -7.115, longitude: -34.861 });
    expect(seen[0]).toMatchObject({ direction: 'outbound', historical: true });
  });

  // Regression guard for the premise the retry rests on: if the remote service ever
  // stopped translating 40001 into this AppError, the loop above would treat a lost
  // race as an unrecoverable error and the card would silently stay put again.
  it('reports a lost race on the remote provider as a conflict instead of a generic failure', async () => {
    const answer = (value: unknown) => { const chain: any = { then: (resolve: any) => Promise.resolve(value).then(resolve), maybeSingle: () => Promise.resolve(value), single: () => Promise.resolve(value) }; for (const method of ['select', 'eq', 'order', 'limit', 'in', 'is', 'neq']) chain[method] = () => chain; return chain; };
    const client = {
      from: (table: string) => table === 'kanban_stages'
        ? answer({ data: { id: 'stage-1', board_id: 'board-1', key: 'waiting_operator', name: 'Aguardando operador', position: 4, is_terminal: false, is_archived_stage: false, created_at: null, updated_at: null, kanban_boards: { workspace_id: workspaceId } }, error: null })
        : answer({ data: [{ position: 3 }], error: null }),
      rpc: async () => ({ data: null, error: { code: '40001', message: 'kanban conflict' } }),
    } as never;
    const service = new SupabaseKanbanService(client, new RealtimeHub(), sla);
    await expect(service.move(workspaceId, '00000000-0000-4000-8000-000000000001', conversationId, { boardId: 'board-1', stageId: 'stage-1', source: 'inbound', expectedUpdatedAt: '2026-07-30T00:00:00.000Z' })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });
});
