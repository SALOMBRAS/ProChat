import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@chatpro/contracts';
import { SqlitePersistenceDatabase } from '../../api/src/persistence/database.js';
import { GowaClientError, type GowaClientPort } from '../src/gowa-client.js';
import { GowaProvider } from '../src/gowa-provider.js';
import { InMemoryGowaSessionStore, SqliteGowaSessionStore, assertGowaSchema, newGowaSessionLink, type GowaSessionStore } from '../src/gowa-session-store.js';

const context = (workspaceId: string): RequestContext => ({ workspaceId, correlationId: `correlation-${workspaceId}`, userId: 'user-a' });

function client(overrides: Partial<GowaClientPort> = {}): GowaClientPort {
  return {
    health: vi.fn().mockResolvedValue(undefined),
    createDevice: vi.fn().mockImplementation(async id => ({ id, state: 'disconnected' })),
    listDevices: vi.fn().mockResolvedValue([]),
    getSessionStatus: vi.fn().mockResolvedValue({ isConnected: false, isLoggedIn: false }),
    startLogin: vi.fn(), fetchQrImage: vi.fn(), logout: vi.fn(), sendText: vi.fn(), ...overrides,
  };
}

async function withSqlite(test: (store: SqliteGowaSessionStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'chatpro-gowa-'));
  const database = new SqlitePersistenceDatabase(join(directory, 'chatpro.sqlite'));
  database.migrate();
  try { await test(new SqliteGowaSessionStore(database.sqlite)); }
  finally { database.close(); await rm(directory, { recursive: true, force: true }); }
}

