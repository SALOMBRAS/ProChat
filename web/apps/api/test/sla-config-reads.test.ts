import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { RealtimeHub } from '../src/realtime.js';
import { slaConfigTtlMs, SlaService, SqliteSlaStore, type SlaStore } from '../src/services/sla.service.js';

// Contabilidade de leituras de `workspace_sla_config`. A tabela tem uma linha por
// workspace e muda por ação humana; qualquer número que cresça com a quantidade
// de conversas é um N+1. A base de produção recebia ~10 GETs por segundo do mesmo
// registro, somando todos os caminhos que projetam SLA. Os testes abaixo fixam o
// número por operação — se alguém reintroduzir a leitura dentro de um laço, eles
// quebram.
class CountingSlaStore implements SlaStore {
  configReads = 0;
  dueReads = 0;
  gate?: Promise<void>;
  onSave?: () => void;
  constructor(private readonly inner: SlaStore) {}
  async getConfig(workspaceId: string) { this.configReads++; return this.inner.getConfig(workspaceId); }
  saveConfig(workspaceId: string, input: Parameters<SlaStore['saveConfig']>[1]) { return this.inner.saveConfig(workspaceId, input); }
  get(workspaceId: string, conversationId: string) { return this.inner.get(workspaceId, conversationId); }
  save(row: Parameters<SlaStore['save']>[0]) { this.onSave?.(); return this.inner.save(row); }
  async listDue(workspaceId?: string) { this.dueReads++; if (this.gate) await this.gate; return this.inner.listDue(workspaceId); }
  criticalConversationIdentities(workspaceId: string, conversationIds: string[]) { return this.inner.criticalConversationIdentities(workspaceId, conversationIds); }
  conversationIdForMessage(workspaceId: string, session: string, messageId: string) { return this.inner.conversationIdForMessage(workspaceId, session, messageId); }
}

const directories: string[] = [];
const migrations = join(process.cwd(), 'migrations');
const inboundAt = '2026-07-23T10:00:00.000Z';
const now = '2026-07-23T12:00:00.000Z';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-sla-reads-'));
  directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), migrations);
  database.migrate();
  const store = new CountingSlaStore(new SqliteSlaStore(database.sqlite));
  return { database, store, service: new SlaService(store, new RealtimeHub()) };
}

// Conversas em espera do operador desde `inboundAt`, portanto vencidas às 12h e
// candidatas a virar `expired` no tick — o caminho que também publica evento.
//
// O lote inteiro entra numa transação só, e as duas instruções são preparadas uma
// vez fora do laço. Não é estilo. O banco de teste roda no padrão do SQLite —
// `journal_mode = delete` e `synchronous = FULL`, conferidos —, então cada
// `.run()` solto é uma transação implícita: cria o arquivo de journal, escreve,
// dá `fsync`, comita, dá `fsync` de novo e apaga. As 120 linhas do primeiro
// cenário eram 120 dessas rodadas, 388 ms medidos nesta máquina contra 5 ms em
// transação.
//
// Esse é o custo que varia com o disco do runner, e não com a lógica sob teste:
// o caso levava 826 ms aqui e estourou o timeout de 5 s do vitest com 6176 ms na
// execução 30830804324 do CI. Não era a máquina inteira mais lenta — dois testes
// mais pesados que ele passaram na mesma execução —, era esta pilha de `fsync`
// esperando um disco disputado. Uma transação a reduz a um. Montar o cenário não
// é o que este arquivo mede.
function dueConversations(database: SqlitePersistenceDatabase, workspaceId: string, from: number, to: number) {
  const conversation = database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const metrics = database.sqlite.prepare('INSERT INTO conversation_sla_metrics (workspaceId,conversationId,slaStatus,firstInboundAt,lastInboundAt,lastActivityAt,waitingSinceAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)');
  return database.sqlite.transaction(() => {
    const ids: string[] = [];
    for (let index = from; index < to; index++) {
      const conversationId = `00000000-0000-4000-8000-0000000${String(index).padStart(5, '0')}`;
      conversation.run(conversationId, workspaceId, 'waha-a', `55119999${String(index).padStart(5, '0')}@c.us`, null, 'open', 'Olá', inboundAt, 0, inboundAt, inboundAt);
      metrics.run(workspaceId, conversationId, 'waiting_operator', inboundAt, inboundAt, inboundAt, inboundAt, inboundAt);
      ids.push(conversationId);
    }
    return ids;
  })();
}

const dueConversation = (database: SqlitePersistenceDatabase, workspaceId: string, index: number) =>
  dueConversations(database, workspaceId, index, index + 1)[0]!;

