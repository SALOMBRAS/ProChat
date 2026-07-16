import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const directories: string[] = []; const applications: Array<Awaited<ReturnType<typeof createApp>>> = [];
const key = 'webhook-test-secret';
const signed = (body: unknown) => { const raw = JSON.stringify(body); return { raw, hmac: createHmac('sha512', key).update(raw).digest('hex'), timestamp: String(Date.now()) }; };
const appFor = async () => { const directory = mkdtempSync(join(tmpdir(), 'chatpro-waha-webhook-')); directories.push(directory); const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), wahaWebhookHmacKey: key, wahaWebhookWorkspaceId: 'workspace-a' }); applications.push(app); return app; };
afterEach(() => { applications.splice(0).forEach(app => app.locals.persistenceDatabase?.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

describe('WAHA webhook ingress', () => {
  it('authenticates, sanitizes and persists a message idempotently', async () => {
    const app = await appFor(); const body = { id: 'evt-1', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'message-1', chatId: '5511999990000@c.us', body: 'Olá', type: 'text', apiKey: 'must-not-persist' } }; const requestBody = signed(body);
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202).expect(response => expect(response.body).toEqual({ accepted: true, duplicate: false }));
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(200).expect(response => expect(response.body).toEqual({ accepted: true, duplicate: true }));
    const database = app.locals.persistenceDatabase.sqlite;
    expect(database.prepare('SELECT count(*) AS total FROM waha_webhook_events').get()).toMatchObject({ total: 1 });
    expect(database.prepare('SELECT chatId, direction, body, payloadJson FROM whatsapp_messages').get()).toMatchObject({ chatId: '5511999990000@c.us', direction: 'inbound', body: 'Olá', payloadJson: expect.stringContaining('[REDACTED]') });
  });
  it('rejects unsigned requests before reading the event', async () => { const app = await appFor(); await request(app).post('/api/v1/webhooks/waha').send({}).expect(401).expect(response => expect(response.body.error.code).toBe('UNAUTHORIZED')); });
  it('keeps separate WAHA events for the same message without duplicating the message', async () => {
    const app = await appFor(); const base = { timestamp: Date.now(), session: 'waha-a', payload: { id: 'message-1', chatId: '5511999990000@c.us', body: 'Olá' } };
    for (const body of [{ ...base, id: 'evt-message', event: 'message' }, { ...base, id: 'evt-message-any', event: 'message.any' }]) { const requestBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202); }
    const database = app.locals.persistenceDatabase.sqlite; expect(database.prepare('SELECT count(*) AS total FROM waha_webhook_events').get()).toMatchObject({ total: 2 }); expect(database.prepare('SELECT count(*) AS total FROM whatsapp_messages').get()).toMatchObject({ total: 1 });
  });
});
