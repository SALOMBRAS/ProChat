export type DatabaseProvider = 'sqlite' | 'supabase';

// The dashboard uses this identity only while real authentication is not
// connected. Keep it in one place so the API can provision the same local
// development actor instead of treating it as an unknown, inactive user.
export const defaultDevelopmentUserId = '00000000-0000-4000-8000-000000000001';

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
  wahaBaseUrl?: string;
  wahaApiKey?: string;
  mediaProxyTokenSecret?: string;
  developmentUserId?: string;
  ownWhatsappNumbers?: string[];
  whatsappHistorySyncBatchChats?: number;
  whatsappHistorySyncBatchMessages?: number;
  whatsappHistorySyncEmergencyMaxMessages?: number;
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
  const nodeEnv = env.NODE_ENV ?? 'development';
  const configuredDevelopmentUserId = env.CHATPRO_DEVELOPMENT_USER_ID?.trim() || undefined;
  const developmentUserId = nodeEnv === 'development' || nodeEnv === 'test' ? configuredDevelopmentUserId ?? defaultDevelopmentUserId : undefined;
  if (developmentUserId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(developmentUserId)) throw new Error('CHATPRO_DEVELOPMENT_USER_ID must be a UUID');
  const positiveInteger = (name: string, fallback: number, maximum: number) => { const value = Number(env[name] ?? fallback); if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be a positive integer up to ${maximum}`); return value; };
  const ownWhatsappNumbers = (env.WHATSAPP_OWN_NUMBERS ?? '').split(',').map(value => value.replace(/\D/g, '')).filter(value => value.length >= 8 && value.length <= 15);
  return { port, nodeEnv, workerTransportUrl: env.WORKER_TRANSPORT_URL ?? 'http://127.0.0.1:3101/internal/transport', workerTransportTimeoutMs, databasePath: env.CHATPRO_DATABASE_PATH, databaseProvider, supabaseUrl: env.SUPABASE_URL, supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, wahaWebhookHmacKey: env.WAHA_WEBHOOK_HMAC_KEY?.trim() || undefined, wahaWebhookWorkspaceId, wahaBaseUrl: env.WAHA_BASE_URL?.trim().replace(/\/+$/, '') || undefined, wahaApiKey: env.WAHA_API_KEY?.trim() || undefined, mediaProxyTokenSecret: env.MEDIA_PROXY_TOKEN_SECRET?.trim() || undefined, developmentUserId, ownWhatsappNumbers, whatsappHistorySyncBatchChats: positiveInteger('WHATSAPP_HISTORY_SYNC_BATCH_CHATS', 25, 100), whatsappHistorySyncBatchMessages: positiveInteger('WHATSAPP_HISTORY_SYNC_BATCH_MESSAGES', 100, 5_000), whatsappHistorySyncEmergencyMaxMessages: positiveInteger('WHATSAPP_HISTORY_SYNC_EMERGENCY_MAX_MESSAGES', 100_000, 1_000_000) };
}
