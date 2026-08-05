import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createWorkerTransportHandler, listenInternalTransport } from '../../worker/src/internal-transport-server.js';
import type { WhatsAppWorkerPort, WorkerCommand } from '../../worker/src/ports.js';

const directories: string[] = [];
const applications: Array<Awaited<ReturnType<typeof createApp>>> = [];
const workerServers: Array<{ close: () => Promise<void> }> = [];
const key = 'reaction-test-secret';
const workspace = 'workspace-a';
const chatId = '5511999990000@c.us';
const signed = (body: unknown) => { const raw = JSON.stringify(body); return { raw, hmac: createHmac('sha512', key).update(raw).digest('hex'), timestamp: String(Date.now()) }; };

const appFor = async (workerTransportUrl = 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs = 20) => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-reactions-'));
  directories.push(directory);
  const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl, workerTransportTimeoutMs, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), wahaWebhookHmacKey: key, wahaWebhookWorkspaceId: workspace, developmentUserId: '00000000-0000-4000-8000-000000000001' });
  applications.push(app);
  return app;
};
afterEach(async () => {
  applications.splice(0).forEach(app => app.locals.persistenceDatabase?.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
  await Promise.all(workerServers.splice(0).map(server => server.close()));
});

const post = (app: Awaited<ReturnType<typeof createApp>>, body: unknown) => {
  const signedBody = signed(body);
  return request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', signedBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', signedBody.timestamp).send(signedBody.raw);
};
const seedMessage = async (app: Awaited<ReturnType<typeof createApp>>, messageId: string, timestamp = '2026-08-01T10:00:00.000Z') => {
  await post(app, { id: `evt-${messageId}`, timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: messageId, chatId, body: 'alvo', timestamp } }).expect(202);
};
const reactionEvent = (input: { eventId: string; messageId: string; emoji: string; timestamp: string; fromMe?: boolean; from?: string; participant?: string }) => ({
  id: input.eventId,
  timestamp: Date.now(),
  event: 'message.reaction',
  session: 'waha-a',
  payload: {
    fromMe: input.fromMe === true,
    from: input.from ?? chatId,
    ...(input.participant ? { participant: input.participant } : {}),
    timestamp: input.timestamp,
    reaction: { text: input.emoji, messageId: input.messageId },
  },
});
const conversationId = (app: Awaited<ReturnType<typeof createApp>>, chat = chatId) =>
  (app.locals.persistenceDatabase.sqlite.prepare('SELECT id FROM conversations WHERE chatId = ?').get(chat) as { id: string }).id;
const reactionsOf = async (app: Awaited<ReturnType<typeof createApp>>, messageId: string) => {
  const id = conversationId(app);
  const response = await request(app).get(`/api/v1/inbox/conversations/${id}/messages`).set('x-workspace-id', workspace).expect(200);
  return (response.body.items as Array<{ id: string; reactions?: unknown[] }>).find(item => item.id === messageId)?.reactions;
};
const storedReactions = (app: Awaited<ReturnType<typeof createApp>>, messageId: string) => {
  const row = app.locals.persistenceDatabase.sqlite.prepare('SELECT payloadJson FROM whatsapp_messages WHERE externalMessageId = ?').get(messageId) as { payloadJson: string } | undefined;
  return row ? (JSON.parse(row.payloadJson) as { reactions?: unknown[] }).reactions : undefined;
};

