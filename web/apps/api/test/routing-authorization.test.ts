import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { defaultDevelopmentUserId, loadConfig } from '../src/config.js';

const workspaceA = 'workspace-a';
const workspaceB = 'workspace-b';
const ownerB = '00000000-0000-4000-8000-000000000099';
const directories: string[] = [];
const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
const headers = (workspaceId = workspaceA, userId = defaultDevelopmentUserId) => ({ 'x-workspace-id': workspaceId, 'x-user-id': userId });
const appFor = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-routing-auth-'));
  directories.push(directory);
  const app = await createApp({ ...loadConfig({ NODE_ENV: 'development', DATABASE_PROVIDER: 'sqlite' }), port: 0, nodeEnv: 'test', databasePath: join(directory, 'api.sqlite'), workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20 });
  apps.push(app);
  return app;
};
afterEach(() => { apps.splice(0).forEach(app => app.locals.persistenceDatabase.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });
const seedActiveOwner = (app: Awaited<ReturnType<typeof createApp>>, workspaceId: string, id: string) => {
  const timestamp = new Date().toISOString();
  app.locals.persistenceDatabase.sqlite.prepare('INSERT INTO workspace_users (id,workspaceId,email,displayName,avatarUrl,role,status,createdAt,updatedAt,lastSeenAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, workspaceId, `${id}@local.test`, 'Owner', null, 'owner', 'active', timestamp, timestamp, timestamp);
};

describe('routing queue authorization', () => {
  it('provisions the default development owner only in development', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).developmentUserId).toBe(defaultDevelopmentUserId);
    expect(loadConfig({ NODE_ENV: 'production', CHATPRO_DEVELOPMENT_USER_ID: defaultDevelopmentUserId }).developmentUserId).toBeUndefined();
  });

  it('allows an active admin to list, create, edit, and associate an active attendant', async () => {
    const app = await appFor();
    await request(app).get('/api/v1/workspace/queues').set(headers()).expect(200).expect(response => expect(response.body).toEqual([]));
    const queue = (await request(app).post('/api/v1/workspace/queues').set(headers()).send({ name: 'Entrada' }).expect(201)).body;
    await request(app).patch(`/api/v1/workspace/queues/${queue.id}`).set(headers()).send({ name: 'Prioridade', strategy: 'least_loaded' }).expect(200).expect(response => expect(response.body).toMatchObject({ name: 'Prioridade', strategy: 'least_loaded' }));
    const attendant = (await request(app).post('/api/v1/workspace/users').set(headers()).send({ email: 'atendente@local.test', displayName: 'Atendente', status: 'active' }).expect(201)).body;
    await request(app).post(`/api/v1/workspace/queues/${queue.id}/members`).set(headers()).send({ userId: attendant.id }).expect(201).expect(response => expect(response.body).toMatchObject({ userId: attendant.id, isAvailable: true }));
  });

  it('keeps inactive users blocked even when they belong to the workspace', async () => {
    const app = await appFor();
    const inactive = (await request(app).post('/api/v1/workspace/users').set(headers()).send({ email: 'inactive@local.test', displayName: 'Inactive', role: 'admin', status: 'active' }).expect(201)).body;
    await request(app).post(`/api/v1/workspace/users/${inactive.id}/disable`).set(headers()).expect(200);
    await request(app).get('/api/v1/workspace/queues').set(headers(workspaceA, inactive.id)).expect(403);
  });

  it('isolates queues by workspace', async () => {
    const app = await appFor();
    const queue = (await request(app).post('/api/v1/workspace/queues').set(headers()).send({ name: 'Workspace A' }).expect(201)).body;
    seedActiveOwner(app, workspaceB, ownerB);
    await request(app).get('/api/v1/workspace/queues').set(headers(workspaceB, ownerB)).expect(200).expect(response => expect(response.body).toEqual([]));
    await request(app).patch(`/api/v1/workspace/queues/${queue.id}`).set(headers(workspaceB, ownerB)).send({ name: 'Attempt' }).expect(404);
  });

  it('denies queue access to active users without routing permission', async () => {
    const app = await appFor();
    const agent = (await request(app).post('/api/v1/workspace/users').set(headers()).send({ email: 'agent@local.test', displayName: 'Agent', role: 'agent', status: 'active' }).expect(201)).body;
    await request(app).get('/api/v1/workspace/queues').set(headers(workspaceA, agent.id)).expect(403);
  });
});
