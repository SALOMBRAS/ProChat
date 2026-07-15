import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventEnvelopeSchema, validateEventEnvelope, type RequestContext } from '@chatpro/contracts';
import type { WorkerConfig } from '../src/config.js';
import { InMemoryEventPublisherAdapter, StructuredLogEventPublisherAdapter } from '../src/event-publishers.js';
import { FileSystemCredentialStoreAdapter } from '../src/file-system-credential-store.adapter.js';
import type { ConnectionUpdate, WhatsAppSocket, WhatsAppSocketFactory } from '../src/whatsapp-socket.js';
import { WhatsAppSessionManager } from '../src/whatsapp-session-manager.js';

class FakeSocket implements WhatsAppSocket {
  ended = false;
  loggedOut = false;
  private readonly connectionListeners: Array<(update: ConnectionUpdate) => void> = [];
  private readonly credentialListeners: Array<() => void | Promise<void>> = [];
  ev = {
    on: (event: 'connection.update' | 'creds.update', listener: ((update: ConnectionUpdate) => void) | (() => void | Promise<void>)) => {
      if (event === 'connection.update') this.connectionListeners.push(listener as (update: ConnectionUpdate) => void);
      else this.credentialListeners.push(listener as () => void | Promise<void>);
    },
  } as WhatsAppSocket['ev'];
  emit(update: ConnectionUpdate): void { this.connectionListeners.forEach(listener => listener(update)); }
  emitCreds(): void { this.credentialListeners.forEach(listener => void listener()); }
  async end(): Promise<void> { this.ended = true; }
  async logout(): Promise<void> { this.loggedOut = true; }
}

class FakeFactory implements WhatsAppSocketFactory {
  sockets: FakeSocket[] = [];
  saveCount = 0;
  failures = 0;
  gate?: Promise<void>;
  async create() {
    if (this.gate) await this.gate;
    if (this.failures > 0) { this.failures -= 1; throw new Error('factory failure'); }
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return { socket, saveCreds: async () => { this.saveCount += 1; } };
  }
}

