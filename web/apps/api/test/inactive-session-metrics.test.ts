import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { createSqliteDomainRepository } from '../src/persistence/sqlite-domain.repository.js';
import { SupabaseDomainRepository } from '../src/persistence/supabase-domain.repository.js';
import { RealtimeHub } from '../src/realtime.js';
import { activeSessionNames } from '../src/services/dashboard-sessions.js';
import { KanbanService } from '../src/services/kanban.service.js';
import { SupabaseKanbanService } from '../src/services/supabase-kanban.service.js';

/**
 * Conversa presa a uma sessão WhatsApp que a WAHA não conhece mais não é
 * atendimento ativo, e não pode entrar em contador de painel. Ver
 * web/docs/conversas-sessao-inativa.md.
 *
 * SQLite e Supabase precisam responder o mesmo número. O contador de etapa do
 * Kanban divergia antes disto: o SQLite juntava `conversations` e filtrava
 * `visible`, o Supabase contava `conversation_kanban_state` sozinha.
 */
const directories: string[] = [];
const migrations = join(process.cwd(), 'migrations');
const workspaceId = 'workspace-a';
const live = 'chatpro-viva';
const dead = 'chatpro-morta';
const listed: Array<{ status: string; wahaName: string; aliases?: string[] }> = [{ status: 'connected', wahaName: live }];
const activity = (sessions = listed) => ({ activeSessions: async () => activeSessionNames(sessions) });

const sqlite = () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-inactive-metrics-'));
  directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), migrations);
  database.migrate();
  return database;
};
const conversation = (database: SqlitePersistenceDatabase, id: string, wahaSession: string) => {
  const now = '2026-07-21T15:00:00.000Z';
  database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,conversationType,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, workspaceId, wahaSession, `${id}@c.us`, null, 'direct', 'open', 'Olá', now, 0, now, now);
};
const sla = { status: async () => undefined, reopen: async () => undefined, applyOperationalStatus: async () => undefined } as never;
const stageCount = (board: { stages: Array<{ key: string; count: number }> }, key: string) => board.stages.find(stage => stage.key === key)!.count;

afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('Kanban — SQLite', () => {
  // Desde a #92 quem varre conversa é `backfillStates()`, sob comando, e não
  // mais toda leitura do quadro — então é lá que o filtro de sessão tem de
  // estar. Sem ele, o reparo repovoaria o quadro de card de sessão morta,
  // exatamente o que ele existe para limpar.
  it('o reparo não cria card para conversa de sessão que não existe mais', async () => {
    const database = sqlite();
    try {
      conversation(database, '00000000-0000-4000-8000-000000000001', live);
      conversation(database, '00000000-0000-4000-8000-000000000002', dead);
      const service = new KanbanService(database.sqlite, new RealtimeHub(), sla, undefined, activity());
      const reparo = await service.backfillStates(workspaceId);
      expect(reparo).toMatchObject({ examined: 1, created: 1 });
      const [board] = await service.boards(workspaceId);
      expect(database.sqlite.prepare('SELECT count(*) total FROM conversation_kanban_state WHERE workspaceId=? AND boardId=?').get(workspaceId, board.id)).toMatchObject({ total: 1 });
      expect(stageCount(board, 'new')).toBe(1);
    } finally { database.close(); }
  });

  // Os cards já gravados são dado existente e não são apagados por código; só
  // deixam de ser contados. Ver o SQL proposto em web/docs.
  it('deixa de contar card já gravado de sessão que não existe mais', async () => {
    const database = sqlite();
    try {
      conversation(database, '00000000-0000-4000-8000-000000000003', live);
      conversation(database, '00000000-0000-4000-8000-000000000004', dead);
      const service = new KanbanService(database.sqlite, new RealtimeHub(), sla);
      await service.backfillStates(workspaceId);
      const [before] = await service.boards(workspaceId);
      expect(stageCount(before, 'new')).toBe(2);
      const [after] = await new KanbanService(database.sqlite, new RealtimeHub(), sla, undefined, activity()).boards(workspaceId);
      expect(stageCount(after, 'new')).toBe(1);
      expect(database.sqlite.prepare('SELECT count(*) total FROM conversation_kanban_state WHERE workspaceId=?').get(workspaceId)).toMatchObject({ total: 2 });
    } finally { database.close(); }
  });

  // O worker roteia o nome do pareamento anterior para a sessão no ar. A
  // conversa gravada com esse nome continua alcançável, então tem de continuar
  // contando no quadro — 499 das 504 conversas ditas inativas em 31/07 eram
  // exatamente este caso.
  it('conta a conversa cuja sessão é alias da viva', async () => {
    const database = sqlite();
    try {
      conversation(database, '00000000-0000-4000-8000-000000000007', live);
      conversation(database, '00000000-0000-4000-8000-000000000008', dead);
      const comAlias = activity([{ status: 'connected', wahaName: live, aliases: [dead] }]);
      const service = new KanbanService(database.sqlite, new RealtimeHub(), sla, undefined, comAlias);
      const reparo = await service.backfillStates(workspaceId);
      expect(reparo).toMatchObject({ examined: 2, created: 2 });
      const [board] = await service.boards(workspaceId);
      expect(stageCount(board, 'new')).toBe(2);
    } finally { database.close(); }
  });

  it('conta tudo quando não dá para saber quais sessões existem', async () => {
    const database = sqlite();
    try {
      conversation(database, '00000000-0000-4000-8000-000000000005', live);
      conversation(database, '00000000-0000-4000-8000-000000000006', dead);
      const service = new KanbanService(database.sqlite, new RealtimeHub(), sla, undefined, { activeSessions: async () => undefined });
      await service.backfillStates(workspaceId);
      const [board] = await service.boards(workspaceId);
      expect(stageCount(board, 'new')).toBe(2);
    } finally { database.close(); }
  });
});

