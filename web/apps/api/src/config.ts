export type DatabaseProvider = 'sqlite' | 'supabase';

export interface ApiConfig {
  port: number;
  nodeEnv: string;
  workerTransportUrl: string;
  workerTransportTimeoutMs: number;
  databasePath?: string;
  databaseProvider?: DatabaseProvider;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  wahaWebhookHmacKey?: string;
  wahaWebhookWorkspaceId?: string;
  developmentUserId?: string;
  whatsappHistorySyncBatchChats?: number;
  whatsappHistorySyncBatchMessages?: number;
  whatsappHistorySyncMaxChats?: number;
  whatsappHistorySyncMaxMessages?: number;
}

export function loadConfig(env = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid TCP port');
  const workerTransportTimeoutMs = Number(env.WORKER_TRANSPORT_TIMEOUT_MS ?? 2_000);
  if (!Number.isInteger(workerTransportTimeoutMs) || workerTransportTimeoutMs < 1 || workerTransportTimeoutMs > 30_000) throw new Error('WORKER_TRANSPORT_TIMEOUT_MS must be a valid timeout');
  const databaseProvider = env.DATABASE_PROVIDER ?? 'sqlite';
  if (databaseProvider !== 'sqlite' && databaseProvider !== 'supabase') throw new Error('DATABASE_PROVIDER must be either sqlite or supabase');
  const wahaWebhookWorkspaceId = env.WAHA_WEBHOOK_WORKSPACE_ID?.trim();
  if (wahaWebhookWorkspaceId && !/^[A-Za-z0-9_-]{1,128}$/.test(wahaWebhookWorkspaceId)) throw new Error('WAHA_WEBHOOK_WORKSPACE_ID must be a safe identifier');
  const developmentUserId = env.CHATPRO_DEVELOPMENT_USER_ID?.trim() || undefined;
  if (developmentUserId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(developmentUserId)) throw new Error('CHATPRO_DEVELOPMENT_USER_ID must be a UUID');
  const positiveInteger = (name: string, fallback: number, maximum: number) => { const value = Number(env[name] ?? fallback); if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be a positive integer up to ${maximum}`); return value; };
  return { port, nodeEnv: env.NODE_ENV ?? 'development', workerTransportUrl: env.WORKER_TRANSPORT_URL ?? 'http://127.0.0.1:3101/internal/transport', workerTransportTimeoutMs, databasePath: env.CHATPRO_DATABASE_PATH, databaseProvider, supabaseUrl: env.SUPABASE_URL, supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, wahaWebhookHmacKey: env.WAHA_WEBHOOK_HMAC_KEY?.trim() || undefined, wahaWebhookWorkspaceId, developmentUserId, whatsappHistorySyncBatchChats: positiveInteger('WHATSAPP_HISTORY_SYNC_BATCH_CHATS', 10, 100), whatsappHistorySyncBatchMessages: positiveInteger('WHATSAPP_HISTORY_SYNC_BATCH_MESSAGES', 300, 5_000), whatsappHistorySyncMaxChats: positiveInteger('WHATSAPP_HISTORY_SYNC_MAX_CHATS', 500, 10_000), whatsappHistorySyncMaxMessages: positiveInteger('WHATSAPP_HISTORY_SYNC_MAX_MESSAGES', 50_000, 1_000_000) };
}
