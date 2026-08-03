import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { RealtimeHub } from '../src/realtime.js';
import { KanbanService } from '../src/services/kanban.service.js';
import { SupabaseKanbanService } from '../src/services/supabase-kanban.service.js';

/**
 * Onde nasce o cartão de uma conversa nova.
 *
 * A leitura ordena `position DESC`, então `1` é o FIM da fila. O provedor remoto
 * gravava `position: 1` em todo cartão novo, e medido na produção em 03/08/2026
 * o efeito era esse: os cartões em `position = 1` eram os de 01/08, 02/08 e
 * 03/08 — as conversas mais recentes da base no rodapé de uma coluna de 627.
 *
 * O SQLite já fazia `MAX(position) + 1`, mas do QUADRO. Os dois passam a usar o
 * máximo do ESTÁGIO, que é o único escopo em que `position` é comparado.
 *
 * Regra 3 do CLAUDE.md: isto é o ciclo de persistência da ingestão, então os
 * testes abaixo prendem o que não pode mudar junto — idempotência, a linha que
 * já existe não ser tocada, e o cartão continuar caindo no estágio do status.
 */
const directories: string[] = [];
const migrations = join(process.cwd(), 'migrations');
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-kanban-topo-'));
  directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), migrations);
  database.migrate();
  const sla = { status: async () => undefined, reopen: async () => undefined, applyOperationalStatus: async () => undefined } as any;
  return { database, service: new KanbanService(database.sqlite, new RealtimeHub(), sla) };
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function conversation(database: SqlitePersistenceDatabase, conversationId: string, status = 'open', lastMessageAt = '2026-08-03T10:00:00.000Z') {
  database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(conversationId, 'workspace-a', 'primary', `${conversationId}@c.us`, null, status, 'Olá', lastMessageAt, 0, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z');
}
/** A ingestão é quem chama `ensureState`: uma mensagem na conversa cria o cartão.
 *  `automated` é a porta real desse caminho, e as flags de origem são as que
 *  deixam a mensagem elegível — histórico e importado nunca criam cartão. */
const ingerir = (service: KanbanService, conversationId: string) =>
  service.automated({ workspaceId: 'workspace-a', conversationId, messageId: `msg-${conversationId}`, direction: 'inbound', visible: true });
const estado = (database: SqlitePersistenceDatabase, conversationId: string) =>
  database.sqlite.prepare('SELECT stageId,position FROM conversation_kanban_state WHERE conversationId=?').get(conversationId) as { stageId: string; position: number } | undefined;

describe('SQLite: cartão novo nasce no topo do seu estágio', () => {
  it('cada conversa nova recebe uma posição acima da anterior, e não 1', async () => {
    const { database, service } = setup();
    try {
      await service.boards('workspace-a');
      for (const n of [1, 2, 3]) { conversation(database, id(n)); await ingerir(service, id(n)); }

      const posicoes = [1, 2, 3].map((n) => estado(database, id(n))!.position);

      expect(posicoes).toEqual([1, 2, 3]);
      // O que o operador vê: a mais recente no alto da coluna.
      const [board] = await service.boards('workspace-a');
      const cards = await service.conversations('workspace-a', board.id, board.stages[0].id, 1, 30, {});
      expect(cards.items.map((card: any) => card.conversationId)).toEqual([id(3), id(2), id(1)]);
    } finally { database.close(); }
  });

  it('o topo é do estágio, não do quadro: uma coluna não empurra a numeração da outra', async () => {
    const { database, service } = setup();
    try {
      const [board] = await service.boards('workspace-a');
      const novo = board.stages.find((stage: any) => stage.key === 'new')!;
      const andamento = board.stages.find((stage: any) => stage.key === 'in_progress')!;
      for (const n of [11, 12]) { conversation(database, id(n)); await ingerir(service, id(n)); }
      // Um cartão movido à mão para outra coluna leva a numeração do quadro para
      // cima; a coluna "Novo" continua onde estava.
      await service.move('workspace-a', id(999), id(12), { boardId: board.id, stageId: andamento.id, source: 'manual' });
      // A outra coluna numerada bem acima — é o retrato da produção, onde o
      // backfill espalhou posições até 626 entre os estágios.
      database.sqlite.prepare('UPDATE conversation_kanban_state SET position=500 WHERE conversationId=?').run(id(12));

      const maiorDoQuadro = Number((database.sqlite.prepare('SELECT MAX(position) m FROM conversation_kanban_state WHERE boardId=?').get(board.id) as any).m);
      const maiorDeNovo = Number((database.sqlite.prepare('SELECT MAX(position) m FROM conversation_kanban_state WHERE boardId=? AND stageId=?').get(board.id, novo.id) as any).m);
      // Sem esta diferença o teste não distinguiria os dois escopos.
      expect(maiorDoQuadro).toBeGreaterThan(maiorDeNovo);

      conversation(database, id(13));
      await ingerir(service, id(13));

      expect(estado(database, id(13))).toMatchObject({ stageId: novo.id, position: maiorDeNovo + 1 });
    } finally { database.close(); }
  });

  it('idempotente: a segunda mensagem não cria linha nem mexe na posição', async () => {
    const { database, service } = setup();
    try {
      await service.boards('workspace-a');
      conversation(database, id(21)); await ingerir(service, id(21));
      conversation(database, id(22)); await ingerir(service, id(22));
      const antes = estado(database, id(21))!;

      await ingerir(service, id(21));
      await ingerir(service, id(21));

      expect(estado(database, id(21))).toEqual(antes);
      expect(database.sqlite.prepare('SELECT count(*) total FROM conversation_kanban_state').get()).toMatchObject({ total: 2 });
    } finally { database.close(); }
  });

  it('conversa invisível continua sem cartão', async () => {
    const { database, service } = setup();
    try {
      await service.boards('workspace-a');
      conversation(database, id(31));
      database.sqlite.prepare("UPDATE conversations SET visibilityState='quarantined' WHERE id=?").run(id(31));

      await ingerir(service, id(31));

      expect(estado(database, id(31))).toBeUndefined();
    } finally { database.close(); }
  });
});

/** O provedor remoto não tem banco aqui: o espião responde por tabela e registra
 *  a FORMA da consulta — filtros, ordem e limite —, porque é a forma que decide de
 *  onde vem o topo. Um espião que só devolvesse um número não distinguiria ler o
 *  topo do estágio de ler o do quadro. */
function clienteEspiao(topo?: number) {
  const upserts: Array<{ linhas: Array<Record<string, unknown>>; options: unknown }> = [];
  const consultas: Array<{ tabela: string; filtros: Record<string, unknown>; ordem?: { coluna: string; ascending?: boolean }; limite?: number }> = [];
  const from = (tabela: string) => {
    const registro: { tabela: string; filtros: Record<string, unknown>; ordem?: { coluna: string; ascending?: boolean }; limite?: number } = { tabela, filtros: {} };
    consultas.push(registro);
    const builder: any = {
      select: () => builder,
      eq: (coluna: string, valor: unknown) => { registro.filtros[coluna] = valor; return builder; },
      in: () => builder, gt: () => builder,
      order: (coluna: string, options: { ascending?: boolean } = {}) => { registro.ordem = { coluna, ...options }; return builder; },
      limit: (valor: number) => { registro.limite = valor; return builder; },
      maybeSingle: () => Promise.resolve({
        data: tabela === 'conversations' ? { status: 'open' }
          : tabela === 'conversation_kanban_state' ? (topo === undefined ? null : { position: topo })
          : null,
        error: null,
      }),
      upsert: (linhas: Array<Record<string, unknown>>, options: unknown) => { upserts.push({ linhas, options }); return Promise.resolve({ error: null }); },
      insert: () => Promise.resolve({ error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
    };
    return builder;
  };
  const gravado = () => upserts[0]?.linhas[0];
  const leituraDoTopo = () => consultas.find((c) => c.tabela === 'conversation_kanban_state' && c.ordem);
  return { upserts, consultas, gravado, leituraDoTopo, client: { from } as any };
}
const board = { id: 'board-1', stages: [{ id: 'stage-new', key: 'new' }, { id: 'stage-progress', key: 'in_progress' }] };

describe('Supabase: cartão novo nasce no topo do seu estágio', () => {
  it('grava o máximo do estágio mais um, e não o 1 fixo que punha a conversa no rodapé', async () => {
    const espiao = clienteEspiao(626);
    const service = new SupabaseKanbanService(espiao.client, new RealtimeHub(), {} as any);

    await (service as any).ensureState('workspace-a', 'conversa-1', board);

    expect(espiao.upserts).toHaveLength(1);
    expect(espiao.gravado()).toMatchObject({ stage_id: 'stage-new', position: 627, manual_override: false, last_transition_source: 'system' });
  });

  it('o topo lido é o do ESTÁGIO, pelo maior position, e uma linha só', async () => {
    const espiao = clienteEspiao(626);
    const service = new SupabaseKanbanService(espiao.client, new RealtimeHub(), {} as any);

    await (service as any).ensureState('workspace-a', 'conversa-1', board);

    const leitura = espiao.leituraDoTopo()!;
    // Sem o filtro de estágio, uma coluna cheia empurraria a numeração das outras.
    expect(leitura.filtros).toMatchObject({ workspace_id: 'workspace-a', board_id: 'board-1', stage_id: 'stage-new' });
    // Descendente e limitada a 1: o PostgREST não expõe `max()`, e ler a coluna
    // inteira para tirar o maior seria O(cartões) no caminho de ingestão.
    expect(leitura.ordem).toMatchObject({ coluna: 'position', ascending: false });
    expect(leitura.limite).toBe(1);
  });

  it('estágio vazio começa em 1', async () => {
    const espiao = clienteEspiao(undefined);
    const service = new SupabaseKanbanService(espiao.client, new RealtimeHub(), {} as any);

    await (service as any).ensureState('workspace-a', 'conversa-1', board);

    expect(espiao.gravado()).toMatchObject({ position: 1 });
  });

  it('a leitura do topo acontece uma vez, no caminho que já sabe que a linha falta', async () => {
    const espiao = clienteEspiao(4);
    const service = new SupabaseKanbanService(espiao.client, new RealtimeHub(), {} as any);

    await (service as any).ensureState('workspace-a', 'conversa-1', board);

    // Uma leitura do status, uma do topo, uma escrita. O chamador só chega aqui
    // quando a linha não existe, então cartão já criado não paga nada disto.
    expect(espiao.consultas.map((c) => c.tabela)).toEqual(['conversations', 'conversation_kanban_state', 'conversation_kanban_state']);
  });

  it('a escrita continua idempotente: conflito por conversa e quadro, ignorando duplicata', async () => {
    const espiao = clienteEspiao(9);
    const service = new SupabaseKanbanService(espiao.client, new RealtimeHub(), {} as any);

    await (service as any).ensureState('workspace-a', 'conversa-1', board);

    // Sem isto, uma segunda mensagem na mesma conversa reescreveria a posição —
    // e o cartão pularia para o topo a cada mensagem.
    expect(espiao.upserts[0].options).toMatchObject({ onConflict: 'conversation_id,board_id', ignoreDuplicates: true });
  });

  it('conversa invisível não vira cartão', async () => {
    const from = () => {
      const builder: any = { select: () => builder, eq: () => builder, order: () => builder, limit: () => builder, maybeSingle: () => Promise.resolve({ data: null, error: null }), upsert: () => { throw new Error('não deveria gravar'); } };
      return builder;
    };
    const service = new SupabaseKanbanService({ from } as any, new RealtimeHub(), {} as any);

    await expect((service as any).ensureState('workspace-a', 'conversa-1', board)).resolves.toBe(false);
  });
});
