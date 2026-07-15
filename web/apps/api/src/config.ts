export interface ApiConfig { port: number; nodeEnv: string; workerTransportUrl: string; workerTransportTimeoutMs: number; }
export function loadConfig(env = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid TCP port');
  const workerTransportTimeoutMs = Number(env.WORKER_TRANSPORT_TIMEOUT_MS ?? 2_000);
  if (!Number.isInteger(workerTransportTimeoutMs) || workerTransportTimeoutMs < 1 || workerTransportTimeoutMs > 30_000) throw new Error('WORKER_TRANSPORT_TIMEOUT_MS must be a valid timeout');
  return { port, nodeEnv: env.NODE_ENV ?? 'development', workerTransportUrl: env.WORKER_TRANSPORT_URL ?? 'http://127.0.0.1:3101/internal/transport', workerTransportTimeoutMs };
}
