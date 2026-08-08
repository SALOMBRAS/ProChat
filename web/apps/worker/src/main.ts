import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SqliteDatabase } from '../../api/src/persistence/database.js';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { DemoWhatsAppWorkerAdapter } from './demo-whatsapp-worker.adapter.js';
import { StructuredLogEventPublisherAdapter } from './event-publishers.js';
import { log } from './logging.js';
import { createWorkerTransportHandler, listenInternalTransport } from './internal-transport-server.js';
import { startRoutingJobConsumer } from './routing-job-consumer.js';

export async function createWorkerRuntime(config: WorkerConfig = loadWorkerConfig()) {
  if (config.demoMode) {
    const adapter = new DemoWhatsAppWorkerAdapter();
    return { adapter, manager: undefined, restored: [], config, shutdown: () => adapter.shutdown() };
  }
  if (config.whatsAppProvider === 'waha') {
    const [{ WahaHttpClient }, { WahaProvider }, { FileWahaSessionRegistry }] = await Promise.all([import('./waha-client.js'), import('./waha-provider.js'), import('./waha-session-registry.js')]);
    const client = new WahaHttpClient({ baseUrl: config.wahaBaseUrl, apiKey: config.wahaApiKey, timeoutMs: config.wahaTimeoutMs });
    await client.health();
    const adapter = new WahaProvider(client, config.qrTtlMs, new FileWahaSessionRegistry(config.dataDir));
    return { adapter, manager: undefined, restored: [], config, shutdown: () => adapter.shutdown() };
  }
  if (config.whatsAppProvider === 'gowa') {
    const [{ GowaHttpClient }, { GowaProvider }, { createGowaSessionStore }] = await Promise.all([import('./gowa-client.js'), import('./gowa-provider.js'), import('./gowa-session-store.js')]);
    const client = new GowaHttpClient({ baseUrl: config.gowaBaseUrl, apiKey: config.gowaApiKey, basicAuthUsername: config.gowaBasicAuthUsername, basicAuthPassword: config.gowaBasicAuthPassword, timeoutMs: config.gowaTimeoutMs });
    await client.health();
    const store = await createGowaSessionStore(config);
    const adapter = new GowaProvider(client, undefined, store);
    const restored = await adapter.restore();
    return { adapter, manager: undefined, restored, config, shutdown: async () => { await adapter.shutdown(); await store.close(); } };
  }
  const [{ BaileysSocketFactory }, { BaileysWhatsAppWorkerAdapter }, { FileSystemCredentialStoreAdapter }, { WhatsAppSessionManager }] = await Promise.all([
    import('./baileys-socket.factory.js'), import('./baileys-whatsapp-worker.adapter.js'), import('./file-system-credential-store.adapter.js'), import('./whatsapp-session-manager.js'),
  ]);
  const credentials = new FileSystemCredentialStoreAdapter(config.dataDir);
  const publisher = new StructuredLogEventPublisherAdapter();
  const manager = new WhatsAppSessionManager(config, credentials, new BaileysSocketFactory(), publisher);
  const adapter = new BaileysWhatsAppWorkerAdapter(manager);
  const restored = await manager.restorePersistedSessions();
  return { adapter, manager, restored, config, shutdown: () => manager.shutdown() };
}

/**
 * Whether ROUTING_DATABASE_PATH and CHATPRO_DATABASE_PATH name the same file.
 * Compared after `resolve` because one is usually relative and the other
 * absolute, and case-insensitively on Windows only — `C:\A\db.sqlite` and
 * `c:\a\db.sqlite` are one file there and two files on Linux.
 */
export function sharesApiDatabase(routingPath: string | undefined, apiPath: string | undefined): boolean {
  if (!routingPath || !apiPath) return false;
  const normalize = (value: string) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  return normalize(routingPath) === normalize(apiPath);
}

