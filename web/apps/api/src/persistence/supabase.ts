import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ApiConfig } from '../config.js';

/**
 * Builds the server-side client used by the Supabase repository adapter.
 * It is intentionally not called by the current runtime: SQLite remains the
 * active provider until the provider-switch task.
 */
export function createSupabasePersistenceClient(config: Pick<ApiConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>): SupabaseClient {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when DATABASE_PROVIDER=supabase');
  }
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
