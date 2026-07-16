import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultMigrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export type SqliteDatabase = Database.Database;

export interface PersistenceDatabase {
  readonly sqlite: SqliteDatabase;
  migrate(): void;
  close(): void;
}

export class SqlitePersistenceDatabase implements PersistenceDatabase {
  readonly sqlite: SqliteDatabase;
  constructor(private readonly filePath: string, private readonly migrationsDirectory = defaultMigrationsDirectory) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('foreign_keys = ON');
  }

  migrate(): void {
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)');
    const applied = new Set(this.sqlite.prepare('SELECT id FROM schema_migrations').all().map((row) => (row as { id: string }).id));
    const migrations = readdirSync(this.migrationsDirectory).filter((file) => file.endsWith('.sql')).sort();
    const insert = this.sqlite.prepare('INSERT INTO schema_migrations (id, appliedAt) VALUES (?, ?)');
    for (const migration of migrations) {
      if (applied.has(migration)) continue;
      const run = this.sqlite.transaction(() => { this.sqlite.exec(readFileSync(resolve(this.migrationsDirectory, migration), 'utf8')); insert.run(migration, new Date().toISOString()); });
      run();
    }
  }

  close(): void { this.sqlite.close(); }
}

export function createDevelopmentDatabase(): SqlitePersistenceDatabase {
  const path = process.env.CHATPRO_DATABASE_PATH ?? resolve(process.cwd(), '../../.chatpro-data/backend.sqlite');
  const database = new SqlitePersistenceDatabase(path); database.migrate(); return database;
}
