import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { RealtimeHub } from '../src/realtime.js';
import { KanbanService } from '../src/services/kanban.service.js';
import { SupabaseKanbanService } from '../src/services/supabase-kanban.service.js';

/** O card mostrava `maskedId` — o JID com bolinhas —, que é identificador
 *  técnico e não pode estar em tela (regra 6 do `CLAUDE.md`). Agora ele carrega
 *  a mesma identidade que a lista da Inbox resolve, com a mesma precedência:
 *  nome de perfil do WhatsApp antes do nome ChatPro. */
const diretorios: string[] = [];
afterEach(() => diretorios.splice(0).forEach(caminho => rmSync(caminho, { recursive: true, force: true })));

function local() {
  const caminho = mkdtempSync(join(tmpdir(), 'chatpro-nome-'));
  diretorios.push(caminho);
  const database = new SqlitePersistenceDatabase(join(caminho, 'db.sqlite'), join(process.cwd(), 'migrations'));
  database.migrate();
  const sla = { status: async () => undefined, reopen: async () => undefined, applyOperationalStatus: async () => undefined } as any;
  return { database, service: new KanbanService(database.sqlite, new RealtimeHub(), sla) };
}
const agora = '2026-08-03T10:00:00.000Z';
function conversa(database: SqlitePersistenceDatabase, id: string, chatId: string, contactId: string | null = null, tipo: 'direct' | 'group' = 'direct') {
  database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,conversationType,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'workspace-a', 'primary', chatId, contactId, tipo, 'open', 'Olá', agora, 0, agora, agora);
}