describe('message.reaction webhook ingress', () => {
  it('persists a contact reaction and exposes it on the message reader, without storing the raw event', async () => {
    const app = await appFor();
    await seedMessage(app, 'msg-1');
    await post(app, reactionEvent({ eventId: 'evt-r1', messageId: 'msg-1', emoji: '👍', timestamp: '2026-08-01T10:01:00.000Z' })).expect(202);
    expect(await reactionsOf(app, 'msg-1')).toEqual([
      { emoji: '👍', reactorWhatsappId: chatId, fromMe: false, reactorName: null, reactorPhone: '5511999990000', reactedAt: '2026-08-01T10:01:00.000Z' },
    ]);
    // O CHECK de eventType em waha_webhook_events não conhece message.reaction:
    // só a semente pode ter gravado evento bruto.
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM waha_webhook_events').get()).toEqual({ total: 1 });
  });
  it('replaces the author reaction when the same author reacts with another emoji', async () => {
    const app = await appFor();
    await seedMessage(app, 'msg-2');
    await post(app, reactionEvent({ eventId: 'evt-r2a', messageId: 'msg-2', emoji: '👍', timestamp: '2026-08-01T10:01:00.000Z' })).expect(202);
    await post(app, reactionEvent({ eventId: 'evt-r2b', messageId: 'msg-2', emoji: '❤️', timestamp: '2026-08-01T10:02:00.000Z' })).expect(202);
    expect(await reactionsOf(app, 'msg-2')).toEqual([
      { emoji: '❤️', reactorWhatsappId: chatId, fromMe: false, reactorName: null, reactorPhone: '5511999990000', reactedAt: '2026-08-01T10:02:00.000Z' },
    ]);
  });
  it('removes the reaction when the event carries an empty text', async () => {
    const app = await appFor();
    await seedMessage(app, 'msg-3');
    await post(app, reactionEvent({ eventId: 'evt-r3a', messageId: 'msg-3', emoji: '😂', timestamp: '2026-08-01T10:01:00.000Z' })).expect(202);
    await post(app, reactionEvent({ eventId: 'evt-r3b', messageId: 'msg-3', emoji: '', timestamp: '2026-08-01T10:02:00.000Z' })).expect(202);
    expect(await reactionsOf(app, 'msg-3')).toEqual([]);
    expect(storedReactions(app, 'msg-3')).toBeUndefined();
  });
  it('keeps authors independent on the same message', async () => {
    const app = await appFor();
    await seedMessage(app, 'msg-4');
    await post(app, reactionEvent({ eventId: 'evt-r4a', messageId: 'msg-4', emoji: '👍', timestamp: '2026-08-01T10:01:00.000Z', from: '5511999990000@c.us' })).expect(202);
    await post(app, reactionEvent({ eventId: 'evt-r4b', messageId: 'msg-4', emoji: '😮', timestamp: '2026-08-01T10:02:00.000Z', from: '5511888880000@c.us' })).expect(202);
    expect((await reactionsOf(app, 'msg-4'))?.map((entry: any) => entry.emoji)).toEqual(['👍', '😮']);
  });
  it('ignores an out-of-order event older than the stored reaction (LWW)', async () => {
    const app = await appFor();
    await seedMessage(app, 'msg-5');
    await post(app, reactionEvent({ eventId: 'evt-r5-new', messageId: 'msg-5', emoji: '❤️', timestamp: '2026-08-01T10:05:00.000Z' })).expect(202);
    await post(app, reactionEvent({ eventId: 'evt-r5-old', messageId: 'msg-5', emoji: '👍', timestamp: '2026-08-01T10:01:00.000Z' })).expect(202);
    expect((await reactionsOf(app, 'msg-5'))?.map((entry: any) => entry.emoji)).toEqual(['❤️']);
  });
  it('is idempotent when WAHA redelivers the same reaction event', async () => {
    const app = await appFor();
    await seedMessage(app, 'msg-6');
    const event = reactionEvent({ eventId: 'evt-r6', messageId: 'msg-6', emoji: '🙏', timestamp: '2026-08-01T10:01:00.000Z' });
    await post(app, event).expect(202);
    await post(app, event).expect(202);
    expect((await reactionsOf(app, 'msg-6'))).toHaveLength(1);
  });
  it('accepts a reaction for an unknown message as an orphan, without persisting or publishing', async () => {
    const app = await appFor();
    const socket = { readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } };
    app.locals.realtimeHub.add(socket, workspace);
    await post(app, reactionEvent({ eventId: 'evt-r7', messageId: 'msg-missing', emoji: '👍', timestamp: '2026-08-01T10:01:00.000Z' })).expect(202);
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM whatsapp_messages').get()).toEqual({ total: 0 });
    expect(socket.messages.map(message => JSON.parse(message).eventType)).not.toContain('message.reaction.updated');
  });
  it('discards a malformed reaction payload with a 202, without touching the store', async () => {
    const app = await appFor();
    await seedMessage(app, 'msg-8');
    await post(app, { id: 'evt-r8', timestamp: Date.now(), event: 'message.reaction', session: 'waha-a', payload: { from: chatId, reaction: { text: '👍' } } }).expect(202);
    expect(await reactionsOf(app, 'msg-8')).toEqual([]);
  });
  it('publishes message.reaction.updated for the workspace when a reaction lands', async () => {
    const app = await appFor();
    await seedMessage(app, 'msg-9');
    const socket = { readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } };
    app.locals.realtimeHub.add(socket, workspace);
    await post(app, reactionEvent({ eventId: 'evt-r9', messageId: 'msg-9', emoji: '👍', timestamp: '2026-08-01T10:01:00.000Z' })).expect(202);
    const published = socket.messages.map(message => JSON.parse(message)).filter(message => message.eventType === 'message.reaction.updated');
    expect(published).toHaveLength(1);
    expect(published[0].payload).toMatchObject({ conversationId: conversationId(app), messageId: 'msg-9' });
    expect(published[0].payload.reactions).toHaveLength(1);
  });
  it('reconciles phone and dashboard as one account: a fromMe event replaces operator reactions, and a fromMe removal clears them', async () => {
    const app = await appFor();
    await seedMessage(app, 'msg-10');
    const store = app.locals.wahaWebhookStore;
    await store.ingestReaction({ workspaceId: workspace, wahaSession: 'waha-a', messageId: 'msg-10', author: 'operator:user-a', emoji: '👍', fromMe: true, reactedAt: '2026-08-01T10:01:00.000Z' });
    await store.ingestReaction({ workspaceId: workspace, wahaSession: 'waha-a', messageId: 'msg-10', author: 'operator:user-b', emoji: '❤️', fromMe: true, reactedAt: '2026-08-01T10:02:00.000Z' });
    expect((await reactionsOf(app, 'msg-10'))?.map((entry: any) => entry.emoji)).toEqual(['❤️']);
    await post(app, reactionEvent({ eventId: 'evt-r10', messageId: 'msg-10', emoji: '😂', fromMe: true, timestamp: '2026-08-01T10:03:00.000Z' })).expect(202);
    expect(await reactionsOf(app, 'msg-10')).toEqual([
      { emoji: '😂', reactorWhatsappId: null, fromMe: true, reactorName: null, reactorPhone: null, reactedAt: '2026-08-01T10:03:00.000Z' },
    ]);
    await post(app, reactionEvent({ eventId: 'evt-r10b', messageId: 'msg-10', emoji: '', fromMe: true, timestamp: '2026-08-01T10:04:00.000Z' })).expect(202);
    expect(await reactionsOf(app, 'msg-10')).toEqual([]);
  });
});

