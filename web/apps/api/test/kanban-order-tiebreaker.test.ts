import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { RealtimeHub } from '../src/realtime.js';
import { KanbanService } from '../src/services/kanban.service.js';
import { SupabaseKanbanService } from '../src/services/supabase-kanban.service.js';

/**
 * A ordem dos cartões tem de ser TOTAL.
 *
 * Medido na base de produção em 03/08/2026: 627 cartões na coluna "Novo" ocupam
 * 541 posições distintas — 83 valores repetidos cobrindo 169 cartões, e
 * `position = 1` sozinho é de 5, porque é o que `ensureState` grava em todo
 * cartão novo. A leitura ordenava só por `position` e paginava por `range`, e
 * nem Postgres nem SQLite prometem ordem entre linhas empatadas: o mesmo cartão
 * podia sair em duas páginas, ou em nenhuma, conforme o operador rolava.
 *
 * O desempate é `lastMessageAt` e, por último, `conversationId` — este não
 * significa nada para o operador, está aí só para fechar a ordem quando até a
 * última mensagem empata.
 */
const directories: string[] = [];
const migrations = join(process.cwd(), 'migrations');
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-kanban-ordem-'));
  directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), migrations);
  database.migrate();
  const sla = { status: async () => undefined, reopen: async () => undefined, applyOperationalStatus: async () => undefined } as any;
  return { database, service: new KanbanService(database.sqlite, new RealtimeHub(), sla) };
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function conversation(database: SqlitePersistenceDatabase, workspaceId: string, conversationId: string, lastMessageAt: string) {
  const now = '2026-08-03T00:00:00.000Z';
  database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(conversationId, workspaceId, 'primary', `${conversationId}@c.us`, null, 'open', 'Olá', lastMessageAt, 0, now, now);
}
/** Grava a posição à mão para reproduzir o empate real da produção. */
const empatar = (database: SqlitePersistenceDatabase, conversationId: string, position: number) =>
  database.sqlite.prepare('UPDATE conversation_kanban_state SET position=? WHERE conversationId=?').run(position, conversationId);

describe('SQLite: ordem dos cartões com posições repetidas', () => {
  it('empatados em position saem por atividade, do mais recente para o mais antigo', async () => {
    const { database, service } = setup();
    try {
      // Cinco cartões em `position = 1`, como os cinco que a produção tem hoje.
      const atividade = [
        [id(1), '2026-07-20T13:30:04.493Z'],
        [id(2), '2026-08-01T15:18:48.000Z'],
        [id(3), '2026-08-03T12:21:52.000Z'],
        [id(4), '2026-08-01T13:16:15.000Z'],
        [id(5), '2026-08-02T12:37:44.000Z'],
      ] as const;
      for (const [conversationId, at] of atividade) conversation(database, 'workspace-a', conversationId, at);
      const [board] = await service.boards('workspace-a');
      await service.backfillStates('workspace-a');
      for (const [conversationId] of atividade) empatar(database, conversationId, 1);

      const cards = await service.conversations('workspace-a', board.id, board.stages[0].id, 1, 30, {});

      // Sem desempate, esta ordem é o que o SQLite quiser devolver.
      expect(cards.items.map((card: any) => card.conversationId)).toEqual([id(3), id(5), id(2), id(4), id(1)]);
    } finally { database.close(); }
  });

  it('empate total cai no id, que é o que fecha a ordem', async () => {
    const { database, service } = setup();
    try {
      const mesmo = '2026-07-15T09:00:00.000Z';
      for (const n of [23, 21, 22]) conversation(database, 'workspace-a', id(n), mesmo);
      const [board] = await service.boards('workspace-a');
      await service.backfillStates('workspace-a');
      for (const n of [21, 22, 23]) empatar(database, id(n), 4);

      const cards = await service.conversations('workspace-a', board.id, board.stages[0].id, 1, 30, {});

      expect(cards.items.map((card: any) => card.conversationId)).toEqual([id(21), id(22), id(23)]);
    } finally { database.close(); }
  });

  it('paginando por posições repetidas, nenhum cartão aparece duas vezes nem some', async () => {
    const { database, service } = setup();
    try {
      // 24 cartões, todos em `position = 1`: é o caso que a paginação quebrava.
      const total = 24;
      for (let n = 1; n <= total; n += 1) conversation(database, 'workspace-a', id(100 + n), `2026-07-${String(n).padStart(2, '0')}T10:00:00.000Z`);
      const [board] = await service.boards('workspace-a');
      await service.backfillStates('workspace-a');
      for (let n = 1; n <= total; n += 1) empatar(database, id(100 + n), 1);

      const paginas = [];
      for (let page = 1; page <= 4; page += 1) paginas.push(await service.conversations('workspace-a', board.id, board.stages[0].id, page, 6, {}));
      const vistos = paginas.flatMap((p: any) => p.items.map((card: any) => card.conversationId));

      expect(vistos).toHaveLength(total);
      expect(new Set(vistos).size).toBe(total);
      // E a ordem entre páginas é a mesma que uma leitura única produziria.
      const inteira = await service.conversations('workspace-a', board.id, board.stages[0].id, 1, total, {});
      expect(vistos).toEqual(inteira.items.map((card: any) => card.conversationId));
    } finally { database.close(); }
  });
});

/** O provedor remoto não tem banco no teste: o que dá para prender é a consulta
 *  que ele monta, que é onde o defeito estava. O espião responde por tabela — o
 *  quadro e o estágio precisam existir, senão `conversations()` recusa antes de
 *  chegar à ordenação — e registra a ordem pedida. */
function clienteEspiao() {
  const ordens: Array<{ coluna: string; ascending?: boolean }> = [];
  const respostas: Record<string, unknown> = {
    kanban_boards: { id: 'board-1', kanban_stages: [{ id: 'stage-1', key: 'new', name: 'Novo', position: 1, board_id: 'board-1' }] },
    kanban_stages: { id: 'stage-1', board_id: 'board-1', key: 'new', name: 'Novo', position: 1, kanban_boards: { workspace_id: 'workspace-a' } },
  };
  const from = (tabela: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      gt: () => builder,
      order: (coluna: string, options: { ascending?: boolean } = {}) => { if (tabela === 'conversation_kanban_state') ordens.push({ coluna, ...options }); return builder; },
      range: () => Promise.resolve({ data: [], error: null, count: 0 }),
      maybeSingle: () => Promise.resolve({ data: respostas[tabela] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null, count: 0 }),
    };
    return builder;
  };
  return { ordens, client: { from } as any };
}

describe('Supabase: a consulta pede ordem total', () => {
  it('desempata por atividade e por id, na ordem em que o Postgres precisa receber', async () => {
    const { ordens, client } = clienteEspiao();
    const service = new SupabaseKanbanService(client, new RealtimeHub(), {} as any);

    await service.conversations('workspace-a', 'board-1', 'stage-1', 1, 30, {} as any);

    // `conversations(last_message_at)` é a forma que o PostgREST aceita para
    // ordenar a linha de fora por coluna da tabela embutida — conferida contra a
    // instância real em 03/08/2026, onde os cinco cartões empatados em
    // `position = 1` passaram a sair do mais recente para o mais antigo.
    expect(ordens.map((o) => o.coluna)).toEqual(['position', 'conversations(last_message_at)', 'conversation_id']);
    expect(ordens[0]).toMatchObject({ ascending: false });
    expect(ordens[1]).toMatchObject({ ascending: false });
    expect(ordens[2]).toMatchObject({ ascending: true });
  });
});
