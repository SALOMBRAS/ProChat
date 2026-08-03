import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { log } from './logging.js';
import { attachWebSocket } from './websocket.js';
import { RealtimeHub } from './realtime.js';
const config = loadConfig();
const app = await createApp(config); const server = createServer(app); const wss = attachWebSocket(server, app.locals.realtimeHub as RealtimeHub);
server.listen(config.port, () => log('info', 'API listening', { port: config.port, environment: config.nodeEnv }));
let closing = false;
function shutdown(signal: string): void { if (closing) return; closing = true; log('info', 'API shutting down', { signal }); wss.close(() => server.close(() => { app.locals.persistenceDatabase?.close(); process.exit(0); })); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
// Last-resort diagnostics only. Every background task is expected to handle its
// own failure; this guard keeps an unexpected provider object rejection from
// taking the API down while retaining useful evidence in the logs.
process.on('unhandledRejection', reason => {
  const error = reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
  log('error', 'Unhandled promise rejection', { error: error.stack ?? error.message });
});
