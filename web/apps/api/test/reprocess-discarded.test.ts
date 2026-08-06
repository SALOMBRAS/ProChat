import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { ReprocessDiscardedEventsService } from '../src/services/reprocess-discarded.service.js';
import { SqliteWahaWebhookStore, SupabaseWahaWebhookStore } from '../src/services/waha-webhook.service.js';

// Forma real do WEBJS medida em `waha_webhook_events`: sem `chatId` e sem
// `remoteJid`, com o grupo em `from`, o autor em `participant` e o tipo em
// `_data.type`. É o payload que a #73 passou a aceitar e que estes eventos
// tinham quando foram descartados.
const grupo = '120363363444637332@g.us';
const autor = '105257451397231@lid';
const nosso = '558592369359@c.us';

function eventoDeGrupo(indice: number, tipo: string, extra: Record<string, unknown> = {}) {
  return {
    id: `false_${grupo}_3EB0${String(indice).padStart(18, '0')}_${autor}`,
    from: grupo, to: nosso, participant: autor, fromMe: false,
    _data: { type: tipo }, ...extra,
  };
}

const fixtures: Array<{ nome: string; tipo: string; payload: Record<string, unknown> }> = [
  { nome: 'texto', tipo: 'chat', payload: eventoDeGrupo(1, 'chat', { body: 'mensagem de grupo' }) },
  { nome: 'imagem', tipo: 'image', payload: eventoDeGrupo(2, 'image', { hasMedia: true, media: { mimetype: 'image/jpeg', filename: null, url: 'http://127.0.0.1:3002/api/files/sessao/arquivo.jpeg' } }) },
  { nome: 'vídeo', tipo: 'video', payload: eventoDeGrupo(3, 'video', { hasMedia: true, media: { mimetype: 'video/mp4', filename: null, url: 'http://127.0.0.1:3002/api/files/sessao/arquivo.mp4' } }) },
  { nome: 'sticker', tipo: 'sticker', payload: eventoDeGrupo(4, 'sticker', { hasMedia: true, media: { mimetype: 'image/webp', filename: null, url: 'http://127.0.0.1:3002/api/files/sessao/arquivo.webp' } }) },
  { nome: 'áudio de voz', tipo: 'ptt', payload: eventoDeGrupo(5, 'ptt', { hasMedia: true, media: { mimetype: 'audio/ogg; codecs=opus', filename: null, url: 'http://127.0.0.1:3002/api/files/sessao/arquivo.ogg' } }) },
];

// Estas duas formas foram medidas junto com as de cima e têm de continuar sem
// virar conversa: `@broadcast` é status e o participante privado é o precedente
// da #18. Se o reparo as aceitasse, ele criaria o que o webhook recusa.
const naoRecuperaveis = [
  { id: 'false_status@broadcast_AAA_5511999990001@lid', from: 'status@broadcast', to: nosso, participant: '5511999990001@lid', fromMe: false, _data: { type: 'chat' }, body: 'status' },
  { id: 'false_5511999990000@c.us_BBB_5511999990000@c.us', from: '5511999990000@c.us', to: nosso, participant: '5511999990000@c.us', fromMe: false, _data: { type: 'chat' }, body: 'ambíguo' },
];

const directories: string[] = [];
// No Windows o handle do SQLite segura o arquivo: fechar antes do rmSync.
const databases: SqlitePersistenceDatabase[] = [];
const migrations = join(process.cwd(), 'migrations');
const ocorridoEm = '2026-07-21T10:00:00.000Z';

function semear(database: SqlitePersistenceDatabase, payloads: Array<Record<string, unknown>>, prefixo = 'evt') {
  payloads.forEach((payload, indice) => {
    database.sqlite.prepare('INSERT INTO waha_webhook_events (workspaceId, wahaSession, externalEventId, eventType, occurredAt, payloadJson, receivedAt) VALUES (?,?,?,?,?,?,?)')
      .run('workspace-a', 'waha-a', `${prefixo}-${String(indice).padStart(3, '0')}`, 'message', ocorridoEm, JSON.stringify(payload), ocorridoEm);
  });
}

function montar() {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-reprocess-'));
  directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), migrations);
  database.migrate(); databases.push(database);
  const automation = { run: vi.fn(async () => ({ status: 'skipped' as const })) };
  const sla = { run: vi.fn(async () => {}) };
  const store = new SqliteWahaWebhookStore(database.sqlite, automation as never, [], sla as never);
  return { database, store, automation, sla, service: new ReprocessDiscardedEventsService(store) };
}