const context: RequestContext = { userId: 'user-a', workspaceId: 'workspace-a', correlationId: 'correlation-a' };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('WhatsAppSessionManager', () => {
  let dataDir: string;
  let store: FileSystemCredentialStoreAdapter;
  let factory: FakeFactory;
  let publisher: InMemoryEventPublisherAdapter;
  let manager: WhatsAppSessionManager;
  let config: WorkerConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'chatpro-worker-'));
    config = { name: 'test', dataDir, connectionEnabled: true, maxReconnectAttempts: 2, reconnectBaseDelayMs: 10, qrTtlMs: 100, internalTransportPort: 3101 };
    store = new FileSystemCredentialStoreAdapter(dataDir);
    factory = new FakeFactory();
    publisher = new InMemoryEventPublisherAdapter();
    manager = new WhatsAppSessionManager(config, store, factory, publisher, undefined, () => undefined);
  });

  afterEach(() => { vi.useRealTimers(); });

  async function createAndConnect() {
    await manager.createSession(context, 'session-a', { name: 'Primary' });
    await manager.connectSession(context, 'session-a');
    return factory.sockets[0]!;
  }

  it('creates a disconnected session without creating credentials', async () => {
    const session = await manager.createSession(context, 'session-a', { name: 'Primary' });
    expect(session.status).toBe('disconnected');
    expect(await store.hasAuthDirectory(context.workspaceId, session.id)).toBe(false);
  });

  it.each(['', '..', '../escape', 'a/b', 'a\\b', 'C:\\temp', 'bad\u0000id', 'x'.repeat(129)])('rejects unsafe session id %j', async id => {
    await expect(manager.createSession(context, id, { name: 'Invalid' })).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });
  });

  it('blocks path traversal in the credential store', () => {
    expect(() => store.authDirectory('workspace-a', '../escape')).toThrow();
    expect(() => store.authDirectory('../escape', 'session-a')).toThrow();
  });

  it('rejects connect while the feature flag is disabled and creates no auth directory', async () => {
    config.connectionEnabled = false;
    await manager.createSession(context, 'session-a', { name: 'Primary' });
    await expect(manager.connectSession(context, 'session-a')).rejects.toMatchObject({ response: { error: { code: 'SERVICE_UNAVAILABLE' } } });
    expect(factory.sockets).toHaveLength(0);
    expect(await store.hasAuthDirectory(context.workspaceId, 'session-a')).toBe(false);
  });

  it('prevents concurrent connect operations', async () => {
    let release!: () => void;
    factory.gate = new Promise<void>(resolve => { release = resolve; });
    await manager.createSession(context, 'session-a', { name: 'Primary' });
    const first = manager.connectSession(context, 'session-a');
    await flush();
    await expect(manager.connectSession(context, 'session-a')).rejects.toMatchObject({ response: { error: { code: 'CONFLICT' } } });
    release();
    await first;
    expect(factory.sockets).toHaveLength(1);
  });

  it('transitions connecting to qr_pending and publishes the temporary QR', async () => {
    const socket = await createAndConnect();
    socket.emit({ qr: 'temporary-qr' });
    await flush();
    expect(manager.getSession(context.workspaceId, 'session-a')?.status).toBe('qr_pending');
    expect(publisher.events.find(event => event.eventType === 'session.qr.updated')?.payload).toMatchObject({ sessionId: 'session-a', qr: 'temporary-qr' });
  });

  it('transitions connecting to connected without duplicate status events', async () => {
    const socket = await createAndConnect();
    socket.emit({ connection: 'open' });
    socket.emit({ connection: 'open' });
    await flush();
    expect(manager.getSession(context.workspaceId, 'session-a')?.status).toBe('connected');
    expect(publisher.events.filter(event => event.eventType === 'session.status.changed' && event.payload.status === 'connected')).toHaveLength(1);
  });

  it('persists credential updates through the injected auth state callback', async () => {
    const socket = await createAndConnect();
    socket.emitCreds();
    await flush();
    expect(factory.saveCount).toBe(1);
  });

  it('disconnects locally and preserves credentials', async () => {
    const socket = await createAndConnect();
    await writeFile(path.join(store.authDirectory(context.workspaceId, 'session-a'), 'marker'), 'present');
    await manager.disconnectSession(context, 'session-a');
    expect(socket.ended).toBe(true);
    expect(socket.loggedOut).toBe(false);
    expect(await store.hasAuthDirectory(context.workspaceId, 'session-a')).toBe(true);
  });

  it('removes credentials and performs logout', async () => {
    const socket = await createAndConnect();
    await manager.removeSession(context, 'session-a');
    expect(socket.loggedOut).toBe(true);
    expect(await store.hasAuthDirectory(context.workspaceId, 'session-a')).toBe(false);
    expect(manager.getSession(context.workspaceId, 'session-a')).toBeUndefined();
  });

  it('makes removal idempotent', async () => {
    await manager.removeSession(context, 'missing-session');
    await manager.removeSession(context, 'missing-session');
  });

  it('does not reconnect after a logged-out close', async () => {
    vi.useFakeTimers();
    const socket = await createAndConnect();
    socket.emit({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(factory.sockets).toHaveLength(1);
    expect(manager.getSession(context.workspaceId, 'session-a')?.status).toBe('logged_out');
  });

  it('limits reconnection attempts and publishes worker.error when exhausted', async () => {
    vi.useFakeTimers();
    const instantStore = {
      authDirectory: () => path.join(dataDir, 'auth'),
      prepareAuthDirectory: async () => path.join(dataDir, 'auth'),
      hasAuthDirectory: async () => false,
      removeAuthDirectory: async () => undefined,
      discoverSessions: async () => [],
    };
    manager = new WhatsAppSessionManager(config, instantStore, factory, publisher, undefined, () => undefined);
    const first = await createAndConnect();
    first.emit({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    const second = factory.sockets[1]!;
    second.emit({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await flush();
    await vi.advanceTimersByTimeAsync(20);
    const third = factory.sockets[2]!;
    third.emit({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await flush();
    expect(factory.sockets).toHaveLength(3);
    expect(manager.getSession(context.workspaceId, 'session-a')?.status).toBe('error');
    expect(publisher.events.some(event => event.eventType === 'worker.error')).toBe(true);
  });

  it('cancels a pending reconnect timer on disconnect', async () => {
    vi.useFakeTimers();
    const socket = await createAndConnect();
    socket.emit({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await flush();
    await manager.disconnectSession(context, 'session-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(factory.sockets).toHaveLength(1);
  });

  it('does not put QR data into structured logs', async () => {
    const records: unknown[] = [];
    const logs = new StructuredLogEventPublisherAdapter((_level, _message, fields) => { records.push(fields); });
    const safeManager = new WhatsAppSessionManager(config, store, factory, logs, undefined, () => undefined);
    await safeManager.createSession(context, 'session-a', { name: 'Primary' });
    await safeManager.connectSession(context, 'session-a');
    factory.sockets[0]!.emit({ qr: 'super-secret-qr-value' });
    await flush();
    expect(JSON.stringify(records)).not.toContain('super-secret-qr-value');
  });

  it('never publishes credentials in events', async () => {
    const socket = await createAndConnect();
    socket.emitCreds();
    socket.emit({ connection: 'open' });
    await flush();
    const serialized = JSON.stringify(publisher.events);
    expect(serialized).not.toMatch(/noiseKey|signedIdentityKey|credential|privateKey/i);
  });

  it('restores persisted sessions as disconnected without creating sockets', async () => {
    await store.prepareAuthDirectory('workspace-a', 'restored-session');
    const restored = await manager.restorePersistedSessions();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.status).toBe('disconnected');
    expect(factory.sockets).toHaveLength(0);
  });

  it('isolates identical session ids between workspaces', async () => {
    await manager.createSession(context, 'shared-id', { name: 'A' });
    await manager.createSession({ ...context, workspaceId: 'workspace-b' }, 'shared-id', { name: 'B' });
    expect(manager.listSessions('workspace-a')).toHaveLength(1);
    expect(manager.listSessions('workspace-b')).toHaveLength(1);
  });

  it('gracefully ends active sockets and cancels reconnect timers', async () => {
    vi.useFakeTimers();
    const socket = await createAndConnect();
    await manager.shutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.ended).toBe(true);
    expect(manager.getSession(context.workspaceId, 'session-a')?.status).toBe('disconnected');
    expect(factory.sockets).toHaveLength(1);
  });

  it('validates every published session event against shared contracts', async () => {
    const socket = await createAndConnect();
    socket.emit({ qr: 'temporary-qr' });
    socket.emit({ connection: 'open' });
    await flush();
    for (const event of publisher.events) {
      expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
      expect(() => validateEventEnvelope(event)).not.toThrow();
    }
  });
});
