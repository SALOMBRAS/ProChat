/**
 * Reparo dos eventos de mensagem que o webhook recebeu e descartou.
 *
 * Só script, sem endpoint. São três razões, e nenhuma é preferência de estilo:
 * o reparo é de uma vez só e percorre dezenas de milhares de eventos, o que não
 * cabe no ciclo de uma requisição HTTP e não tem aqui nenhuma infraestrutura de
 * job assíncrono para apoiá-lo — o outbox existente é para envio, não para
 * trabalho de manutenção; ninguém precisa acioná-lo pelo dashboard, então expor
 * um gravador em massa na superfície de rede só acrescentaria risco; e ele
 * precisa ser rodado deliberadamente, por quem tem acesso ao banco, lendo a
 * saída. Se um dia virar endpoint, tem de ser `POST` — a rotina grava, e este
 * repositório já tem o caso de uma rota `GET` que grava sem querer.
 *
 * Uso, a partir de `web/apps/api`:
 *
 *   npx tsx src/scripts/reprocess-discarded-events.ts --dry-run
 *   npx tsx src/scripts/reprocess-discarded-events.ts --max 200
 *   npx tsx src/scripts/reprocess-discarded-events.ts --after <externalEventId>
 *
 * `--dry-run` não grava nada: conta os eventos pendentes e os agrupa por tipo.
 * Sem ele, a rotina grava — e é retomável, porque a passada seguinte já não
 * enxerga o que foi recuperado.
 */
import { loadConfig } from '../config.js';
import { log } from '../logging.js';
import { SqlitePersistenceDatabase } from '../persistence/database.js';
import { createSupabasePersistenceClient } from '../persistence/supabase.js';
import { wahaMessageType } from '../services/conversation-identity.js';
import { ReprocessDiscardedEventsService } from '../services/reprocess-discarded.service.js';
import { SqliteWahaWebhookStore, SupabaseWahaWebhookStore, type DiscardedEventStore } from '../services/waha-webhook.service.js';

function argumento(nome: string): string | undefined {
  const indice = process.argv.indexOf(`--${nome}`);
  return indice >= 0 ? process.argv[indice + 1] : undefined;
}
const temFlag = (nome: string) => process.argv.includes(`--${nome}`);

async function main(): Promise<void> {
  const config = loadConfig();
  const usaSqlite = (config.databaseProvider ?? 'sqlite') === 'sqlite';
  const database = usaSqlite ? (config.databasePath ? new SqlitePersistenceDatabase(config.databasePath) : undefined) : undefined;
  if (usaSqlite && !database) throw new Error('CHATPRO_DATABASE_PATH é obrigatório para reprocessar com o provedor SQLite');
  database?.migrate();
  const store: DiscardedEventStore = database ? new SqliteWahaWebhookStore(database.sqlite) : new SupabaseWahaWebhookStore(createSupabasePersistenceClient(config));

  const workspaceId = argumento('workspace') ?? config.wahaWebhookWorkspaceId;
  const after = argumento('after');
  const batchSize = Number(argumento('batch') ?? 200);
  const maxEvents = argumento('max') ? Number(argumento('max')) : undefined;

  if (temFlag('dry-run')) {
    let cursor = after;
    let total = 0;
    const porTipo = new Map<string, number>();
    for (;;) {
      const pagina = await store.listDiscardedEvents({ workspaceId, after: cursor, limit: Math.min(batchSize, 500) });
      for (const evento of pagina.events) { total++; const tipo = wahaMessageType(evento.payload) ?? 'desconhecido'; porTipo.set(tipo, (porTipo.get(tipo) ?? 0) + 1); }
      if (pagina.nextAfter === null || (maxEvents && total >= maxEvents)) { cursor = pagina.nextAfter ?? cursor; break; }
      cursor = pagina.nextAfter;
    }
    log('info', 'Discarded event reprocessing dry run', { workspaceId, pending: total, byType: Object.fromEntries([...porTipo].sort((a, b) => b[1] - a[1])), resumeAfter: cursor ?? null });
    database?.close();
    return;
  }

  const service = new ReprocessDiscardedEventsService(store);
  const resumo = await service.run({ workspaceId, after, batchSize, maxEvents, onProgress: (progresso) => log('info', 'Discarded event reprocessing progress', progresso) });
  log('info', 'Discarded event reprocessing summary', resumo);
  if (!resumo.done) log('info', 'Discarded event reprocessing incomplete; resume with --after', { after: resumo.after });
  database?.close();
}

main().catch((error) => { log('error', 'Discarded event reprocessing aborted', { errorClass: error instanceof Error ? error.name : 'UnknownError', errorMessage: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
