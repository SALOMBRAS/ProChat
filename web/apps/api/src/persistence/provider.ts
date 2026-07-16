import type { ApiConfig } from '../config.js';
import type { SqliteDatabase } from './database.js';
import { createPersistenceRepositories } from './repositories.js';
import { createSupabasePersistenceRepositories } from './supabase-repositories.js';
import { createSupabasePersistenceClient } from './supabase.js';
import { createSqliteDomainRepository } from './sqlite-domain.repository.js';
import { createSupabaseDomainRepository } from './supabase-domain.repository.js';
import type { DomainRepository } from './domain.repository.js';

/** Composition boundary for persistence. The current API bootstrap deliberately
 * remains on SQLite; a later provider-switch task will consume this factory. */
export function createRepositoriesForProvider(config: ApiConfig, sqlite?: SqliteDatabase) {
  if (config.databaseProvider === 'supabase') {
    return createSupabasePersistenceRepositories(createSupabasePersistenceClient(config));
  }
  if (!sqlite) throw new Error('A SQLite database is required when DATABASE_PROVIDER=sqlite');
  return createPersistenceRepositories(sqlite);
}

/** Async composition point used by the API bootstrap. Supabase credentials are
 * validated before the process starts accepting requests. */
export async function createDomainRepositoryForProvider(config: ApiConfig, sqlite?: SqliteDatabase): Promise<DomainRepository> {
  if ((config.databaseProvider ?? 'sqlite') === 'sqlite') {
    if (!sqlite) throw new Error('A SQLite database is required when DATABASE_PROVIDER=sqlite');
    return createSqliteDomainRepository(sqlite);
  }
  return createSupabaseDomainRepository(createSupabasePersistenceClient(config));
}
