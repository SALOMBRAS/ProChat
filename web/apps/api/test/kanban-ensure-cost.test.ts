import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { RealtimeHub } from '../src/realtime.js';
import { KanbanService } from '../src/services/kanban.service.js';
import { SupabaseKanbanService } from '../src/services/supabase-kanban.service.js';

/**
 * O custo que estes testes trancam é o da PR #86: `ensure()` lia TODAS as
 * conversas visíveis do workspace e escrevia uma linha de estado para cada uma —
 * a cada leitura do quadro E a cada mensagem de entrada elegível. O contador de
 * consultas abaixo é o instrumento: ele cresce com o número de conversas
 * enquanto a varredura estiver no caminho, e para de crescer quando ela sai.
 */
const directories: string[] = [];
const migrations = join(process.cwd(), 'migrations');
const workspaceId = 'workspace-a';
const sla = { status: async () => undefined, reopen: async () => undefined, applyOperationalStatus: async () => undefined } as any;

/** Conta consultas por tabela, sem tocar no comportamento. */
function counting(database: SqlitePersistenceDatabase) {
  const original = database.sqlite.prepare.bind(database.sqlite);
  const tally = new Map<string, number>();
  (database.sqlite as unknown as { prepare: typeof original }).prepare = (sql: string) => {
    const table = /(?:FROM|INTO|UPDATE)\s+([a-zA-Z_]+)/.exec(sql)?.[1] ?? 'outra';
    const verb = /^\s*(SELECT|INSERT|UPDATE|DELETE)/i.exec(sql)?.[1]?.toUpperCase() ?? '?';
    const key = `${verb} ${table}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    return original(sql);
  };
  return { tally, total: () => [...tally.values()].reduce((sum, value) => sum + value, 0), reset: () => tally.clear() };
}

function setup(conversations: number) {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-kanban-cost-')); directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), migrations); database.migrate();
  const stamp = new Date().toISOString();
  const insert = database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  // O lote inteiro numa transação: no padrão do SQLite (`journal_mode = delete`,
  // `synchronous = FULL`) cada `.run()` solto é uma transação implícita com dois
  // `fsync` e um arquivo de journal criado e apagado. Os dois casos mais pesados
  // daqui montam 5 + 80 conversas na mesma execução, e o arquivo passa de 300
  // linhas somando as chamadas — espera de disco que nada tem a ver com o custo
  // que estes testes trancam. Ver `web/docs/testing.md`.
  const ids = database.sqlite.transaction(() => {
    const criadas: string[] = [];
    for (let index = 0; index < conversations; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      criadas.push(id);
      insert.run(id, workspaceId, 'primary', `551199999${String(index).padStart(4, '0')}@c.us`, null, 'open', 'Olá', stamp, 0, stamp, stamp);
    }
    return criadas;
  })();
  // A transação é montada aqui de propósito, antes de `counting()` trocar o
  // `prepare` do banco: o medidor conta consultas do serviço, e o cenário não
  // pode aparecer na conta.
  return { database, ids, service: new KanbanService(database.sqlite, new RealtimeHub(), sla) };
}

const states = (database: SqlitePersistenceDatabase) => (database.sqlite.prepare('SELECT count(*) total FROM conversation_kanban_state').get() as { total: number }).total;

afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('Kanban board bootstrap cost', () => {
  it('reads the board without touching a single conversation, however many there are', async () => {
    const { database, service } = setup(40); try {
      const meter = counting(database);
      await service.boards(workspaceId);
      expect(meter.tally.get('SELECT conversations') ?? 0).toBe(0);
      expect(meter.tally.get('INSERT conversation_kanban_state') ?? 0).toBe(0);
      expect(states(database)).toBe(0);
    } finally { database.close(); }
  });

  it('costs the same to open the board with 5 conversations as with 80', async () => {
    const small = setup(5), large = setup(80);
    try {
      const a = counting(small.database); await small.service.boards(workspaceId);
      const b = counting(large.database); await large.service.boards(workspaceId);
      expect(b.total()).toBe(a.total());
    } finally { small.database.close(); large.database.close(); }
  });

  it('gives a card only to the conversation the message touches, not to every conversation', async () => {
    const { database, service, ids } = setup(40); try {
      const meter = counting(database);
      await service.automated({ workspaceId, conversationId: ids[0], messageId: 'live-1', direction: 'inbound', visible: true });
      // Uma leitura da conversa que chegou, e uma escrita. Não quarenta.
      expect(meter.tally.get('INSERT conversation_kanban_state') ?? 0).toBe(1);
      expect(states(database)).toBe(1);
      expect((database.sqlite.prepare('SELECT conversationId FROM conversation_kanban_state').get() as { conversationId: string }).conversationId).toBe(ids[0]);
    } finally { database.close(); }
  });

  it('costs the same to ingest a message with 5 conversations as with 80', async () => {
    const small = setup(5), large = setup(80);
    try {
      const a = counting(small.database); await small.service.automated({ workspaceId, conversationId: small.ids[0], messageId: 'm', direction: 'inbound', visible: true });
      const b = counting(large.database); await large.service.automated({ workspaceId, conversationId: large.ids[0], messageId: 'm', direction: 'inbound', visible: true });
      expect(b.total()).toBe(a.total());
    } finally { small.database.close(); large.database.close(); }
  });

  it('repairs every visible conversation at once, and reports what it did', async () => {
    const { database, service } = setup(12); try {
      await expect(service.backfillStates(workspaceId)).resolves.toMatchObject({ examined: 12, created: 12 });
      expect(states(database)).toBe(12);
      // Idempotente: rodar de novo não cria nada e não falha.
      await expect(service.backfillStates(workspaceId)).resolves.toMatchObject({ examined: 12, created: 0 });
      expect(states(database)).toBe(12);
    } finally { database.close(); }
  });

  // A lacuna assumida, explicitamente coberta pelo reparo: uma conversa que só
  // recebeu mensagem histórica nunca chega ao corpo de `automated()`, então não
  // ganha card na ingestão. É o preço de manter a criação fora do arquivo de
  // ingestão, e o reparo é quem a recolhe.
  it('leaves a history-only conversation without a card until the repair runs', async () => {
    const { database, service, ids } = setup(3); try {
      await service.automated({ workspaceId, conversationId: ids[0], messageId: 'old', direction: 'inbound', historical: true, visible: true });
      expect(states(database)).toBe(0);
      await service.backfillStates(workspaceId);
      expect(states(database)).toBe(3);
    } finally { database.close(); }
  });

  it('never gives a card to a conversation that is not visible', async () => {
    const { database, service, ids } = setup(4); try {
      database.sqlite.prepare("UPDATE conversations SET visibilityState='quarantined' WHERE id=?").run(ids[0]);
      await expect(service.backfillStates(workspaceId)).resolves.toMatchObject({ examined: 3, created: 3 });
      await service.automated({ workspaceId, conversationId: ids[0], messageId: 'q', direction: 'inbound', visible: true });
      expect(states(database)).toBe(3);
    } finally { database.close(); }
  });

  it('exposes the repair as its own route, because it is the only place the sweep still runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chatpro-kanban-route-')); directories.push(directory);
    const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), developmentUserId: '00000000-0000-4000-8000-000000000001' });
    try {
      const stamp = new Date().toISOString();
      app.locals.persistenceDatabase.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('00000000-0000-4000-8000-000000000901', workspaceId, 'primary', '5511999990901@c.us', null, 'open', 'Olá', stamp, 0, stamp, stamp);
      const post = () => request(app).post('/api/v1/inbox/kanban/backfill').set('x-workspace-id', workspaceId).set('x-user-id', '00000000-0000-4000-8000-000000000001');
      await post().expect(200).expect(response => expect(response.body).toMatchObject({ examined: 1, created: 1 }));
      await post().expect(200).expect(response => expect(response.body).toMatchObject({ examined: 1, created: 0 }));
    } finally { app.locals.persistenceDatabase?.close(); }
  });

  // O mesmo desenho no provedor remoto, que é onde a varredura custava viagem de
  // rede: a linha da conversa que a mensagem toca nasce ali, e só ela.
  it('creates the remote card for the conversation the message touches, then moves it', async () => {
    const board = { id: 'board-1', stages: [{ id: 'stage-new', key: 'new' }, { id: 'stage-waiting-customer', key: 'waiting_customer' }, { id: 'stage-waiting-operator', key: 'waiting_operator' }] };
    const upserts: Array<Record<string, unknown>> = [];
    let stateTableCalls = 0;
    const answer = (value: unknown) => { const chain: any = { then: (resolve: any) => Promise.resolve(value).then(resolve), maybeSingle: () => Promise.resolve(value) }; for (const method of ['select', 'eq', 'order', 'limit']) chain[method] = () => chain; return chain; };
    const client = { from: (table: string) => {
      if (table === 'conversations') return answer({ data: { status: 'waiting_customer' }, error: null });
      if (table === 'conversation_kanban_state') {
        const existing = upserts.length ? { stage_id: 'stage-waiting-customer', manual_override: false, updated_at: '2026-07-31T00:00:00.000Z', kanban_stages: { key: 'waiting_customer' } } : null;
        stateTableCalls += 1;
        return { ...answer({ data: existing, error: null }), upsert: (rows: Record<string, unknown>[]) => { upserts.push(...rows); return Promise.resolve({ error: null }); } };
      }
      return { insert: () => Promise.resolve({ error: null }) };
    } } as never;
    class Remote extends SupabaseKanbanService {
      public moved = 0;
      protected async ensureBoard() { return board; }
      async move() { this.moved += 1; return {} as any; }
    }
    const service = new Remote(client, new RealtimeHub(), sla);
    expect(await service.automated({ workspaceId, conversationId: '00000000-0000-4000-8000-000000000902', direction: 'inbound', messageId: 'remote-live', visible: true })).toEqual({ status: 'moved' });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ conversation_id: '00000000-0000-4000-8000-000000000902', board_id: 'board-1', stage_id: 'stage-waiting-customer' });
    // Leitura vazia, leitura do topo do estágio, upsert da linha, releitura: o
    // `continue` do laço é o do upsert. A leitura do topo é a que faz o cartão
    // nascer no alto da coluna em vez de em `position = 1`, e ela só acontece
    // aqui — no caminho que já sabe que a linha não existe. Cartão que já tem
    // estado não paga nenhuma delas.
    expect(stateTableCalls).toBe(4);
    expect(service.moved).toBe(1);
  });

  it('still repairs a default board that lost its stages, because that part is cheap', async () => {
    const { database, service } = setup(30); try {
      const [board] = await service.boards(workspaceId);
      database.sqlite.prepare('DELETE FROM kanban_stages WHERE boardId=?').run(board.id);
      const meter = counting(database);
      const [repaired] = await service.boards(workspaceId);
      expect(repaired.stages).toHaveLength(6);
      expect(meter.tally.get('SELECT conversations') ?? 0).toBe(0);
    } finally { database.close(); }
  });
});
