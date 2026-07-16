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
