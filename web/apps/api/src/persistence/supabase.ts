import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ApiConfig } from '../config.js';
import { countingFetch } from './supabase-call-stats.js';

/**
 * Builds the server-side client used by the Supabase repository adapter.
 * It is intentionally not called by the current runtime: SQLite remains the
 * active provider until the provider-switch task.
 *
 * Este é o único `createClient` da API, então é o único ponto por onde passa
 * tráfego para o PostgREST — o que o torna o lugar certo para instrumentar.
 * `countingFetch` devolve o `fetch` global intocado quando `SUPABASE_CALL_STATS`
 * não está ligado, então fora de diagnóstico nada muda.
 */
export function createSupabasePersistenceClient(config: Pick<ApiConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>): SupabaseClient {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when DATABASE_PROVIDER=supabase');
  }
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: countingFetch() },
  });
}
