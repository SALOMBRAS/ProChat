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

const usuario = '00000000-0000-4000-8000-000000000001';
const diretorios: string[] = [];
// No Windows o handle do SQLite segura o arquivo: fechar antes do rmSync.
const bancos: Array<{ close(): void }> = [];
afterEach(() => { bancos.splice(0).forEach(banco => banco.close()); diretorios.splice(0).forEach(caminho => rmSync(caminho, { recursive: true, force: true })); });
const temporario = (prefixo: string) => { const caminho = mkdtempSync(join(tmpdir(), prefixo)); diretorios.push(caminho); return caminho; };

function local() {
  const database = new SqlitePersistenceDatabase(join(temporario('chatpro-arrastar-'), 'db.sqlite'), join(process.cwd(), 'migrations'));
  database.migrate(); bancos.push(database);
  const sla = { status: async () => undefined, reopen: async () => undefined, applyOperationalStatus: async () => undefined } as any;
  return { database, service: new KanbanService(database.sqlite, new RealtimeHub(), sla) };
}
function conversa(database: SqlitePersistenceDatabase, workspaceId: string, id: string) {
  const agora = new Date().toISOString();
  database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, workspaceId, 'primary', `${id}@c.us`, null, 'open', 'Olá', agora, 0, agora, agora);
}
/** Põe o cartão num estado com versão conhecida e a última transição de quem se
 *  quer testar — é o que o operador teria na tela quando alguém mexeu por baixo. */
