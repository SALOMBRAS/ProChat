import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { defaultDevelopmentUserId, loadConfig } from '../src/config.js';
import { RealtimeHub, type ListenerScope } from '../src/realtime.js';

const workspace = 'workspace-a';
const socketFor = () => ({ readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } });
/** A entrega filtrada aguarda a resolução do escopo, que são só microtasks: um
 *  setImmediate drena a cadeia inteira sem relógio falso. */
const flush = () => new Promise(resolve => setImmediate(resolve));

const harness = (scopes: Record<string, ListenerScope>) => {
  const resolveScope = vi.fn(async (_workspaceId: string, userId: string) => scopes[userId]);
  return { hub: new RealtimeHub(resolveScope), resolveScope };
};

const agentA = { role: 'agent', teamIds: ['team-a'] };

describe('realtime filtrado por departamento', () => {
  it('agent não recebe evento de conversa de outro departamento; owner e manager recebem', async () => {
    const { hub } = harness({ 'agent-1': agentA, 'owner-1': { role: 'owner', teamIds: [] }, 'manager-1': { role: 'manager', teamIds: [] } });
    const agent = socketFor(); const owner = socketFor(); const manager = socketFor();
    hub.add(agent, workspace, 'agent-1'); hub.add(owner, workspace, 'owner-1'); hub.add(manager, workspace, 'manager-1');
    hub.publish(workspace, 'message.received', { conversationId: 'conv-b' }, { conversationTeamId: 'team-b', conversationAssignedUserId: null });
    await flush();
    expect(agent.messages).toHaveLength(0);
    expect(owner.messages).toHaveLength(1);
    expect(manager.messages).toHaveLength(1);
    expect(JSON.parse(owner.messages[0]).payload).toEqual({ conversationId: 'conv-b' });
  });

  it('agent recebe conversa sem departamento, do próprio time e atribuída a ele', async () => {
    const { hub } = harness({ 'agent-1': agentA });
    const agent = socketFor();
    hub.add(agent, workspace, 'agent-1');
    hub.publish(workspace, 'message.received', { conversationId: 'livre' }, { conversationTeamId: null, conversationAssignedUserId: null });
    hub.publish(workspace, 'message.received', { conversationId: 'do-time' }, { conversationTeamId: 'team-a', conversationAssignedUserId: null });
    hub.publish(workspace, 'message.received', { conversationId: 'de-outro-time-mas-minha' }, { conversationTeamId: 'team-b', conversationAssignedUserId: 'agent-1' });
    await flush();
    expect(agent.messages.map(message => JSON.parse(message).payload.conversationId)).toEqual(['livre', 'do-time', 'de-outro-time-mas-minha']);
  });

  it('evento sem audience vai para todos, inclusive listener sem userId', async () => {
    const { hub } = harness({ 'agent-1': agentA });
    const agent = socketFor(); const anonimo = socketFor();
    hub.add(agent, workspace, 'agent-1'); hub.add(anonimo, workspace);
    hub.publish(workspace, 'kanban.stage.updated', { boardId: 'board-1' });
    await flush();
    expect(agent.messages).toHaveLength(1);
    expect(anonimo.messages).toHaveLength(1);
  });

  it('usuário fora do diretório é tratado como agent sem times', async () => {
    const { hub } = harness({});
    const estranho = socketFor();
    hub.add(estranho, workspace, 'fantasma');
    hub.publish(workspace, 'message.received', { conversationId: 'conv-b' }, { conversationTeamId: 'team-b' });
    hub.publish(workspace, 'message.received', { conversationId: 'livre' }, { conversationTeamId: null });
    await flush();
    expect(estranho.messages.map(message => JSON.parse(message).payload.conversationId)).toEqual(['livre']);
  });

  it('o cache do escopo não consulta o diretório a cada publish', async () => {
    const { hub, resolveScope } = harness({ 'agent-1': agentA });
    const agent = socketFor();
    hub.add(agent, workspace, 'agent-1');
    for (let index = 0; index < 5; index += 1) hub.publish(workspace, 'message.received', { conversationId: `conv-${index}` }, { conversationTeamId: 'team-a' });
    await flush();
    expect(agent.messages).toHaveLength(5);
    expect(resolveScope).toHaveBeenCalledTimes(1);
  });
});

describe('integração com o diretório real da API', () => {
  const directories: string[] = [];
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
  afterEach(() => { apps.splice(0).forEach(app => app.locals.persistenceDatabase.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

  it('o hub montado em app.ts filtra pelo WorkspaceDirectoryService', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chatpro-realtime-visibility-')); directories.push(directory);
    const app = await createApp({ ...loadConfig({ NODE_ENV: 'development', DATABASE_PROVIDER: 'sqlite' }), port: 0, nodeEnv: 'test', databasePath: join(directory, 'api.sqlite'), workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20 });
    apps.push(app);
    const ownerHeaders = { 'x-workspace-id': workspace, 'x-user-id': defaultDevelopmentUserId };
    const teamB = (await request(app).post('/api/v1/workspace/teams').set(ownerHeaders).send({ name: 'Departamento B' }).expect(201)).body;
    const agent = (await request(app).post('/api/v1/workspace/users').set(ownerHeaders).send({ email: 'agente@local.test', displayName: 'Agente', role: 'agent', status: 'active' }).expect(201)).body;
    const agentSocket = socketFor(); const ownerSocket = socketFor();
    app.locals.realtimeHub.add(agentSocket, workspace, agent.id);
    app.locals.realtimeHub.add(ownerSocket, workspace, defaultDevelopmentUserId);
    app.locals.realtimeHub.publish(workspace, 'message.received', { conversationId: 'conv-b' }, { conversationTeamId: teamB.id, conversationAssignedUserId: null });
    await flush();
    expect(agentSocket.messages).toHaveLength(0);
    expect(ownerSocket.messages).toHaveLength(1);
  });
});