// O Supabase não roda aqui; o que dá para prender é a consulta que ele monta.
const supabaseKanban = (active?: typeof listed) => {
  const queries: Array<{ table: string; select: string; filters: string[] }> = [];
  const board = { id: 'board-1', workspace_id: workspaceId, name: 'Operação', is_default: true, created_at: '2026-07-21T15:00:00.000Z', updated_at: '2026-07-21T15:00:00.000Z', kanban_stages: [{ id: 'stage-new', board_id: 'board-1', key: 'new', name: 'Novo', position: 1, is_terminal: false, is_archived_stage: false, created_at: '2026-07-21T15:00:00.000Z', updated_at: '2026-07-21T15:00:00.000Z' }] };
  const client = {
    from(table: string) {
      const entry = { table, select: '', filters: [] as string[] };
      queries.push(entry);
      const builder: Record<string, unknown> = {
        select: (columns = '') => { entry.select = String(columns); return builder; },
        eq: (column: string, value: unknown) => { entry.filters.push(`${column}=${String(value)}`); return builder; },
        in: (column: string, values: unknown[]) => { entry.filters.push(`${column} in (${values.join(',')})`); return builder; },
        order: () => builder,
        // `ensureBoard` completa as etapas padrão que faltam no quadro falso, e
        // o reparo faz upsert das linhas de estado: sem estes dois o duplo não
        // chega até a varredura de conversas, que é o que se quer observar.
        insert: () => builder,
        upsert: () => builder,
        maybeSingle: async () => ({ data: table === 'kanban_boards' ? board : null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: [], count: 0, error: null })),
      };
      return builder;
    },
  };
  return { queries, service: new SupabaseKanbanService(client as never, new RealtimeHub(), sla, undefined, active ? { activeSessions: async () => activeSessionNames(active) } : undefined) };
};

