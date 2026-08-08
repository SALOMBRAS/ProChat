import path from 'node:path';
import type { WhatsAppProviderName } from './ports.js';

export type WorkerConfig = {
  name: string;
  dataDir: string;
  connectionEnabled: boolean;
  demoMode: boolean;
  maxReconnectAttempts: number;
  reconnectBaseDelayMs: number;
  qrTtlMs: number;
  internalTransportPort: number;
  whatsAppProvider: WhatsAppProviderName;
  wahaBaseUrl: string;
  wahaApiKey?: string;
  wahaTimeoutMs: number;
  gowaEnabled: boolean;
  gowaBaseUrl: string;
  /** Reserved for an authenticated GOWA deployment or reverse proxy. */
  gowaApiKey?: string;
  gowaBasicAuthUsername?: string;
  gowaBasicAuthPassword?: string;
  gowaTimeoutMs: number;
  routingDatabasePath?: string;
  /** Shared API database path used only by the GOWA provider-session store. */
  databasePath?: string;
  routingPollMs?: number;
  routingBatchSize?: number;
  databaseProvider?: 'sqlite'|'supabase';
  routingJobsEnabled?: boolean;
  routingLockLeaseSeconds?: number;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function booleanFlag(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const enabled = env.WHATSAPP_CONNECTION_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') throw new Error('WHATSAPP_CONNECTION_ENABLED must be true or false');
  const demoMode = env.WHATSAPP_DEMO_MODE ?? 'false';
  if (demoMode !== 'true' && demoMode !== 'false') throw new Error('WHATSAPP_DEMO_MODE must be true or false');
  const configuredDataDir = env.CHATPRO_DATA_DIR?.trim();
  const provider = env.WHATSAPP_PROVIDER ?? 'baileys';
  const databaseProvider=env.DATABASE_PROVIDER ?? 'sqlite';
  if(databaseProvider!=='sqlite'&&databaseProvider!=='supabase') throw new Error('DATABASE_PROVIDER must be sqlite or supabase');
  if (provider !== 'baileys' && provider !== 'gowa' && provider !== 'waha') throw new Error('WHATSAPP_PROVIDER must be baileys, gowa or waha');
  const gowaEnabled = booleanFlag(env.GOWA_ENABLED, false, 'GOWA_ENABLED');
  if (provider === 'gowa' && !gowaEnabled) throw new Error('GOWA_ENABLED must be true when WHATSAPP_PROVIDER is gowa');
  const gowaBasicAuthUsername = env.GOWA_BASIC_AUTH_USERNAME?.trim() || undefined;
  const gowaBasicAuthPassword = env.GOWA_BASIC_AUTH_PASSWORD || undefined;
  if (Boolean(gowaBasicAuthUsername) !== Boolean(gowaBasicAuthPassword)) throw new Error('GOWA Basic Auth requires both GOWA_BASIC_AUTH_USERNAME and GOWA_BASIC_AUTH_PASSWORD');
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
    gowaEnabled,
    gowaBaseUrl: (env.GOWA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    gowaApiKey: env.GOWA_API_KEY?.trim() || undefined,
    gowaBasicAuthUsername,
    gowaBasicAuthPassword,
    gowaTimeoutMs: positiveInteger(env.GOWA_TIMEOUT_MS, 10_000, 'GOWA_TIMEOUT_MS'),
    routingDatabasePath: env.ROUTING_DATABASE_PATH?.trim() || undefined,
    databasePath: env.CHATPRO_DATABASE_PATH?.trim() || undefined,
    routingPollMs: positiveInteger(env.ROUTING_POLL_MS, 1_000, 'ROUTING_POLL_MS'),
    routingBatchSize: positiveInteger(env.ROUTING_BATCH_SIZE, 10, 'ROUTING_BATCH_SIZE'),
    databaseProvider,
    routingJobsEnabled: (env.ROUTING_JOBS_ENABLED ?? 'true') === 'true',
    routingLockLeaseSeconds: positiveInteger(env.ROUTING_LOCK_LEASE_SECONDS,60,'ROUTING_LOCK_LEASE_SECONDS'),
    supabaseUrl: env.SUPABASE_URL?.trim() || undefined,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined,
  };
}