describe('o card do Kanban mostra nome, não JID', () => {
  it('SQLite: o nome de perfil do WhatsApp ganha do nome ChatPro', async () => {
    const { database, service } = local();
    try {
      const id = '00000000-0000-4000-8000-0000000000d1';
      database.sqlite.prepare('INSERT INTO contacts (id,workspaceId,displayName,phoneNumber,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run('contato-1', 'workspace-a', 'Ana da Silva (ChatPro)', '5511999992765', agora, agora);
      conversa(database, id, '5511999992765@c.us', 'contato-1');
      database.sqlite.prepare('INSERT INTO whatsapp_identities (id,workspaceId,wahaSession,whatsappId,phone,name,pushName,profilePictureUrl,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run('i1', 'workspace-a', 'primary', '5511999992765@c.us', '5511999992765', 'Ana Perfil', 'Aninha', null, agora, agora);
      const [quadro] = await service.boards('workspace-a');
      await service.backfillStates('workspace-a');

      const pagina = await service.conversations('workspace-a', quadro.id, quadro.stages[0].id, 1, 30, {} as never);
      expect(pagina.items[0].identity).toMatchObject({ profileName: 'Ana Perfil', pushName: 'Aninha', contactName: 'Ana da Silva (ChatPro)', displayName: 'Ana Perfil', phone: '5511999992765' });
    } finally { database.close(); }
  });

  it('SQLite: sem identidade do WhatsApp, sobra o nome ChatPro e o telefone', async () => {
    const { database, service } = local();
    try {
      const id = '00000000-0000-4000-8000-0000000000d2';
      database.sqlite.prepare('INSERT INTO contacts (id,workspaceId,displayName,phoneNumber,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run('contato-2', 'workspace-a', 'Bruno ChatPro', '5511999992766', agora, agora);
      conversa(database, id, '5511999992766@c.us', 'contato-2');
      const [quadro] = await service.boards('workspace-a');
      await service.backfillStates('workspace-a');

      const identidade = (await service.conversations('workspace-a', quadro.id, quadro.stages[0].id, 1, 30, {} as never)).items[0].identity;
      expect(identidade).toMatchObject({ profileName: null, pushName: null, contactName: 'Bruno ChatPro', displayName: 'Bruno ChatPro', phone: '5511999992766' });
    } finally { database.close(); }
  });

  it('SQLite: grupo usa o nome do grupo', async () => {
    const { database, service } = local();
    try {
      const id = '00000000-0000-4000-8000-0000000000d3';
      conversa(database, id, '120363044166256490@g.us', null, 'group');
      database.sqlite.prepare('INSERT INTO whatsapp_groups (id,workspaceId,wahaSession,chatId,name,pictureUrl,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)').run('g1', 'workspace-a', 'primary', '120363044166256490@g.us', 'Equipe de Campo', null, agora, agora);
      const [quadro] = await service.boards('workspace-a');
      await service.backfillStates('workspace-a');

      expect((await service.conversations('workspace-a', quadro.id, quadro.stages[0].id, 1, 30, {} as never)).items[0].identity).toMatchObject({ profileName: 'Equipe de Campo', displayName: 'Equipe de Campo', phone: null });
    } finally { database.close(); }
  });

  /** O mesmo resultado do outro lado, e — o que importa tanto quanto — ao mesmo
   *  custo: três consultas de identidade **por página**, não por cartão. */
  const remoto = (quantidade: number) => {
    const consultas: string[] = [];
    const cartoes = Array.from({ length: quantidade }, (_, indice) => ({
      conversation_id: `conversa-${indice}`, stage_id: 'etapa-nova', position: indice + 1, updated_at: agora,
      conversations: { id: `conversa-${indice}`, workspace_id: 'workspace-a', visibility_state: 'visible', chat_id: `55119999900${indice}@c.us`, waha_session: 'primary', contact_id: `contato-${indice}`, last_message: 'Olá', last_message_at: agora, unread_count: 0, conversation_type: 'direct', assigned_user_id: null, assigned_team_id: null, routing_queue_id: null, priority: 'normal', conversation_metadata: null, conversation_sla_metrics: null },
    }));
    const dados: Record<string, unknown> = {
      conversation_kanban_state: cartoes,
      whatsapp_identities: cartoes.map((cartao, indice) => ({ waha_session: 'primary', whatsapp_id: cartao.conversations.chat_id, phone: `55119999900${indice}`, name: `Perfil ${indice}`, push_name: null, profile_picture_url: null, updated_at: agora })),
      whatsapp_groups: [],
      contacts: cartoes.map((_, indice) => ({ id: `contato-${indice}`, display_name: `55119999900${indice}` })),
    };
    // O duplo **projeta** pelo `select`, como o PostgREST: campo não pedido não
    // volta. Sem isso, esquecer `waha_session` ou `contact_id` no embed passaria
    // no teste e sairia sem nome em produção — que é onde o defeito apareceria.
    const embedados = (select: string) => {
      const dentro = select.match(/conversations!inner\(([^)]*)/);
      return dentro ? new Set(dentro[1].split(',').map(campo => campo.trim())) : undefined;
    };
    const from = (tabela: string) => {
      consultas.push(tabela);
      let pedidos: Set<string> | undefined;
      const alvo: Record<string, unknown> = {
        select: (colunas = '') => { pedidos = embedados(String(colunas)); return alvo; },
        eq: () => alvo, gt: () => alvo, in: () => alvo, order: () => alvo, range: () => alvo, limit: () => alvo,
        maybeSingle: async () => ({ data: tabela === 'kanban_stages' ? { id: 'etapa-nova', board_id: 'quadro-1', key: 'new', name: 'Novo', position: 1, kanban_boards: { workspace_id: 'workspace-a' } } : tabela === 'kanban_boards' ? { id: 'quadro-1', workspace_id: 'workspace-a', name: 'Operação', is_default: true, kanban_stages: [] } : null, error: null }),
        then: (resolver: (valor: unknown) => unknown) => {
          const linhas = (dados[tabela] ?? []) as any[];
          const projetadas = pedidos && tabela === 'conversation_kanban_state'
            ? linhas.map(linha => ({ ...linha, conversations: Object.fromEntries(Object.entries(linha.conversations).filter(([campo]) => pedidos!.has(campo))) }))
            : linhas;
          return resolver({ data: projetadas, count: linhas.length, error: null });
        },
      };
      return alvo;
    };
    const sla = { config: async () => ({ firstResponseThresholdMs: 1, operatorWaitingThresholdMs: 1, customerWaitingThresholdMs: 1, warningRatio: 0.8 }) } as never;
    return { consultas, service: new SupabaseKanbanService({ from } as never, new RealtimeHub(), sla) };
  };

  it('Supabase: o cartão recebe a identidade resolvida', async () => {
    const { service } = remoto(1);
    const pagina = await service.conversations('workspace-a', 'quadro-1', 'etapa-nova', 1, 30, {} as never);
    expect(pagina.items[0].identity).toMatchObject({ profileName: 'Perfil 0', displayName: 'Perfil 0', contactName: '551199999000', phone: '551199999000' });
  });

  it('Supabase: são três consultas de identidade por página, não por cartão', async () => {
    const { consultas, service } = remoto(25);
    await service.conversations('workspace-a', 'quadro-1', 'etapa-nova', 1, 30, {} as never);
    for (const tabela of ['whatsapp_identities', 'whatsapp_groups', 'contacts'])
      expect({ tabela, vezes: consultas.filter(nome => nome === tabela).length }).toEqual({ tabela, vezes: 1 });
  });

  it('Supabase: página vazia não consulta identidade nenhuma', async () => {
    const { consultas, service } = remoto(0);
    await service.conversations('workspace-a', 'quadro-1', 'etapa-nova', 1, 30, {} as never);
    expect(consultas.filter(nome => ['whatsapp_identities', 'whatsapp_groups', 'contacts'].includes(nome))).toEqual([]);
  });
});