afterEach(() => { databases.splice(0).forEach((database) => database.close()); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe('reprocessamento de eventos descartados', () => {
  it('recupera cada tipo descartado como mensagem do grupo, com o participante como autor', async () => {
    const { database, store, service } = montar();
    semear(database, fixtures.map(f => f.payload));
    const resumo = await service.run({ workspaceId: 'workspace-a' });
    expect(resumo).toMatchObject({ scanned: 5, recovered: 5, failed: 0, done: true });
    const conversas = database.sqlite.prepare('SELECT chatId, conversationType FROM conversations').all();
    expect(conversas).toEqual([{ chatId: grupo, conversationType: 'group' }]);
    const mensagens = database.sqlite.prepare('SELECT messageType, senderWhatsappId, chatId FROM whatsapp_messages ORDER BY messageType').all() as Array<{ messageType: string; senderWhatsappId: string; chatId: string }>;
    // `mediaType` classifica pelo mime, não por `_data.type`: por isso `chat`
    // vira `text` e o sticker, que chega como `image/webp`, vira `image`. É o
    // mesmo comportamento da ingestão ao vivo, e o reparo tem de repeti-lo.
    expect(mensagens.map(m => m.messageType).sort()).toEqual(['image', 'image', 'ptt', 'text', 'video']);
    expect(new Set(mensagens.map(m => m.senderWhatsappId))).toEqual(new Set([autor]));
    expect(new Set(mensagens.map(m => m.chatId))).toEqual(new Set([grupo]));
    void store;
  });

  it('marca a mídia como indisponível e deixa o texto intacto', async () => {
    const { database, service } = montar();
    semear(database, fixtures.map(f => f.payload));
    const resumo = await service.run({ workspaceId: 'workspace-a' });
    expect(resumo.mediaUnavailable).toBe(4);
    const estados = database.sqlite.prepare('SELECT messageType, mediaPersistenceStatus FROM whatsapp_messages ORDER BY messageType').all() as Array<{ messageType: string; mediaPersistenceStatus: string }>;
    expect(estados.filter(e => e.messageType === 'text').map(e => e.mediaPersistenceStatus)).toEqual(['pending']);
    expect(estados.filter(e => e.messageType !== 'text').every(e => e.mediaPersistenceStatus === 'unavailable')).toBe(true);
  });

  // Um evento de dez dias atrás não pode mover card nem contar como espera de
  // agora: o reparo recupera histórico, não simula tráfego novo.
  it('não dispara automação de Kanban nem relógio de SLA', async () => {
    const { database, service, automation, sla } = montar();
    semear(database, fixtures.map(f => f.payload));
    await service.run({ workspaceId: 'workspace-a' });
    expect(automation.run).not.toHaveBeenCalled();
    expect(sla.run).not.toHaveBeenCalled();
  });

  it('rodar duas vezes não duplica nada, e a segunda passada não encontra trabalho', async () => {
    const { database, service } = montar();
    semear(database, fixtures.map(f => f.payload));
    await service.run({ workspaceId: 'workspace-a' });
    const depoisDaPrimeira = database.sqlite.prepare('SELECT count(*) total FROM whatsapp_messages').get();
    const segunda = await service.run({ workspaceId: 'workspace-a' });
    expect(segunda).toMatchObject({ scanned: 0, recovered: 0, done: true });
    expect(database.sqlite.prepare('SELECT count(*) total FROM whatsapp_messages').get()).toEqual(depoisDaPrimeira);
    expect(database.sqlite.prepare('SELECT count(*) total FROM conversations').get()).toEqual({ total: 1 });
    expect(database.sqlite.prepare('SELECT count(*) total FROM waha_webhook_events').get()).toEqual({ total: 5 });
  });

  // Dez mil eventos não podem ser tudo-ou-nada: a passada para onde mandarem, e
  // o `after` devolvido é por onde a seguinte começa.
  it('para no limite pedido e retoma de onde parou', async () => {
    const { database, service } = montar();
    semear(database, fixtures.map(f => f.payload));
    const primeira = await service.run({ workspaceId: 'workspace-a', maxEvents: 2, batchSize: 2 });
    expect(primeira).toMatchObject({ scanned: 2, recovered: 2, done: false });
    expect(database.sqlite.prepare('SELECT count(*) total FROM whatsapp_messages').get()).toEqual({ total: 2 });
    const segunda = await service.run({ workspaceId: 'workspace-a', after: primeira.after ?? undefined });
    expect(segunda).toMatchObject({ scanned: 3, recovered: 3, done: true });
    expect(database.sqlite.prepare('SELECT count(*) total FROM whatsapp_messages').get()).toEqual({ total: 5 });
  });

  it('não recupera o que o webhook recusa por outro motivo', async () => {
    const { database, service } = montar();
    semear(database, naoRecuperaveis);
    const resumo = await service.run({ workspaceId: 'workspace-a' });
    expect(resumo).toMatchObject({ scanned: 2, recovered: 0, skipped: 2, failed: 0 });
    expect(database.sqlite.prepare('SELECT count(*) total FROM conversations').get()).toEqual({ total: 0 });
    expect(database.sqlite.prepare('SELECT count(*) total FROM whatsapp_messages').get()).toEqual({ total: 0 });
  });

  // A conversa já viveu depois do descarte. Recuperar o passado não pode
  // rebaixar o presente dela para o que era há dez dias.
  it('não rebaixa a última mensagem de uma conversa que já seguiu adiante', async () => {
    const { database, store, service } = montar();
    const agora = '2026-07-31T10:00:00.000Z';
    await store.ingest({ workspaceId: 'workspace-a', wahaSession: 'waha-a', externalEventId: 'evt-novo', eventType: 'message', occurredAt: agora, payload: { id: 'msg-novo', chatId: grupo, participant: autor, body: 'mensagem recente' }, receivedAt: agora });
    const antes = database.sqlite.prepare('SELECT lastMessage, lastMessageAt, unreadCount FROM conversations').get();
    semear(database, fixtures.map(f => f.payload));
    await service.run({ workspaceId: 'workspace-a' });
    expect(database.sqlite.prepare('SELECT lastMessage, lastMessageAt, unreadCount FROM conversations').get()).toEqual(antes);
    expect(database.sqlite.prepare('SELECT count(*) total FROM whatsapp_messages').get()).toEqual({ total: 6 });
  });
});

// O filtro `in` do PostgREST é serializado na URL e o servidor corta em ~16 KB
// de header. Medido contra a base real: 600 ids destes eventos deram 19.916
// caracteres e a requisição falhou com "HTTP headers exceeded server limits".
// O teto de 100 por lote é o mesmo já justificado em `criticalSampleLimit`.
describe('anti-junção do provedor Supabase', () => {
  function clienteFalso(eventos: Array<Record<string, unknown>>, persistidos: Set<string>) {
    const lotes: number[] = [];
    const construtor = (tabela: string) => {
      const estado: { ids?: string[] } = {};
      const alvo: any = {
        select: () => alvo, order: () => alvo, limit: () => alvo, eq: () => alvo, gt: () => alvo,
        in: (coluna: string, valores: string[]) => { if (coluna === 'external_event_id') { estado.ids = valores; lotes.push(valores.length); } return alvo; },
        then: (resolver: (valor: unknown) => unknown) => resolver(tabela === 'waha_webhook_events'
          ? { data: eventos, error: null }
          : { data: (estado.ids ?? []).filter(id => persistidos.has(id)).map(id => ({ external_event_id: id })), error: null }),
      };
      return alvo;
    };
    return { cliente: { from: construtor } as never, lotes };
  }

  it('parte a consulta de ids em lotes de no máximo 100', async () => {
    const eventos = Array.from({ length: 250 }, (_, indice) => ({ workspace_id: 'workspace-a', waha_session: 'waha-a', external_event_id: `evt-${String(indice).padStart(4, '0')}`, event_type: 'message', occurred_at: ocorridoEm, payload_json: eventoDeGrupo(indice, 'chat', { body: 'x' }), received_at: ocorridoEm }));
    const { cliente, lotes } = clienteFalso(eventos, new Set(['evt-0000', 'evt-0001']));
    const store = new SupabaseWahaWebhookStore(cliente);
    const pagina = await store.listDiscardedEvents({ workspaceId: 'workspace-a', limit: 125 });
    expect(Math.max(...lotes)).toBeLessThanOrEqual(100);
    expect(lotes.reduce((soma, valor) => soma + valor, 0)).toBe(250);
    // Os dois já persistidos não voltam; o limite pedido corta o resto.
    expect(pagina.events).toHaveLength(125);
    expect(pagina.events.map(evento => evento.externalEventId)).not.toContain('evt-0000');
  });
});

describe('falha de gravação no reprocessamento', () => {
  // `whatsapp_messages` tem chave estrangeira para `waha_webhook_events`. Em
  // produção o evento bruto está lá e a chave se apoia nele; se por algum motivo
  // não estiver, a gravação falha — e a falha tem de aparecer como falha.
  // `isUniqueError` casa com qualquer "constraint", então sem a guarda de
  // `storeEvent` este caso voltaria como `duplicate: true` e a rotina o contaria
  // como `skipped`, indistinguível de um evento legitimamente recusado.
  it('propaga a falha de restrição em vez de reportá-la como duplicata', async () => {
    const { store } = montar();
    await expect(store.reprocess({
      workspaceId: 'workspace-a', wahaSession: 'waha-a', externalEventId: 'evento-bruto-ausente',
      eventType: 'message', occurredAt: ocorridoEm, payload: eventoDeGrupo(9, 'chat', { body: 'x' }), receivedAt: ocorridoEm,
    })).rejects.toThrow(/constraint/i);
  });
});

describe('fim da varredura no provedor Supabase', () => {
  // O PostgREST pode devolver menos linhas do que o `limit` pedido, e estes
  // eventos carregam o payload inteiro. Só página vazia prova o fim: tratar
  // página curta como fim faria a varredura parar no meio e relatar `done`.
  it('não confunde página curta com fim da varredura', async () => {
    const paginas = [
      Array.from({ length: 3 }, (_, i) => ({ workspace_id: 'workspace-a', waha_session: 'waha-a', external_event_id: `evt-a${i}`, event_type: 'message', occurred_at: ocorridoEm, payload_json: eventoDeGrupo(i, 'chat', { body: 'x' }), received_at: ocorridoEm })),
      Array.from({ length: 2 }, (_, i) => ({ workspace_id: 'workspace-a', waha_session: 'waha-a', external_event_id: `evt-b${i}`, event_type: 'message', occurred_at: ocorridoEm, payload_json: eventoDeGrupo(10 + i, 'chat', { body: 'x' }), received_at: ocorridoEm })),
      [],
    ];
    let chamada = 0;
    const construtor = (tabela: string) => {
      const alvo: any = {
        select: () => alvo, order: () => alvo, limit: () => alvo, eq: () => alvo, gt: () => alvo, in: () => alvo,
        then: (resolver: (valor: unknown) => unknown) => resolver(tabela === 'waha_webhook_events'
          ? { data: paginas[Math.min(chamada++, paginas.length - 1)], error: null }
          : { data: [], error: null }),
      };
      return alvo;
    };
    const store = new SupabaseWahaWebhookStore({ from: construtor } as never);
    const pagina = await store.listDiscardedEvents({ workspaceId: 'workspace-a', limit: 100 });
    // As duas páginas curtas foram consumidas antes da vazia encerrar a varredura.
    expect(pagina.events.map(evento => evento.externalEventId)).toEqual(['evt-a0', 'evt-a1', 'evt-a2', 'evt-b0', 'evt-b1']);
    expect(pagina.nextAfter).toBeNull();
  });
});

describe('cursor da varredura no provedor Supabase', () => {
  // Quando a página traz mais linhas do que o limite pedido, o laço para na
  // cota — e as linhas restantes não foram examinadas. Se o cursor avançasse
  // até o fim da página, elas nunca mais seriam vistas: a varredura relataria
  // fim tendo pulado trabalho. Medido na base real: 6.500 encontrados onde
  // havia 10.481.
  it('avança o cursor só até a última linha examinada', async () => {
    const pagina = Array.from({ length: 10 }, (_, i) => ({ workspace_id: 'workspace-a', waha_session: 'waha-a', external_event_id: `evt-${String(i).padStart(2, '0')}`, event_type: 'message', occurred_at: ocorridoEm, payload_json: eventoDeGrupo(i, 'chat', { body: 'x' }), received_at: ocorridoEm }));
    const construtor = (tabela: string) => {
      const alvo: any = {
        select: () => alvo, order: () => alvo, limit: () => alvo, eq: () => alvo, gt: () => alvo, in: () => alvo,
        then: (r: (v: unknown) => unknown) => r(tabela === 'waha_webhook_events' ? { data: pagina, error: null } : { data: [], error: null }),
      };
      return alvo;
    };
    const store = new SupabaseWahaWebhookStore({ from: construtor } as never);
    const resultado = await store.listDiscardedEvents({ workspaceId: 'workspace-a', limit: 4 });
    expect(resultado.events.map(e => e.externalEventId)).toEqual(['evt-00', 'evt-01', 'evt-02', 'evt-03']);
    // O cursor tem de parar em evt-03, e não em evt-09: da 4 à 9 ninguém olhou.
    expect(resultado.nextAfter).toBe('evt-03');
  });
});
