import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { createSqliteDomainRepository } from '../src/persistence/sqlite-domain.repository.js';
import { DomainService } from '../src/services/domain.service.js';
import { SqliteWahaWebhookStore, type StoredWebhook } from '../src/services/waha-webhook.service.js';
import { DepartmentAssignmentService } from '../src/services/department-assignment.service.js';
import { WahaWebhookController } from '../src/controllers/waha-webhook.controller.js';
import { RealtimeHub } from '../src/realtime.js';

const workspaceId = 'workspace-a';
const teamId = '00000000-0000-4000-8000-0000000000aa';
const directories: string[] = [];
const databases: SqlitePersistenceDatabase[] = [];
// No Windows o handle do SQLite segura o arquivo: fechar antes do rmSync.
afterEach(() => { databases.splice(0).forEach(database => database.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

const harness = () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-department-assignment-')); directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), join(process.cwd(), 'migrations'));
  database.migrate(); databases.push(database);
  const store = new SqliteWahaWebhookStore(database.sqlite);
  const domain = new DomainService(createSqliteDomainRepository(database.sqlite));
  const realtime = { publish: vi.fn() };
  const service = new DepartmentAssignmentService(domain, store, realtime as unknown as RealtimeHub);
  return { database, store, domain, realtime, service };
};

const messageEvent = (id: string, chatId: string, session = 'waha-a'): StoredWebhook => ({ workspaceId, wahaSession: session, externalEventId: `evt-${id}`, eventType: 'message', occurredAt: '2026-08-06T12:00:00.000Z', payload: { id, chatId, body: 'oi' }, receivedAt: '2026-08-06T12:00:00.000Z' });

describe('auto-atribuição instância→departamento', () => {
  it('conversa nova em sessão vinculada ganha o departamento do vínculo', async () => {
    const { store, domain, realtime, service } = harness();
    await domain.saveSettings(workspaceId, { operational: { 'instanceTeam:waha-a': teamId } });
    const result = await store.ingest(messageEvent('m1', '5511999990000@c.us'));
    expect(result.conversationCreated).toBe(true);
    await service.onConversationCreated(workspaceId, 'waha-a', result.conversationId!);
    const conversation = await store.getConversation(workspaceId, result.conversationId!);
    expect(conversation?.assignedTeamId).toBe(teamId);
    expect(realtime.publish).toHaveBeenCalledWith(workspaceId, 'conversation.management.updated', expect.objectContaining({ conversationId: result.conversationId }), expect.objectContaining({ conversationTeamId: teamId }));
  });

  it('mensagem seguinte na mesma conversa não é criação', async () => {
    const { store } = harness();
    await store.ingest(messageEvent('m1', '5511999990000@c.us'));
    const result = await store.ingest(messageEvent('m2', '5511999990000@c.us'));
    expect(result.conversationCreated).toBe(false);
  });

  it('conversa já atribuída a outro departamento não muda', async () => {
    const { store, domain, realtime, service } = harness();
    await domain.saveSettings(workspaceId, { operational: { 'instanceTeam:waha-a': teamId } });
    const result = await store.ingest(messageEvent('m1', '5511999990000@c.us'));
    await store.setTeamAssignment(workspaceId, result.conversationId!, '00000000-0000-4000-8000-0000000000bb', 'test');
    await service.onConversationCreated(workspaceId, 'waha-a', result.conversationId!);
    expect((await store.getConversation(workspaceId, result.conversationId!))?.assignedTeamId).toBe('00000000-0000-4000-8000-0000000000bb');
    expect(realtime.publish).not.toHaveBeenCalled();
  });

  it('sessão sem vínculo deixa a conversa sem departamento', async () => {
    const { store, realtime, service } = harness();
    const result = await store.ingest(messageEvent('m1', '5511999990000@c.us', 'waha-sem-vinculo'));
    await service.onConversationCreated(workspaceId, 'waha-sem-vinculo', result.conversationId!);
    expect((await store.getConversation(workspaceId, result.conversationId!))?.assignedTeamId).toBeNull();
    expect(realtime.publish).not.toHaveBeenCalled();
  });

  it('webhook responde 202 mesmo quando a auto-atribuição falha', async () => {
    const { store } = harness();
    const key = 'department-test-secret';
    const app = express();
    app.use(express.json({ verify: (req, _res, buffer) => { (req as { rawBody?: Buffer }).rawBody = Buffer.from(buffer); } }));
    const failing = { onConversationCreated: vi.fn(async () => { throw new Error('settings fora do ar'); }) };
    app.post('/webhooks/waha', new WahaWebhookController(store, { publish: vi.fn() } as unknown as RealtimeHub, { hmacKey: key, workspaceId }, undefined, undefined, undefined, failing).receive);
    const body = JSON.stringify({ id: 'evt-webhook', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'webhook-message', chatId: '5511999990000@c.us', body: 'oi' } });
    await request(app).post('/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', createHmac('sha512', key).update(body).digest('hex')).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', String(Date.now())).send(body).expect(202);
    expect(failing.onConversationCreated).toHaveBeenCalledWith(workspaceId, 'waha-a', expect.any(String));
    expect(await store.listConversations(workspaceId, 1, 10)).toMatchObject({ total: 1 });
  });
});
