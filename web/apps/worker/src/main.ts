import { pathToFileURL } from 'node:url';
import { BaileysSocketFactory } from './baileys-socket.factory.js';
import { BaileysWhatsAppWorkerAdapter } from './baileys-whatsapp-worker.adapter.js';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { StructuredLogEventPublisherAdapter } from './event-publishers.js';
import { FileSystemCredentialStoreAdapter } from './file-system-credential-store.adapter.js';
import { log } from './logging.js';
import { createWorkerTransportHandler, listenInternalTransport } from './internal-transport-server.js';
import { WhatsAppSessionManager } from './whatsapp-session-manager.js';

export async function createWorkerRuntime(config: WorkerConfig = loadWorkerConfig()) {
  const credentials = new FileSystemCredentialStoreAdapter(config.dataDir);
  const publisher = new StructuredLogEventPublisherAdapter();
  const manager = new WhatsAppSessionManager(config, credentials, new BaileysSocketFactory(), publisher);
  const adapter = new BaileysWhatsAppWorkerAdapter(manager);
  const restored = await manager.restorePersistedSessions();
  return { adapter, manager, restored, config, shutdown: () => manager.shutdown() };
}

export async function runWorker(): Promise<void> {
  const runtime = await createWorkerRuntime();
  const transport = await listenInternalTransport({ host: '127.0.0.1', port: runtime.config.internalTransportPort }, createWorkerTransportHandler(runtime.adapter));
  log('info', 'WhatsApp worker started', { name: runtime.config.name, connectionEnabled: runtime.config.connectionEnabled, restoredSessions: runtime.restored.length, dataDirConfigured: true });
  let stopping = false;
  const keepAlive = setInterval(() => undefined, 60_000);
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    log('info', 'WhatsApp worker stopping', { name: runtime.config.name, signal });
    await transport.close();
    await runtime.shutdown();
    log('info', 'WhatsApp worker stopped', { name: runtime.config.name, signal });
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  runWorker().catch(error => {
    log('error', 'WhatsApp worker failed to start', { errorClass: error instanceof Error ? error.name : 'UnknownError' });
    process.exitCode = 1;
  });
}
