import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { defaultDevelopmentUserId, loadConfig } from '../src/config.js';
import type { StoredWebhook } from '../src/services/waha-webhook.service.js';

const workspaceA = 'workspace-a';
const chatTeamA = '5511000000001@c.us';
const chatTeamB = '5511000000002@c.us';
const chatFree = '5511000000003@c.us';
const chatAssigned = '5511000000004@c.us';
const directories: string[] = [];
const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
const headers = (userId: string) => ({ 'x-workspace-id': workspaceA, 'x-user-id': userId });
const appFor = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-visibility-')); directories.push(directory);
  const app = await createApp({ ...loadConfig({ NODE_ENV: 'development', DATABASE_PROVIDER: 'sqlite' }), port: 0, nodeEnv: 'test', databasePath: join(directory, 'api.sqlite'), workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20 });
  apps.push(app);
  return app;
};
afterEach(() => { apps.splice(0).forEach(app => app.locals.persistenceDatabase.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

const messageEvent = (id: string, chatId: string): StoredWebhook => ({ workspaceId: workspaceA, wahaSession: 'waha-a', externalEventId: `evt-${id}`, eventType: 'message', occurredAt: '2026-08-06T12:00:00.000Z', payload: { id, chatId, body: `conversa ${chatId}` }, receivedAt: '2026-08-06T12:00:00.000Z' });

/** Semeia dois departamentos, um agent do A, um manager e quatro conversas:
 *  uma do time A, uma do time B, uma sem departamento e uma do time B
 *  atribuída diretamente ao agent. */
const seed = async () => {
  const app = await appFor();
  const owner = headers(defaultDevelopmentUserId);
  const teamA = (await request(app).post('/api/v1/workspace/teams').set(owner).send({ name: 'Departamento A' }).expect(201)).body;
  const teamB = (await request(app).post('/api/v1/workspace/teams').set(owner).send({ name: 'Departamento B' }).expect(201)).body;
  const agentA = (await request(app).post('/api/v1/workspace/users').set(owner).send({ email: 'agentea@local.test', displayName: 'Agente A', role: 'agent', status: 'active' }).expect(201)).body;
  const manager = (await request(app).post('/api/v1/workspace/users').set(owner).send({ email: 'gerente@local.test', displayName: 'Gerente', role: 'manager', status: 'active' }).expect(201)).body;
  await request(app).post(`/api/v1/workspace/teams/${teamA.id}/members`).set(owner).send({ userId: agentA.id }).expect(201);
  const store = app.locals.wahaWebhookStore;
  for (const chatId of [chatTeamA, chatTeamB, chatFree, chatAssigned]) await store.ingest(messageEvent(`m-${chatId}`, chatId));
  const conversations = (await store.listConversations(workspaceA, 1, 50)).items;
  const byChat = (chatId: string) => conversations.find((item: { chatId: string; id: string }) => item.chatId === chatId)!;
  await store.setTeamAssignment(workspaceA, byChat(chatTeamA).id, teamA.id, 'seed');
  await store.setTeamAssignment(workspaceA, byChat(chatTeamB).id, teamB.id, 'seed');
  await store.setTeamAssignment(workspaceA, byChat(chatAssigned).id, teamB.id, 'seed');
  await store.setAssignment(workspaceA, byChat(chatAssigned).id, agentA.id, 'seed');
  return { app, teamA, teamB, agentA, manager, byChat };
};

describe('visibilidade de conversas por departamento', () => {
  it('agent vê só o próprio escopo na lista, com total coerente', async () => {
    const { app, agentA, byChat } = await seed();
    const response = await request(app).get('/api/v1/inbox/conversations').set(headers(agentA.id)).expect(200);
    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([byChat(chatTeamA).id, byChat(chatFree).id, byChat(chatAssigned).id]));
    expect(ids).not.toContain(byChat(chatTeamB).id);
    expect(response.body.total).toBe(3);
  });

  it('o filtro vale também para a busca', async () => {
    const { app, agentA, byChat } = await seed();
    const hidden = await request(app).get('/api/v1/inbox/conversations').query({ search: '5511000000002' }).set(headers(agentA.id)).expect(200);
    expect(hidden.body.total).toBe(0);
    const visible = await request(app).get('/api/v1/inbox/conversations').query({ search: '5511000000001' }).set(headers(agentA.id)).expect(200);
    expect(visible.body.items.map((item: { id: string }) => item.id)).toEqual([byChat(chatTeamA).id]);
  });

  it('abrir conversa de outro departamento responde 404, não 403', async () => {
    const { app, agentA, byChat } = await seed();
    const id = byChat(chatTeamB).id;
    await request(app).get(`/api/v1/inbox/conversations/${id}`).set(headers(agentA.id)).expect(404);
    await request(app).get(`/api/v1/inbox/conversations/${id}/messages`).set(headers(agentA.id)).expect(404);
    await request(app).get(`/api/v1/inbox/conversations/${id}/context`).set(headers(agentA.id)).expect(404);
    await request(app).get(`/api/v1/inbox/conversations/${id}/participants`).set(headers(agentA.id)).expect(404);
  });

  it('agent abre normalmente conversa do próprio time e a atribuída a ele', async () => {
    const { app, agentA, byChat } = await seed();
    await request(app).get(`/api/v1/inbox/conversations/${byChat(chatTeamA).id}`).set(headers(agentA.id)).expect(200);
    await request(app).get(`/api/v1/inbox/conversations/${byChat(chatTeamA).id}/messages`).set(headers(agentA.id)).expect(200);
    await request(app).get(`/api/v1/inbox/conversations/${byChat(chatAssigned).id}`).set(headers(agentA.id)).expect(200);
    await request(app).get(`/api/v1/inbox/conversations/${byChat(chatFree).id}`).set(headers(agentA.id)).expect(200);
  });

  it('manager e owner veem todas as conversas', async () => {
    const { app, manager, byChat } = await seed();
    const asManager = await request(app).get('/api/v1/inbox/conversations').set(headers(manager.id)).expect(200);
    expect(asManager.body.total).toBe(4);
    await request(app).get(`/api/v1/inbox/conversations/${byChat(chatTeamB).id}`).set(headers(manager.id)).expect(200);
    const asOwner = await request(app).get('/api/v1/inbox/conversations').set(headers(defaultDevelopmentUserId)).expect(200);
    expect(asOwner.body.total).toBe(4);
  });

  it('usuário fora do diretório é tratado como agent sem times', async () => {
    const { app, byChat } = await seed();
    const stranger = '00000000-0000-4000-8000-0000000000ff';
    const response = await request(app).get('/api/v1/inbox/conversations').set(headers(stranger)).expect(200);
    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([byChat(chatFree).id]);
    await request(app).get(`/api/v1/inbox/conversations/${byChat(chatTeamA).id}`).set(headers(stranger)).expect(404);
  });
});
