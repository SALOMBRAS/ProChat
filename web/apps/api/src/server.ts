import { createApp } from './app.js';
import { defaultApiHosts, loadConfig } from './config.js';
import { log } from './logging.js';
import { listenOn } from './listen.js';
import { RealtimeHub } from './realtime.js';
const config = loadConfig();
const app = await createApp(config);
const hosts = config.apiHosts ?? defaultApiHosts;
const servers = await listenOn(app, app.locals.realtimeHub as RealtimeHub, hosts, config.port);
log('info', 'API listening', { port: config.port, hosts, environment: config.nodeEnv });
let closing = false;
function shutdown(signal: string): void {
  if (closing) return; closing = true; log('info', 'API shutting down', { signal });
  // Fecha todos os servidores: são um por endereço, e o banco só pode ser
  // fechado depois que o último soltar as conexões.
  let restantes = servers.length;
  for (const server of servers) server.close(() => { if (--restantes === 0) { app.locals.persistenceDatabase?.close(); process.exit(0); } });
}
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
// Last-resort diagnostics only. Every background task is expected to handle its
// own failure; this guard keeps an unexpected provider object rejection from
// taking the API down while retaining useful evidence in the logs.
process.on('unhandledRejection', reason => {
  const error = reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
  log('error', 'Unhandled promise rejection', { error: error.stack ?? error.message });
});
