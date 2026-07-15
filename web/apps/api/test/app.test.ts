import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
describe('API foundation', () => {
  it('returns health without development context', async () => { const response = await request(createApp()).get('/health').expect(200); expect(response.body).toEqual({ name: 'ChatPro API', status: 'ok', version: '0.1.0' }); });
  it('requires temporary workspace context for v1 routes', async () => { const response = await request(createApp()).get('/api/v1/sessions').expect(401); expect(response.body.error.code).toBe('UNAUTHORIZED'); expect(response.body.error.correlationId).toBeTruthy(); });
  it('returns standard not-implemented error after valid context', async () => { const response = await request(createApp()).get('/api/v1/sessions').set('x-workspace-id','workspace-a').set('x-user-id','user-a').expect(501); expect(response.body.error.code).toBe('NOT_IMPLEMENTED'); });
  it('validates create-session body before migration adapter', async () => { const response = await request(createApp()).post('/api/v1/sessions').set('x-workspace-id','workspace-a').set('x-user-id','user-a').send({}).expect(400); expect(response.body.error.code).toBe('VALIDATION_ERROR'); });
});