describe('operator reaction endpoint', () => {
  const workerWith = (captured: WorkerCommand[]): WhatsAppWorkerPort => ({
    execute: async (_context, command) => {
      if (command.type === 'listSessions') return [];
      if (command.type === 'sendReaction') { captured.push(command); return { timestamp: new Date().toISOString() }; }
      throw new Error(`unexpected command: ${command.type}`);
    },
  });
  const appWithWorker = async (captured: WorkerCommand[]) => {
    const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(workerWith(captured)));
    workerServers.push(runtime);
    const address = runtime.server.address();
    if (!address || typeof address === 'string') throw new Error('missing worker address');
    return appFor(`http://127.0.0.1:${address.port}/internal/transport`, 1_000);
  };
  it('sends the reaction to WAHA and persists it optimistically as fromMe', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await seedMessage(app, 'msg-11');
    const id = conversationId(app);
    const response = await request(app).post(`/api/v1/inbox/conversations/${id}/messages/msg-11/reactions`).set('x-workspace-id', workspace).set('x-user-id', '00000000-0000-4000-8000-000000000001').send({ emoji: '❤️' }).expect(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ type: 'sendReaction', wahaSession: 'waha-a', chatId, messageId: 'msg-11', reaction: '❤️' });
    expect(response.body.messageId).toBe('msg-11');
    expect(response.body.reactions).toHaveLength(1);
    expect(response.body.reactions[0]).toMatchObject({ emoji: '❤️', fromMe: true, reactorWhatsappId: null });
    expect(storedReactions(app, 'msg-11')).toEqual([
      { author: 'operator:00000000-0000-4000-8000-000000000001', authorName: null, emoji: '❤️', fromMe: true, reactedAt: expect.any(String) },
    ]);
  });
  it('toggles: reacting again with the same emoji sends an empty reaction and removes the entry', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await seedMessage(app, 'msg-12');
    const id = conversationId(app);
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages/msg-12/reactions`).set('x-workspace-id', workspace).set('x-user-id', '00000000-0000-4000-8000-000000000001').send({ emoji: '👍' }).expect(200);
    const second = await request(app).post(`/api/v1/inbox/conversations/${id}/messages/msg-12/reactions`).set('x-workspace-id', workspace).set('x-user-id', '00000000-0000-4000-8000-000000000001').send({ emoji: '👍' }).expect(200);
    expect(captured.map(command => (command as Extract<WorkerCommand, { type: 'sendReaction' }>).reaction)).toEqual(['👍', '']);
    expect(second.body.reactions).toEqual([]);
  });
  it('switching emojis replaces the account reaction instead of stacking', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await seedMessage(app, 'msg-13');
    const id = conversationId(app);
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages/msg-13/reactions`).set('x-workspace-id', workspace).set('x-user-id', '00000000-0000-4000-8000-000000000001').send({ emoji: '👍' }).expect(200);
    const second = await request(app).post(`/api/v1/inbox/conversations/${id}/messages/msg-13/reactions`).set('x-workspace-id', workspace).set('x-user-id', '00000000-0000-4000-8000-000000000001').send({ emoji: '😂' }).expect(200);
    expect(captured.map(command => (command as Extract<WorkerCommand, { type: 'sendReaction' }>).reaction)).toEqual(['👍', '😂']);
    expect(second.body.reactions.map((entry: { emoji: string }) => entry.emoji)).toEqual(['😂']);
  });
  it('answers 404 for a reaction to a message the store does not have', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await seedMessage(app, 'msg-14');
    const id = conversationId(app);
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages/msg-missing/reactions`).set('x-workspace-id', workspace).set('x-user-id', '00000000-0000-4000-8000-000000000001').send({ emoji: '👍' }).expect(404);
    expect(captured).toHaveLength(0);
  });
  it('validates the emoji and the conversation id', async () => {
    const app = await appFor();
    await request(app).post('/api/v1/inbox/conversations/not-a-uuid/messages/msg-1/reactions').set('x-workspace-id', workspace).set('x-user-id', '00000000-0000-4000-8000-000000000001').send({ emoji: '👍' }).expect(400);
    await seedMessage(app, 'msg-15');
    const id = conversationId(app);
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages/msg-15/reactions`).set('x-workspace-id', workspace).set('x-user-id', '00000000-0000-4000-8000-000000000001').send({ emoji: '' }).expect(400);
  });
});

describe('internal transport', () => {
  it('maps message.sendReaction to the reactionSent data variant', async () => {
    const worker: WhatsAppWorkerPort = { execute: async (_context, command) => { if (command.type === 'sendReaction') return { timestamp: '2026-08-01T10:00:00.000Z' }; throw new Error('unexpected command'); } };
    const handler = createWorkerTransportHandler(worker);
    const response = await handler({ correlationId: 'c-1', workspaceId: workspace, timeoutMs: 1_000, command: { type: 'message.sendReaction', payload: { wahaSession: 'waha-a', chatId, messageId: 'msg-1', reaction: '' } } });
    expect(response).toEqual({ success: true, correlationId: 'c-1', workspaceId: workspace, data: { reactionSent: { timestamp: '2026-08-01T10:00:00.000Z' } } });
  });
});
