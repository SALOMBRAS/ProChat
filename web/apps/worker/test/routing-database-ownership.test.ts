import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../../api/src/persistence/database.js';
import { assertRoutingSchema, sharesApiDatabase } from '../src/main.js';

const windows = process.platform === 'win32';

describe('routing database ownership', () => {
  it('recognises the API database behind a relative path', () => {
    expect(sharesApiDatabase('.chatpro-data/backend.sqlite', join(process.cwd(), '.chatpro-data', 'backend.sqlite'))).toBe(true);
  });

  it('treats a dedicated routing file as the worker own database', () => {
    expect(sharesApiDatabase(join(process.cwd(), 'routing.sqlite'), join(process.cwd(), 'backend.sqlite'))).toBe(false);
  });

  it('follows the platform rule for case', () => {
    // One file on Windows, two on Linux. Getting this backwards would either
    // reintroduce the race or block a legitimate standalone routing database.
    expect(sharesApiDatabase('C:/data/Backend.sqlite', 'C:/data/backend.sqlite')).toBe(windows);
  });

  it('is false when either path is unset, so nothing changes by default', () => {
    expect(sharesApiDatabase(undefined, '/data/backend.sqlite')).toBe(false);
    expect(sharesApiDatabase('/data/routing.sqlite', undefined)).toBe(false);
  });

  it('accepts a migrated API database and refuses an empty one without touching it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatpro-routing-'));
    const migrated = new SqlitePersistenceDatabase(join(directory, 'migrated.sqlite'));
    const empty = new SqlitePersistenceDatabase(join(directory, 'empty.sqlite'));
    migrated.migrate();
    try {
      expect(() => assertRoutingSchema(migrated.sqlite)).not.toThrow();
      expect(() => assertRoutingSchema(empty.sqlite)).toThrow('the API owns that schema');
      expect(empty.sqlite.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table'").get()).toEqual({ total: 0 });
    } finally {
      migrated.close(); empty.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