/** Read-only, like assertGowaSchema: names what is missing, creates nothing. */
export function assertRoutingSchema(database: SqliteDatabase): void {
  const missing = ['routing_queues', 'routing_jobs'].filter(table => !database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  if (missing.length) throw new Error(`Tables ${missing.join(', ')} are missing. ROUTING_DATABASE_PATH points at the API database, and the API owns that schema: start the API once against it before starting the worker.`);
}

export async function runWorker(): Promise<void> {
  let phase = 'configuration';
  let startupConfig: WorkerConfig | undefined;
  try {
    startupConfig = loadWorkerConfig();
    phase = 'provider_creation';
    const runtime = await createWorkerRuntime(startupConfig);
    phase = 'internal_transport_bind';
    const transport = await listenInternalTransport({ host: '127.0.0.1', port: runtime.config.internalTransportPort }, createWorkerTransportHandler(runtime.adapter));
    let stopRouting: (() => void) | undefined;
    let routingDatabase: any;
    if (runtime.config.routingDatabasePath) {
      const [{ SqlitePersistenceDatabase }, { SqliteRoutingStore }, { SqliteRoutingJobStore, RoutingJobProcessor }] = await Promise.all([import('../../api/src/persistence/database.js'), import('../../api/src/services/routing.service.js'), import('../../api/src/services/routing-jobs.service.js')]);
      routingDatabase = new SqlitePersistenceDatabase(runtime.config.routingDatabasePath);
      // Same rule as the GOWA session store: whoever owns the file owns its
      // schema. Pointed at its own file the worker is the only writer, so it
      // still migrates; pointed at the API's file it must not become a second
      // one, or the startup race comes back through this door instead.
      if (sharesApiDatabase(runtime.config.routingDatabasePath, runtime.config.databasePath)) assertRoutingSchema(routingDatabase.sqlite);
      else routingDatabase.migrate();
      const jobs = new SqliteRoutingJobStore(routingDatabase.sqlite); const processor = new RoutingJobProcessor(jobs, new SqliteRoutingStore(routingDatabase.sqlite));
      const pollMs = runtime.config.routingPollMs ?? 1_000;
      stopRouting = startRoutingJobConsumer({ claim: (workerId, limit, lockTimeoutMs) => jobs.claim(workerId,limit,lockTimeoutMs), process: job => processor.process(job as never) }, { workerId: runtime.config.name, pollMs, batchSize: runtime.config.routingBatchSize ?? 10, lockTimeoutMs: pollMs * 10 });
    }
    log('info', 'WhatsApp worker started', { name: runtime.config.name, provider: runtime.config.whatsAppProvider, connectionEnabled: runtime.config.connectionEnabled, demoMode: runtime.config.demoMode, restoredSessions: runtime.restored.length, dataDirConfigured: !runtime.config.demoMode });
    let stopping = false;
    const keepAlive = setInterval(() => undefined, 60_000);
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      clearInterval(keepAlive);
      stopRouting?.(); routingDatabase?.close();
      log('info', 'WhatsApp worker stopping', { name: runtime.config.name, signal });
      await transport.close();
      await runtime.shutdown();
      log('info', 'WhatsApp worker stopped', { name: runtime.config.name, signal });
    };
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  } catch (error) {
    const details = startupFailureDetails(error);
    const context = { phase, provider: startupConfig?.whatsAppProvider, port: startupConfig?.internalTransportPort };
    log('error', 'WhatsApp worker failed to start', process.env.NODE_ENV === 'production' ? { ...context, errorClass: details.errorClass } : { ...context, ...details });
    throw error;
  }
}

function startupFailureDetails(error: unknown): Record<string, unknown> {
  const value = error instanceof Error ? error : new Error(String(error));
  const cause = value.cause instanceof Error ? value.cause : undefined;
  return {
    errorClass: value.name,
    reason: safeDiagnosticText(value.message),
    code: typeof (value as NodeJS.ErrnoException).code === 'string' ? (value as NodeJS.ErrnoException).code : undefined,
    stack: safeDiagnosticText(value.stack ?? ''),
    causeClass: cause?.name,
    causeReason: cause ? safeDiagnosticText(cause.message) : undefined,
    causeCode: cause && typeof (cause as NodeJS.ErrnoException).code === 'string' ? (cause as NodeJS.ErrnoException).code : undefined,
  };
}

function safeDiagnosticText(value: string): string {
  return value
    .replace(/(authorization|x-api-key|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 4_000);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  runWorker().catch(error => {
    process.exitCode = 1;
  });
}