describe('GOWA schema guard', () => {
  it('accepts a database the API has already migrated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatpro-gowa-schema-'));
    const database = new SqlitePersistenceDatabase(join(directory, 'chatpro.sqlite'));
    database.migrate();
    try { expect(() => assertGowaSchema(database.sqlite)).not.toThrow(); }
    finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses an unmigrated database and never creates the schema itself', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatpro-gowa-schema-'));
    const database = new SqlitePersistenceDatabase(join(directory, 'chatpro.sqlite'));
    try {
      expect(() => assertGowaSchema(database.sqlite)).toThrow('The API owns the schema');
      // The whole point: a second writer is what caused the startup race, so
      // the guard must leave the file exactly as it found it.
      expect(database.sqlite.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table'").get()).toEqual({ total: 0 });
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('GOWA durable session links', () => {
  it('rejects metadata that could contain a QR, token or WhatsApp JID', () => {
    expect(() => newGowaSessionLink({ workspaceId: 'workspace-a', provider: 'gowa', sessionId: 'session-a', sessionName: 'A', providerDeviceId: 'device-a', providerStatus: 'disconnected', chatproStatus: 'disconnected', capabilities: [], providerMetadata: { account: '5511999999999@s.whatsapp.net' }, reconciliationState: 'healthy', lastReconciledAt: null })).toThrow('Sensitive GOWA metadata');
  });

  it('saves and recovers isolated links for multiple sessions and workspaces in SQLite', async () => {
    await withSqlite(async store => {
      await store.save(newGowaSessionLink({ workspaceId: 'workspace-a', provider: 'gowa', sessionId: 'session-a', sessionName: 'A', providerDeviceId: 'device-a', providerStatus: 'disconnected', chatproStatus: 'disconnected', capabilities: ['sessions'], providerMetadata: {}, reconciliationState: 'healthy', lastReconciledAt: null }));
      await store.save(newGowaSessionLink({ workspaceId: 'workspace-a', provider: 'gowa', sessionId: 'session-b', sessionName: 'B', providerDeviceId: 'device-b', providerStatus: 'connected', chatproStatus: 'connecting', capabilities: ['sessions'], providerMetadata: {}, reconciliationState: 'healthy', lastReconciledAt: null }));
      await store.save(newGowaSessionLink({ workspaceId: 'workspace-b', provider: 'gowa', sessionId: 'session-a', sessionName: 'Outro workspace', providerDeviceId: 'device-c', providerStatus: 'disconnected', chatproStatus: 'disconnected', capabilities: ['sessions'], providerMetadata: {}, reconciliationState: 'healthy', lastReconciledAt: null }));
      const links = await store.list();
      expect(links).toHaveLength(3);
      expect(links.filter(link => link.workspaceId === 'workspace-a').map(link => link.providerDeviceId)).toEqual(['device-a', 'device-b']);
      expect(links.find(link => link.workspaceId === 'workspace-b')?.providerDeviceId).toBe('device-c');
    });
  });

  it('rebuilds a session after a worker restart from the durable link', async () => {
    const store = new InMemoryGowaSessionStore();
    const first = new GowaProvider(client(), undefined, store);
    await first.execute(context('workspace-a'), { type: 'createSession', sessionId: 'session-a', input: { name: 'Atendimento' } });
    const saved = await store.list();
    const restarted = new GowaProvider(client({ listDevices: vi.fn().mockResolvedValue([{ id: saved[0].providerDeviceId, state: 'disconnected' }]) }), undefined, store);
    await restarted.restore();
    await expect(restarted.execute(context('workspace-a'), { type: 'getSession', sessionId: 'session-a' })).resolves.toMatchObject({ id: 'session-a', name: 'Atendimento', status: 'disconnected' });
  });

  it('marks a missing remote device without deleting the persisted link', async () => {
    const store = new InMemoryGowaSessionStore();
    await store.save(newGowaSessionLink({ workspaceId: 'workspace-a', provider: 'gowa', sessionId: 'session-a', sessionName: 'Atendimento', providerDeviceId: 'device-missing', providerStatus: 'disconnected', chatproStatus: 'disconnected', capabilities: ['sessions'], providerMetadata: {}, reconciliationState: 'healthy', lastReconciledAt: null }));
    const provider = new GowaProvider(client({ listDevices: vi.fn().mockResolvedValue([]) }), undefined, store);
    await provider.restore();
    expect(await provider.execute(context('workspace-a'), { type: 'listSessions' })).toMatchObject([{ id: 'session-a', status: 'error' }]);
    expect(await store.list()).toMatchObject([{ providerDeviceId: 'device-missing', reconciliationState: 'missing', providerStatus: 'missing' }]);
  });

  it('does not change persisted records when GOWA is offline during startup reconciliation', async () => {
    const store = new InMemoryGowaSessionStore();
    await store.save(newGowaSessionLink({ workspaceId: 'workspace-a', provider: 'gowa', sessionId: 'session-a', sessionName: 'Atendimento', providerDeviceId: 'device-a', providerStatus: 'logged_in', chatproStatus: 'connected', capabilities: ['sessions'], providerMetadata: {}, reconciliationState: 'healthy', lastReconciledAt: '2026-08-07T00:00:00.000Z' }));
    const before = await store.list();
    const provider = new GowaProvider(client({ listDevices: vi.fn().mockRejectedValue(new GowaClientError('unavailable')) }), undefined, store);
    await provider.restore();
    expect(await store.list()).toEqual(before);
    await expect(provider.execute(context('workspace-a'), { type: 'getSession', sessionId: 'session-a' })).resolves.toMatchObject({ status: 'disconnected' });
  });

  it('never makes one workspace list another workspace session', async () => {
    const store: GowaSessionStore = new InMemoryGowaSessionStore();
    const provider = new GowaProvider(client(), undefined, store);
    await provider.execute(context('workspace-a'), { type: 'createSession', sessionId: 'session-a', input: {} });
    await provider.execute(context('workspace-b'), { type: 'createSession', sessionId: 'session-b', input: {} });
    await expect(provider.execute(context('workspace-a'), { type: 'listSessions' })).resolves.toMatchObject([{ id: 'session-a' }]);
    await expect(provider.execute(context('workspace-b'), { type: 'listSessions' })).resolves.toMatchObject([{ id: 'session-b' }]);
  });
});
