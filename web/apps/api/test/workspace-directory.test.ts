import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const directories: string[] = [];
const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
const owner = '00000000-0000-4000-8000-000000000001';
const headers = { 'x-workspace-id': 'workspace-a', 'x-user-id': owner };
const appFor = async () => { const directory = mkdtempSync(join(tmpdir(), 'chatpro-directory-')); directories.push(directory); const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), developmentUserId: owner }); apps.push(app); return app; };
afterEach(() => { apps.splice(0).forEach(app => app.locals.persistenceDatabase.close()); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('workspace users and teams directory', () => {
  it('creates isolated operators and active teams, manages members, and publishes changes', async () => {
    const app = await appFor(); const socket = { readyState: 1, messages: [] as string[], send(value: string) { this.messages.push(value); } }; app.locals.realtimeHub.add(socket, 'workspace-a');
    await request(app).get('/api/v1/workspace/users').set(headers).expect(200).expect(response => expect(response.body).toHaveLength(1));
    const user = (await request(app).post('/api/v1/workspace/users').set(headers).send({ email: 'ana@chatpro.local', displayName: 'Ana', role: 'agent', status: 'active' }).expect(201)).body;
    await request(app).get('/api/v1/workspace/users').set({ ...headers, 'x-workspace-id': 'workspace-b' }).expect(200).expect(response => expect(response.body).toEqual([]));
    const team = (await request(app).post('/api/v1/workspace/teams').set(headers).send({ name: 'Suporte', color: '#8b5cf6' }).expect(201)).body;
    await request(app).post(`/api/v1/workspace/teams/${team.id}/members`).set(headers).send({ userId: user.id, membershipRole: 'leader' }).expect(201);
    await request(app).get(`/api/v1/workspace/teams/${team.id}/members`).set(headers).expect(200).expect(response => expect(response.body).toMatchObject([{ userId: user.id, membershipRole: 'leader' }]));
    await request(app).post(`/api/v1/workspace/users/${user.id}/disable`).set(headers).expect(200).expect(response => expect(response.body.status).toBe('disabled'));
    await request(app).delete(`/api/v1/workspace/teams/${team.id}/members/${user.id}`).set(headers).expect(204);
    expect(socket.messages.map(message => JSON.parse(message).eventType)).toEqual(expect.arrayContaining(['workspace.user.created', 'workspace.team.created', 'workspace.team.members.updated', 'workspace.user.updated']));
  });
});
