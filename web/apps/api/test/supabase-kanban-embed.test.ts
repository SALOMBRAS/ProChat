import { describe, expect, it } from 'vitest';
import { RealtimeHub } from '../src/realtime.js';
import { SupabaseKanbanService } from '../src/services/supabase-kanban.service.js';

/** O PostgREST só embeda tabela ligada por chave estrangeira **declarada**, e a
 *  recusa é em tempo de consulta, com 400 e `PGRST200`. Este duplo aplica a
 *  mesma regra: sem isso o teste passaria com qualquer select, que é exatamente
 *  o que acontece contra SQLite — lá o JOIN é livre, o quadro carrega, e o
 *  defeito só aparece em produção.
 *
 *  O grafo abaixo é o do banco remoto, conferido em 03/08/2026: as três tabelas
 *  de conversa apontam para `conversations`, e **nenhuma** aponta para
 *  `conversation_kanban_state`. */
const relacionamentos: ReadonlyArray<readonly [string, string]> = [
  ['conversation_kanban_state', 'conversations'],
  ['conversation_kanban_state', 'kanban_boards'],
  ['conversation_kanban_state', 'kanban_stages'],
  ['conversation_metadata', 'conversations'],
  ['conversation_sla_metrics', 'conversations'],
  ['kanban_stages', 'kanban_boards'],
];
const relacionadas = (a: string, b: string) => relacionamentos.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/** Divide um select em campos de primeiro nível, respeitando parênteses. */
function camposDe(select: string): string[] {
  const campos: string[] = [];
  let profundidade = 0, atual = '';
  for (const c of select) {
    if (c === '(') profundidade++;
    if (c === ')') profundidade--;
    if (c === ',' && profundidade === 0) { campos.push(atual); atual = ''; continue; }
    atual += c;
  }
  if (atual) campos.push(atual);
  return campos;
}

/** Devolve o nome da primeira tabela embedada inválida, ou undefined. */
function embedInvalido(pai: string, select: string): string | undefined {
  for (const campo of camposDe(select)) {
    const abre = campo.indexOf('(');
    if (abre < 0) continue;
    const alvo = campo.slice(0, abre).replace('!inner', '').trim();
    if (!relacionadas(pai, alvo)) return alvo;
    const aninhado = embedInvalido(alvo, campo.slice(abre + 1, campo.lastIndexOf(')')));
    if (aninhado) return aninhado;
  }
  return undefined;
}

const conversa = {
  id: '00000000-0000-4000-8000-000000000001', workspace_id: 'workspace-a', visibility_state: 'visible',
  chat_id: '5511999990000@c.us', last_message: 'oi', last_message_at: '2026-08-03T10:00:00.000Z',
  unread_count: 2, conversation_type: 'direct', assigned_user_id: null, assigned_team_id: null,
  routing_queue_id: null, priority: 'normal',
  conversation_metadata: { tags: ['vip'] },
  conversation_sla_metrics: { sla_status: 'waiting_operator', waiting_since_at: '2026-08-03T09:00:00.000Z', first_response_at: null, frozen_at: null },
};
const cartao = { conversation_id: conversa.id, stage_id: 'stage-new', position: 1, updated_at: '2026-08-03T10:00:00.000Z', conversations: conversa };
const etapa = { id: 'stage-new', board_id: 'board-1', key: 'new', name: 'Novo', position: 1, is_terminal: false, is_archived_stage: false, created_at: 'x', updated_at: 'x', kanban_boards: { workspace_id: 'workspace-a' } };
const quadro = { id: 'board-1', workspace_id: 'workspace-a', name: 'Operação', is_default: true, created_at: 'x', updated_at: 'x', kanban_stages: [etapa] };

function cliente() {
  const selects: Array<{ tabela: string; select: string }> = [];
  const from = (tabela: string) => {
    const estado = { select: '' };
    const resposta = () => {
      const invalido = embedInvalido(tabela, estado.select);
      if (invalido) return { data: null, count: null, error: { code: 'PGRST200', message: `Could not find a relationship between '${tabela}' and '${invalido}' in the schema cache` } };
      if (tabela === 'conversation_kanban_state') return { data: [cartao], count: 1, error: null };
      if (tabela === 'kanban_stages') return { data: etapa, count: 1, error: null };
      if (tabela === 'kanban_boards') return { data: quadro, count: 1, error: null };
      return { data: [], count: 0, error: null };
    };
    const alvo: Record<string, unknown> = {
      select: (colunas = '') => { estado.select = String(colunas); selects.push({ tabela, select: estado.select }); return alvo; },
      eq: () => alvo, gt: () => alvo, in: () => alvo, order: () => alvo, range: () => alvo, limit: () => alvo,
      maybeSingle: async () => resposta(),
      then: (resolver: (valor: unknown) => unknown) => resolver(resposta()),
    };
    return alvo;
  };
  return { selects, client: { from } as never };
}

const sla = { config: async () => ({ firstResponseThresholdMs: 300000, operatorWaitingThresholdMs: 900000, customerWaitingThresholdMs: 86400000, warningRatio: 0.8 }) } as never;

describe('Kanban no Supabase: embeds e chave estrangeira', () => {
  it('carrega os cartões da etapa sem pedir embed que o PostgREST não conhece', async () => {
    const { client } = cliente();
    const service = new SupabaseKanbanService(client, new RealtimeHub(), sla);
    const pagina = await service.conversations('workspace-a', 'board-1', 'stage-new', 1, 25, {} as never);
    expect(pagina.items).toHaveLength(1);
    // O que vinha do embed continua chegando ao card, agora por dentro de `conversations`.
    expect(pagina.items[0]).toMatchObject({ conversationId: conversa.id, tags: ['vip'], slaStatus: 'waiting_operator' });
    expect(pagina.items[0].sla).toBeTruthy();
  });

  it('pede metadata e SLA por dentro de conversations, não no topo', async () => {
    const { selects, client } = cliente();
    const service = new SupabaseKanbanService(client, new RealtimeHub(), sla);
    await service.conversations('workspace-a', 'board-1', 'stage-new', 1, 25, {} as never);
    // A contagem por etapa também consulta `conversation_kanban_state`; a dos
    // cartões é a que traz `position`.
    const consulta = selects.find(entrada => entrada.tabela === 'conversation_kanban_state' && entrada.select.includes('position'))!;
    const topo = camposDe(consulta.select).map(campo => campo.split('(')[0].replace('!inner', '').trim());
    expect(topo).not.toContain('conversation_metadata');
    expect(topo).not.toContain('conversation_sla_metrics');
    expect(consulta.select).toContain('conversation_metadata(tags)');
    expect(consulta.select).toContain('conversation_sla_metrics(');
  });

  // Guarda do próprio duplo: se ele parar de recusar, os testes acima deixam de
  // provar qualquer coisa e passariam com o select antigo.
  it('o duplo recusa embed sem chave estrangeira, como o PostgREST', () => {
    expect(embedInvalido('conversation_kanban_state', 'conversation_id,conversation_metadata(tags)')).toBe('conversation_metadata');
    expect(embedInvalido('conversation_kanban_state', 'conversation_id,conversations!inner(id,conversation_metadata(tags))')).toBeUndefined();
  });
});
