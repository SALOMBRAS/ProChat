import path from 'node:path';

export type WorkerConfig = {
  name: string;
  dataDir: string;
  connectionEnabled: boolean;
  demoMode: boolean;
  maxReconnectAttempts: number;
  reconnectBaseDelayMs: number;
  qrTtlMs: number;
  internalTransportPort: number;
  whatsAppProvider: 'baileys' | 'waha';
  wahaBaseUrl: string;
  wahaApiKey?: string;
  wahaTimeoutMs: number;
  routingDatabasePath?: string;
  routingPollMs?: number;
  routingBatchSize?: number;
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const enabled = env.WHATSAPP_CONNECTION_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') throw new Error('WHATSAPP_CONNECTION_ENABLED must be true or false');
  const demoMode = env.WHATSAPP_DEMO_MODE ?? 'false';
  if (demoMode !== 'true' && demoMode !== 'false') throw new Error('WHATSAPP_DEMO_MODE must be true or false');
  const configuredDataDir = env.CHATPRO_DATA_DIR?.trim();
  const provider = env.WHATSAPP_PROVIDER ?? 'baileys';
  if (provider !== 'baileys' && provider !== 'waha') throw new Error('WHATSAPP_PROVIDER must be baileys or waha');
  return {
    name: env.WORKER_NAME ?? 'chatpro-whatsapp-worker',
    dataDir: path.resolve(configuredDataDir || path.join(process.cwd(), '.chatpro-data')),
    connectionEnabled: enabled === 'true',
    demoMode: demoMode === 'true',
    maxReconnectAttempts: positiveInteger(env.WHATSAPP_MAX_RECONNECT_ATTEMPTS, 5, 'WHATSAPP_MAX_RECONNECT_ATTEMPTS'),
    reconnectBaseDelayMs: positiveInteger(env.WHATSAPP_RECONNECT_BASE_DELAY_MS, 1_500, 'WHATSAPP_RECONNECT_BASE_DELAY_MS'),
    qrTtlMs: 120_000,
    internalTransportPort: positiveInteger(env.WORKER_TRANSPORT_PORT, 3101, 'WORKER_TRANSPORT_PORT'),
    whatsAppProvider: provider,
    wahaBaseUrl: (env.WAHA_BASE_URL ?? 'http://127.0.0.1:3002').replace(/\/+$/, ''),
    wahaApiKey: env.WAHA_API_KEY?.trim() || undefined,
    wahaTimeoutMs: positiveInteger(env.WAHA_TIMEOUT_MS, 10_000, 'WAHA_TIMEOUT_MS'),
    routingDatabasePath: env.ROUTING_DATABASE_PATH?.trim() || undefined,
    routingPollMs: positiveInteger(env.ROUTING_POLL_MS, 1_000, 'ROUTING_POLL_MS'),
    routingBatchSize: positiveInteger(env.ROUTING_BATCH_SIZE, 10, 'ROUTING_BATCH_SIZE'),
  };
}