afterEach(() => { vi.useRealTimers(); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe('leituras de configuração de SLA por operação', () => {
  // O tick roda a cada 60 s sobre todas as conversas não congeladas de todos os
  // workspaces. Antes da correção ele lia a configuração uma vez por linha, mais
  // uma vez por publicação: 60 linhas custavam 120 leituras. O custo agora é o da
  // população de workspaces, não o da população de conversas.
  it('lê a configuração uma vez por workspace num tick, não uma vez por conversa', async () => {
    const { database, store, service } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    dueConversations(database, 'workspace-a', 0, 30);
    dueConversations(database, 'workspace-b', 30, 60);
    await service.tick();
    expect(await store.listDue()).toHaveLength(60);
    expect(store.configReads).toBe(2);
  });

  // Toda mensagem recebida projeta o SLA para o realtime. A projeção precisa da
  // configuração, e ela vinha do banco a cada mensagem — em pico de conversas
  // isso é uma leitura por mensagem contra uma linha que não mudou.
  it('não relê a configuração a cada mensagem do mesmo workspace', async () => {
    const { database, store, service } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const conversationId = dueConversation(database, 'workspace-a', 0);
    for (let index = 0; index < 10; index++) await service.message('workspace-a', conversationId, index % 2 ? 'outbound' : 'inbound', now, false);
    expect(store.configReads).toBe(1);
  });

  // Abrir dez conversas na Inbox pede as métricas de cada uma. O número de
  // leituras de configuração não pode acompanhar o número de conversas abertas.
  it('não relê a configuração a cada conversa consultada', async () => {
    const { database, store, service } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const ids = dueConversations(database, 'workspace-a', 0, 10);
    for (const id of ids) expect(await service.metrics('workspace-a', id)).toBeDefined();
    expect(store.configReads).toBe(1);
  });

  // Uma renderização do painel é uma leitura de configuração — e continua sendo.
  it('resume o painel com uma leitura de configuração', async () => {
    const { database, store, service } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    dueConversations(database, 'workspace-a', 0, 20);
    const summary = await service.summary('workspace-a');
    expect(summary.totals.active).toBe(20);
    expect(store.configReads).toBe(1);
  });

  // Cache sem invalidação é bug. Salvar a configuração precisa valer na próxima
  // projeção, sem esperar o TTL.
  it('reflete a configuração salva na projeção seguinte, sem esperar o TTL', async () => {
    const { database, store, service } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const conversationId = dueConversation(database, 'workspace-a', 0);
    expect((await service.metrics('workspace-a', conversationId))?.slaIndicator).toBe('red');
    await service.config('workspace-a', { firstResponseThresholdMs: 30 * 60 * 60 * 1000 });
    expect((await service.metrics('workspace-a', conversationId))?.slaIndicator).toBe('green');
    expect(store.configReads).toBe(1);
  });

  // O cache sozinho não bastaria aqui: um tick sobre uma base grande pode durar
  // mais que o próprio TTL, e a expiração no meio do percurso o faria voltar ao
  // banco enquanto ainda percorre as mesmas linhas. Resolver as configurações
  // antes do laço é o que torna o custo de um tick independente da sua duração.
  it('mantém uma leitura por workspace mesmo num tick mais longo que o TTL', async () => {
    const { database, store, service } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    dueConversations(database, 'workspace-a', 0, 5);
    // Cada gravação do tick empurra o relógio além do TTL do cache.
    store.onSave = () => vi.setSystemTime(new Date(Date.now() + slaConfigTtlMs + 1));
    await service.tick();
    expect(store.configReads).toBe(1);
  });

  // `setInterval` não espera a execução anterior. Um tick que passe de 60 s —
  // exatamente o que acontece quando cada conversa custa idas ao banco — passa a
  // rodar sobreposto a si mesmo, e cada cópia repete o percurso inteiro.
  it('não deixa um tick lento se sobrepor ao seguinte', async () => {
    const { database, store, service } = setup();
    dueConversations(database, 'workspace-a', 0, 5);
    let release = () => {};
    store.gate = new Promise<void>((resolve) => { release = resolve; });
    const running = service.tick();
    // O segundo disparo não é esperado de propósito: esperar por ele seria esperar
    // pelo primeiro, que é justamente a sobreposição sob teste. Ele tem de voltar
    // sem ter tocado no banco, e `listDue` conta no momento da chamada.
    const skipped = service.tick();
    expect(store.dueReads).toBe(1);
    release();
    await Promise.all([running, skipped]);
    // Terminado o anterior, o próximo disparo volta a rodar normalmente.
    store.gate = undefined;
    await service.tick();
    expect(store.dueReads).toBe(2);
  });

  // O TTL é a rede de proteção para outra instância da API ter gravado a
  // configuração: passado o intervalo, a próxima leitura vai ao banco.
  it('relê a configuração depois do TTL', async () => {
    const { database, store, service } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const conversationId = dueConversation(database, 'workspace-a', 0);
    await service.metrics('workspace-a', conversationId);
    await service.metrics('workspace-a', conversationId);
    expect(store.configReads).toBe(1);
    vi.setSystemTime(new Date(new Date(now).getTime() + slaConfigTtlMs + 1));
    await service.metrics('workspace-a', conversationId);
    expect(store.configReads).toBe(2);
  });
});
