import type { ApiConfig } from '../config.js';
import type { SqliteDatabase } from './database.js';
import { createPersistenceRepositories } from './repositories.js';
import { createSupabasePersistenceRepositories } from './supabase-repositories.js';
import { createSupabasePersistenceClient } from './supabase.js';

/** Composition boundary for persistence. The current API bootstrap deliberately
 * remains on SQLite; a later provider-switch task will consume this factory. */
export function createRepositoriesForProvider(config: ApiConfig, sqlite?: SqliteDatabase) {
  if (config.databaseProvider === 'supabase') {
    return createSupabasePersistenceRepositories(createSupabasePersistenceClient(config));
  }
  if (!sqlite) throw new Error('A SQLite database is required when DATABASE_PROVIDER=sqlite');
  return createPersistenceRepositories(sqlite);
}