describe('Kanban — Supabase', () => {
  it('junta conversations no contador da etapa e filtra pela sessão, como o SQLite', async () => {
    const { queries, service } = supabaseKanban(listed);
    await service.detail(workspaceId, 'board-1');
    const count = queries.find(query => query.table === 'conversation_kanban_state')!;
    expect(count.select).toContain('conversations!inner');
    expect(count.filters).toContain('conversations.visibility_state=visible');
    expect(count.filters).toContain(`conversations.waha_session in (${live})`);
  });

  // O reparo é o único caminho que ainda varre conversa, nos dois provedores.
  // Sem este teste o filtro do lado Supabase podia cair sozinho: o do SQLite tem
  // teste próprio, e a paridade entre os dois não se prova por um só.
  it('o reparo restringe às sessões vivas as conversas que ganham card', async () => {
    const { queries, service } = supabaseKanban(listed);
    await service.backfillStates(workspaceId);
    const varredura = queries.find(query => query.table === 'conversations')!;
    expect(varredura.filters).toContain('visibility_state=visible');
    expect(varredura.filters).toContain(`waha_session in (${live})`);
  });

  it('o reparo larga o filtro quando não dá para saber quais sessões existem', async () => {
    const { queries, service } = supabaseKanban();
    await service.backfillStates(workspaceId);
    const varredura = queries.find(query => query.table === 'conversations')!;
    expect(varredura.filters).toContain('visibility_state=visible');
    expect(varredura.filters.some(filter => filter.startsWith('waha_session'))).toBe(false);
  });

  it('mantém a junção e larga o filtro de sessão quando o conjunto é desconhecido', async () => {
    const { queries, service } = supabaseKanban();
    await service.detail(workspaceId, 'board-1');
    const count = queries.find(query => query.table === 'conversation_kanban_state')!;
    expect(count.select).toContain('conversations!inner');
    expect(count.filters).toContain('conversations.visibility_state=visible');
    expect(count.filters.some(filter => filter.startsWith('conversations.waha_session'))).toBe(false);
  });
});

describe('KPI de conversas do painel', () => {
  it('resolve o conjunto de sessões vivas e falha aberto sem wahaName', () => {
    expect([...activeSessionNames([{ status: 'connected', wahaName: live }])!]).toEqual([live]);
    expect(activeSessionNames([])).toBeUndefined();
    expect(activeSessionNames([{ status: 'connected' }])).toBeUndefined();
    expect(activeSessionNames(undefined)).toBeUndefined();
  });

  it('SQLite: conta só a conversa de sessão que ainda existe', async () => {
    const database = sqlite();
    try {
      conversation(database, '00000000-0000-4000-8000-000000000007', live);
      conversation(database, '00000000-0000-4000-8000-000000000008', dead);
      conversation(database, '00000000-0000-4000-8000-000000000009', dead);
      const repository = createSqliteDomainRepository(database.sqlite);
      expect(await repository.dashboard(workspaceId, listed)).toMatchObject({ conversations: 1 });
      expect(await repository.dashboard(workspaceId, [])).toMatchObject({ conversations: 3 });
    } finally { database.close(); }
  });

  it('Supabase: aplica o mesmo filtro de sessão na contagem de conversations', async () => {
    const queries: Array<{ table: string; filters: string[] }> = [];
    const client = {
      rpc: async () => ({ data: null, error: null }),
      from(table: string) {
        const entry = { table, filters: [] as string[] };
        queries.push(entry);
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (column: string, value: unknown) => { entry.filters.push(`${column}=${String(value)}`); return builder; },
          in: (column: string, values: unknown[]) => { entry.filters.push(`${column} in (${values.join(',')})`); return builder; },
          is: () => builder, or: () => builder,
          order: () => ({ ...builder, then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null })), range: async () => ({ data: [], count: 0, error: null }) }),
          maybeSingle: async () => ({ data: null, error: null }),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: null, count: 0, error: null })),
        };
        return builder;
      },
    };
    await new SupabaseDomainRepository(client as never).dashboard(workspaceId, listed);
    const count = queries.find(query => query.table === 'conversations')!;
    expect(count.filters).toContain('visibility_state=visible');
    expect(count.filters).toContain(`waha_session in (${live})`);
    expect(queries.find(query => query.table === 'whatsapp_messages')!.filters.some(filter => filter.startsWith('waha_session'))).toBe(false);
  });
});