function estado(database: SqlitePersistenceDatabase, workspaceId: string, conversationId: string, boardId: string, stageId: string, fonte: string, updatedAt: string) {
  const agora = new Date().toISOString();
  database.sqlite.prepare('INSERT INTO conversation_kanban_state (workspaceId,conversationId,boardId,stageId,position,manualOverride,lastTransitionSource,lastTransitionBy,lastTransitionAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId, conversationId, boardId, stageId, 1, 0, fonte, null, agora, agora, updatedAt);
}

describe('arrastar cartão: o que a API aceita e quem ganha o conflito', () => {
  /** O defeito de verdade. `z.string().datetime()` sem argumento recusa
   *  deslocamento de fuso, e o PostgREST devolve `+00:00` em todo `updated_at`.
   *  O SQLite guarda `toISOString()`, que termina em `Z`: por isso a suíte
   *  passava e o quadro real recusava toda movimentação com 400. */
  it('aceita a versão do cartão no formato que o PostgREST devolve', async () => {
    const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20, databaseProvider: 'sqlite', databasePath: join(temporario('chatpro-arrastar-http-'), 'api.sqlite'), developmentUserId: usuario });
    const workspaceId = 'workspace-a';
    const database = app.locals.persistenceDatabase as SqlitePersistenceDatabase;
    bancos.push(database);
    const [quadro] = (await request(app).get('/api/v1/inbox/kanban/boards').set('x-workspace-id', workspaceId).set('x-user-id', usuario).expect(200)).body;
    const destino = quadro.stages.find((etapa: any) => etapa.key === 'in_progress');

    // Uma conversa por formato: a segunda chamada sobre a mesma conversa
    // disputaria com a primeira, e o que se mede aqui é a validação de entrada,
    // não o conflito.
    let seq = 0;
    const mover = (expectedUpdatedAt: string) => { const conversationId = `00000000-0000-4000-8000-0000000000a${++seq}`; conversa(database, workspaceId, conversationId); return request(app).post(`/api/v1/inbox/kanban/conversations/${conversationId}/move`).set('x-workspace-id', workspaceId).set('x-user-id', usuario).send({ boardId: quadro.id, stageId: destino.id, source: 'manual', expectedUpdatedAt }); };

    await mover('2026-07-31T19:26:47.171+00:00').expect(200);
    await mover('2026-07-31T19:26:47.171238+00:00').expect(200); // microssegundos: é o que a RPC grava com `now()`
    // O `Z` continua valendo: é o que o SQLite guarda, e quebrá-lo trocaria um
    // provedor pelo outro em vez de atender aos dois.
    await mover('2026-07-31T19:26:47.171Z').expect(200);
    // E o campo continua sendo uma data — afrouxar não é aceitar qualquer coisa.
    await mover('ontem').expect(400).expect(resposta => expect(resposta.body.error.details.fieldErrors.expectedUpdatedAt).toBeTruthy());
  });

  it('SQLite: a movimentação manual passa por cima da automação, mesmo com a versão velha', async () => {
    const { database, service } = local();
    try {
      const workspaceId = 'workspace-a', conversationId = '00000000-0000-4000-8000-0000000000b1';
      conversa(database, workspaceId, conversationId);
      const [quadro] = await service.boards(workspaceId);
      const origem = quadro.stages.find(etapa => etapa.key === 'new')!, destino = quadro.stages.find(etapa => etapa.key === 'resolved')!;
      estado(database, workspaceId, conversationId, quadro.id, origem.id, 'inbound', '2026-08-01T00:00:00.000Z');

      await service.move(workspaceId, usuario, conversationId, { boardId: quadro.id, stageId: destino.id, source: 'manual', expectedUpdatedAt: '2026-07-31T00:00:00.000Z' });
      expect(database.sqlite.prepare('SELECT stageId,lastTransitionSource,manualOverride FROM conversation_kanban_state WHERE conversationId=?').get(conversationId)).toMatchObject({ stageId: destino.id, lastTransitionSource: 'manual', manualOverride: 1 });
    } finally { database.close(); }
  });

  it('SQLite: perder para outro atendente continua barrando, e o 409 diz para onde o cartão foi', async () => {
    const { database, service } = local();
    try {
      const workspaceId = 'workspace-a', conversationId = '00000000-0000-4000-8000-0000000000c1';
      conversa(database, workspaceId, conversationId);
      const [quadro] = await service.boards(workspaceId);
      const atual = quadro.stages.find(etapa => etapa.key === 'waiting_customer')!, destino = quadro.stages.find(etapa => etapa.key === 'resolved')!;
      estado(database, workspaceId, conversationId, quadro.id, atual.id, 'manual', '2026-08-01T00:00:00.000Z');

      await expect(service.move(workspaceId, usuario, conversationId, { boardId: quadro.id, stageId: destino.id, source: 'manual', expectedUpdatedAt: '2026-07-31T00:00:00.000Z' }))
        .rejects.toMatchObject({ status: 409, details: { reason: 'moved_by_operator', stageId: atual.id, stageName: atual.name } });
      expect(database.sqlite.prepare('SELECT stageId FROM conversation_kanban_state WHERE conversationId=?').get(conversationId)).toMatchObject({ stageId: atual.id });
    } finally { database.close(); }
  });

  /** O mesmo veredito do outro lado. No Supabase o conflito nasce dentro da RPC,
   *  como `40001`, então a decisão só pode ser tomada depois — relendo quem
   *  ganhou. O duplo devolve o 40001 na primeira chamada e registra a segunda. */
  const remoto = (ultimaFonte: string) => {
    const chamadas: Array<Record<string, unknown>> = [];
    const linha = { stage_id: 'etapa-atual', updated_at: '2026-08-01T00:00:00.000+00:00', last_transition_source: ultimaFonte, kanban_stages: { name: 'Aguardando cliente' } };
    const client = {
      rpc: async (_nome: string, argumentos: Record<string, unknown>) => { chamadas.push(argumentos); return chamadas.length === 1 ? { data: null, error: { code: '40001', message: 'kanban conflict' } } : { data: [{ updated_at: '2026-08-02T00:00:00.000+00:00', from_stage_id: 'etapa-atual', to_stage_id: argumentos.p_stage_id }], error: null }; },
      from: (tabela: string) => {
        const alvo: Record<string, unknown> = {
          select: () => alvo, eq: () => alvo, order: () => alvo, limit: () => alvo,
          maybeSingle: async () => tabela === 'kanban_stages'
            ? { data: { id: 'etapa-destino', board_id: 'quadro-1', key: 'resolved', name: 'Resolvido', position: 5, kanban_boards: { workspace_id: 'workspace-a' } }, error: null }
            : { data: linha, error: null },
          then: (resolver: (valor: unknown) => unknown) => resolver({ data: [], error: null }),
        };
        return alvo;
      },
    } as never;
    const sla = { applyOperationalStatus: async () => undefined, config: async () => ({}) } as never;
    return { chamadas, service: new SupabaseKanbanService(client, new RealtimeHub(), sla) };
  };

  it('Supabase: releitura mostra automação, e a movimentação manual repete com a versão fresca', async () => {
    const { chamadas, service } = remoto('inbound');
    await service.move('workspace-a', usuario, 'conversa-1', { boardId: 'quadro-1', stageId: 'etapa-destino', source: 'manual', expectedUpdatedAt: '2026-07-31T00:00:00.000+00:00' });
    expect(chamadas).toHaveLength(2);
    expect(chamadas[0].p_expected_updated_at).toBe('2026-07-31T00:00:00.000+00:00');
    // A segunda tentativa leva a versão relida, não a que já perdeu: repetir a
    // mesma perderia de novo, com certeza e não com probabilidade.
    expect(chamadas[1].p_expected_updated_at).toBe('2026-08-01T00:00:00.000+00:00');
  });

  it('Supabase: releitura mostra outro atendente, e a movimentação para com o nome da etapa', async () => {
    const { chamadas, service } = remoto('manual');
    await expect(service.move('workspace-a', usuario, 'conversa-1', { boardId: 'quadro-1', stageId: 'etapa-destino', source: 'manual', expectedUpdatedAt: '2026-07-31T00:00:00.000+00:00' }))
      .rejects.toMatchObject({ status: 409, details: { reason: 'moved_by_operator', stageName: 'Aguardando cliente' } });
    expect(chamadas).toHaveLength(1);
  });

  it('Supabase: a automação não herda o passe-livre do operador', async () => {
    const { chamadas, service } = remoto('manual');
    await expect(service.move('workspace-a', usuario, 'conversa-1', { boardId: 'quadro-1', stageId: 'etapa-destino', source: 'inbound', expectedUpdatedAt: '2026-07-31T00:00:00.000+00:00' })).rejects.toMatchObject({ status: 409 });
    expect(chamadas).toHaveLength(1);
  });
});
