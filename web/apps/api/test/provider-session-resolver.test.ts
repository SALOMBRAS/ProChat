import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { SqliteProviderSessionResolver } from '../src/services/provider-session-resolver.service.js';

const directories: string[] = [];
const databases: SqlitePersistenceDatabase[] = [];
const migrations = join(process.cwd(), 'migrations');

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-provider-session-resolver-'));
  directories.push(directory);
  const value = new SqlitePersistenceDatabase(join(directory, 'chatpro.sqlite'), migrations);
  value.migrate();
  databases.push(value);
  return value;
}

function saveSession(database: SqlitePersistenceDatabase, input: { id: string; workspaceId: string; provider: 'waha' | 'gowa'; sessionId: string }) {
  const now = '2026-08-08T12:00:00.000Z';
  database.sqlite.prepare('INSERT INTO whatsapp_provider_sessions (id,workspaceId,provider,sessionId,sessionName,providerDeviceId,providerStatus,chatproStatus,capabilitiesJson,providerMetadataJson,reconciliationState,createdAt,updatedAt,lastReconciledAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.id, input.workspaceId, input.provider, input.sessionId, `Session ${input.provider}`, `${input.provider}-device-${input.id}`, 'connected', 'connected', '[]', '{}', 'healthy', now, now, now);
}

afterEach(() => {
  databases.splice(0).forEach(database => database.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('provider session resolver', () => {
  it('keeps WAHA and GOWA sessions with the same public session id separate', async () => {
    const value = database();
    saveSession(value, { id: '11111111-1111-4111-8111-111111111111', workspaceId: 'default', provider: 'waha', sessionId: 'comercial' });
    saveSession(value, { id: '22222222-2222-4222-8222-222222222222', workspaceId: 'default', provider: 'gowa', sessionId: 'comercial' });
    const resolver = new SqliteProviderSessionResolver(value.sqlite);

    await expect(resolver.resolve({ workspaceId: 'default', provider: 'waha', sessionId: 'comercial' })).resolves.toMatchObject({ providerSessionId: '11111111-1111-4111-8111-111111111111', provider: 'waha' });
    await expect(resolver.resolve({ workspaceId: 'default', provider: 'gowa', sessionId: 'comercial' })).resolves.toMatchObject({ providerSessionId: '22222222-2222-4222-8222-222222222222', provider: 'gowa' });
  });

  it('never resolves a session from another workspace', async () => {
    const value = database();
    saveSession(value, { id: '33333333-3333-4333-8333-333333333333', workspaceId: 'workspace-a', provider: 'gowa', sessionId: 'comercial' });
    const resolver = new SqliteProviderSessionResolver(value.sqlite);

    await expect(resolver.resolve({ workspaceId: 'workspace-b', provider: 'gowa', sessionId: 'comercial' })).resolves.toBeUndefined();
  });

  it('rejects an unsupported provider before querying persistence', async () => {
    const resolver = new SqliteProviderSessionResolver(database().sqlite);

    await expect(resolver.resolve({ workspaceId: 'default', provider: 'unknown' as 'gowa', sessionId: 'comercial' })).rejects.toThrow();
  });

  it('resolves an existing GOWA session without exposing its provider device id', async () => {
    const value = database();
    saveSession(value, { id: '44444444-4444-4444-8444-444444444444', workspaceId: 'default', provider: 'gowa', sessionId: 'gowa-comercial' });
    const resolver = new SqliteProviderSessionResolver(value.sqlite);

    await expect(resolver.resolve({ workspaceId: 'default', provider: 'gowa', sessionId: 'gowa-comercial' })).resolves.toEqual({ workspaceId: 'default', provider: 'gowa', sessionId: 'gowa-comercial', providerSessionId: '44444444-4444-4444-8444-444444444444' });
  });

  it('resolves a future WAHA session once its provider-session row exists', async () => {
    const value = database();
    saveSession(value, { id: '55555555-5555-4555-8555-555555555555', workspaceId: 'default', provider: 'waha', sessionId: 'waha-comercial' });
    const resolver = new SqliteProviderSessionResolver(value.sqlite);

    await expect(resolver.resolve({ workspaceId: 'default', provider: 'waha', sessionId: 'waha-comercial' })).resolves.toEqual({ workspaceId: 'default', provider: 'waha', sessionId: 'waha-comercial', providerSessionId: '55555555-5555-4555-8555-555555555555' });
  });
});
