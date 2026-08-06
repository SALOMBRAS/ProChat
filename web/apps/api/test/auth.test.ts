import type { Server } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext, WhatsAppSession } from '@chatpro/contracts';
import { createWorkerTransportHandler, listenInternalTransport } from '../../worker/src/internal-transport-server.js';
import type { WhatsAppWorkerPort, WorkerCommand } from '../../worker/src/ports.js';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/services/auth.service.js';

class ControlledWorker implements WhatsAppWorkerPort {
  readonly sessions = new Map<string, WhatsAppSession>();
  async execute(context: RequestContext, command: WorkerCommand) {
    const key = (id: string) => `${context.workspaceId}:${id}`;
    if (command.type === 'listSessions') return [...this.sessions.values()].filter(session => session.workspaceId === context.workspaceId);
    if (command.type === 'sendMessage' || command.type === 'sendAttachment' || command.type === 'sendContent') return { id: 'controlled-message', timestamp: new Date().toISOString() };
    if (command.type === 'sendReaction') return { timestamp: new Date().toISOString() };
    if (command.type === 'syncIdentity') return { identity: null, group: null };
    if (command.type === 'historyPage') return { kind: command.chatId ? 'messages' as const : 'chats' as const, items: [], unsupported: [], hasMore: false };
    if (command.type === 'contactsPage') return { items: [], unsupported: [], hasMore: false };
    if (command.type === 'lidsPage') return { items: [], unsupported: [], hasMore: false };
    const session = this.sessions.get(key(command.sessionId));
    if (!session) { const error = Object.assign(new Error('Session not found'), { response: { error: { code: 'NOT_FOUND', message: 'Session not found' } } }); throw error; }
    if (command.type === 'getSession') return session;
    if (command.type === 'getQr') return { sessionId: session.id, workspaceId: session.workspaceId, qr: 'controlled-temporary-qr', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
}

const workspace = `ws-auth-${Date.now()}`;
const admin = { email: 'dono@chatpro.dev', password: 'senha-dono-123' };

describe('autenticação e papéis', () => {
  let server: Server; let app: Awaited<ReturnType<typeof createApp>>;
  beforeEach(async () => {
    const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(new ControlledWorker()));
    server = runtime.server;
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: `http://127.0.0.1:${address.port}/internal/transport`, workerTransportTimeoutMs: 1_000, wahaWebhookWorkspaceId: workspace, adminEmail: admin.email, adminPassword: admin.password });
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  const login = (email: string, password: string) => request(app).post('/api/v1/auth/login').set('x-workspace-id', workspace).send({ email, password });

  it('guarda senha como scrypt verificável, nunca em texto puro', () => {
    const stored = hashPassword('minha-senha-secreta');
    expect(stored).toMatch(/^scrypt:/);
    expect(stored).not.toContain('minha-senha-secreta');
    expect(verifyPassword('minha-senha-secreta', stored)).toBe(true);
    expect(verifyPassword('outra-senha', stored)).toBe(false);
  });

  it('faz o bootstrap do owner no primeiro boot e permite o login', async () => {
    const response = await login(admin.email, admin.password).expect(200);
    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body.user).toMatchObject({ email: admin.email, role: 'owner', status: 'active' });
    await request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${response.body.token}`).expect(200)
      .expect(me => expect(me.body.user.role).toBe('owner'));
  });

  it('rejeita senha errada e e-mail desconhecido com 401', async () => {
    await login(admin.email, 'senha-errada').expect(401);
    await login('ninguem@chatpro.dev', admin.password).expect(401);
  });

  it('exige sessão quando o contexto legado está desligado (produção)', async () => {
    const { createAuthMiddlewares } = await import('../src/middleware/auth.js');
    const { authenticate } = createAuthMiddlewares({ resolveSession: async () => { throw new Error('não deve ser chamado sem token'); } } as never, { allowLegacyHeaders: false });
    const next = vi.fn();
    await authenticate({ header: () => undefined, context: { correlationId: 'c1' } } as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401, code: 'UNAUTHORIZED' }));
  });

  it('mantém o contexto legado de headers funcionando fora de produção', async () => {
    await request(app).get('/api/v1/sessions').set('x-workspace-id', workspace).set('x-user-id', 'user-a').expect(200);
  });

  it('agent acessa painel e inbox, mas gestão retorna 403', async () => {
    const adminLogin = await login(admin.email, admin.password).expect(200);
    const adminToken = adminLogin.body.token as string;
    const created = await request(app).post('/api/v1/workspace/users').set('authorization', `Bearer ${adminToken}`)
      .send({ email: 'agente@chatpro.dev', displayName: 'Agente Teste', role: 'agent', status: 'active', password: 'senha-agente-123' }).expect(201);
    expect(created.body.role).toBe('agent');

    const agentLogin = await login('agente@chatpro.dev', 'senha-agente-123').expect(200);
    const agentToken = agentLogin.body.token as string;
    const asAgent = (path: string) => request(app).get(path).set('authorization', `Bearer ${agentToken}`);

    await asAgent('/api/v1/inbox/conversations').expect(200);
    await asAgent('/api/v1/domain/dashboard').expect(200);
    await asAgent('/api/v1/workspace/users').expect(200);
    await asAgent('/api/v1/sessions').expect(403);
    await asAgent('/api/v1/domain/settings').expect(403);
    await asAgent('/api/v1/workspace/queues').expect(403);
    await request(app).post('/api/v1/workspace/users').set('authorization', `Bearer ${agentToken}`)
      .send({ email: 'outro@chatpro.dev', displayName: 'Outro' }).expect(403);
  });

  it('duas contas ficam logadas ao mesmo tempo com sessões independentes', async () => {
    const adminLogin = await login(admin.email, admin.password).expect(200);
    await request(app).post('/api/v1/workspace/users').set('authorization', `Bearer ${adminLogin.body.token}`)
      .send({ email: 'agente2@chatpro.dev', displayName: 'Agente Dois', role: 'agent', status: 'active', password: 'senha-agente-123' }).expect(201);
    const agentLogin = await login('agente2@chatpro.dev', 'senha-agente-123').expect(200);

    const [meAdmin, meAgent] = await Promise.all([
      request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${adminLogin.body.token}`),
      request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${agentLogin.body.token}`),
    ]);
    expect(meAdmin.body.user.role).toBe('owner');
    expect(meAgent.body.user.role).toBe('agent');
    expect(adminLogin.body.token).not.toBe(agentLogin.body.token);
  });

  it('logout revoga só a própria sessão', async () => {
    const first = await login(admin.email, admin.password).expect(200);
    const second = await login(admin.email, admin.password).expect(200);
    await request(app).post('/api/v1/auth/logout').set('authorization', `Bearer ${first.body.token}`).expect(204);
    await request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${first.body.token}`).expect(401);
    await request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${second.body.token}`).expect(200);
  });

  it('admin redefine a senha de um colaborador e a sessão antiga cai', async () => {
    const adminLogin = await login(admin.email, admin.password).expect(200);
    const created = await request(app).post('/api/v1/workspace/users').set('authorization', `Bearer ${adminLogin.body.token}`)
      .send({ email: 'agente3@chatpro.dev', displayName: 'Agente Três', role: 'agent', status: 'active', password: 'senha-agente-123' }).expect(201);
    const agentLogin = await login('agente3@chatpro.dev', 'senha-agente-123').expect(200);

    await request(app).post(`/api/v1/auth/users/${created.body.id}/password`).set('authorization', `Bearer ${adminLogin.body.token}`)
      .send({ password: 'senha-nova-456' }).expect(204);
    await request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${agentLogin.body.token}`).expect(401);
    await login('agente3@chatpro.dev', 'senha-agente-123').expect(401);
    await login('agente3@chatpro.dev', 'senha-nova-456').expect(200);
  });
});
