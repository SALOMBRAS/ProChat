export type DatabaseProvider = 'sqlite' | 'supabase';

// The dashboard uses this identity only while real authentication is not
// connected. Keep it in one place so the API can provision the same local
// development actor instead of treating it as an unknown, inactive user.
export const defaultDevelopmentUserId = '00000000-0000-4000-8000-000000000001';

/** O dashboard do Vite em desenvolvimento. Fica aqui, e não em `app.ts`, para
 *  que o padrão de quem não configura nada e o de quem monta a config à mão
 *  sejam o mesmo — divergir os dois é como um deploy passa a recusar o próprio
 *  front sem ninguém notar. */
/** `0.0.0.0` preserva o comportamento de sempre: quem não configura nada não
 *  muda de vida. Vale saber o que ele significa numa máquina com rede — todas as
 *  interfaces, inclusive a da rede local. */
export const defaultApiHosts: readonly string[] = ['0.0.0.0'];
export const defaultCorsAllowedOrigins: readonly string[] = ['http://127.0.0.1:5173', 'http://localhost:5173'];
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
  corsAllowedOrigins?: readonly string[];
  apiHosts?: readonly string[];
  ownWhatsappNumbers?: string[];
  whatsappHistorySyncBatchChats?: number;
  whatsappHistorySyncBatchMessages?: number;
  whatsappHistorySyncEmergencyMaxMessages?: number;
}

export function loadConfig(env = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid TCP port');
  // WAHA can accept a send after several seconds. Keep the API transport alive
  // long enough to receive its acknowledgement instead of returning a false 504.
  // The worker treats this as the whole budget for the command and shares it
  // across every provider call the command needs, so it is also the ceiling on
  // how deep one history page can read. The maximum matches the transport
  // contract, which refuses anything larger.
  const workerTransportTimeoutMs = Number(env.WORKER_TRANSPORT_TIMEOUT_MS ?? 30_000);
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
  // Origens que podem falar com a API pelo navegador. O padrão é o dashboard em
  // desenvolvimento; em produção ele nunca serve, porque a origem passa a ser o
  // domínio real — e uma lista vazia bloquearia tudo em silêncio, então a
  // variável é o único jeito de o deploy declarar quem é o front.
  // Endereços em que a API escuta, separados por vírgula. Mais de um porque o
  // caso real precisa de dois: o loopback, para o dashboard e para quem usa a
  // máquina, e o gateway da bridge do Docker, que é por onde o contêiner da WAHA
  // entrega o webhook (`host.docker.internal`). Ligar em `0.0.0.0` resolveria os
  // dois de uma vez e de quebra publicaria na rede local uma API sem
  // autenticação.
  const apiHosts = (env.API_HOST ?? defaultApiHosts.join(',')).split(',').map(value => value.trim()).filter(Boolean);
  const corsAllowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? defaultCorsAllowedOrigins.join(',')).split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean);
  const ownWhatsappNumbers = (env.WHATSAPP_OWN_NUMBERS ?? '').split(',').map(value => value.replace(/\D/g, '')).filter(value => value.length >= 8 && value.length <= 15);
  return { port, nodeEnv, workerTransportUrl: env.WORKER_TRANSPORT_URL ?? 'http://127.0.0.1:3101/internal/transport', workerTransportTimeoutMs, databasePath: env.CHATPRO_DATABASE_PATH, databaseProvider, supabaseUrl: env.SUPABASE_URL, supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, wahaWebhookHmacKey: env.WAHA_WEBHOOK_HMAC_KEY?.trim() || undefined, wahaWebhookWorkspaceId, wahaBaseUrl: env.WAHA_BASE_URL?.trim().replace(/\/+$/, '') || undefined, wahaApiKey: env.WAHA_API_KEY?.trim() || undefined, mediaProxyTokenSecret: env.MEDIA_PROXY_TOKEN_SECRET?.trim() || undefined, developmentUserId, apiHosts, corsAllowedOrigins, ownWhatsappNumbers, whatsappHistorySyncBatchChats: positiveInteger('WHATSAPP_HISTORY_SYNC_BATCH_CHATS', 25, 100), whatsappHistorySyncBatchMessages: positiveInteger('WHATSAPP_HISTORY_SYNC_BATCH_MESSAGES', 100, 5_000), whatsappHistorySyncEmergencyMaxMessages: positiveInteger('WHATSAPP_HISTORY_SYNC_EMERGENCY_MAX_MESSAGES', 100_000, 1_000_000) };
}
