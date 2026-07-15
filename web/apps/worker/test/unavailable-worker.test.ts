import { describe, expect, it } from 'vitest';
import { UnavailableWhatsAppWorkerAdapter } from '../src/unavailable-whatsapp-worker.adapter.js';
describe('UnavailableWhatsAppWorkerAdapter', () => { it('returns a typed service-unavailable error', async () => { const adapter = new UnavailableWhatsAppWorkerAdapter(); await expect(adapter.execute({ userId: 'user', workspaceId: 'workspace', correlationId: 'correlation' }, { type: 'disconnectSession', sessionId: 'session' })).rejects.toMatchObject({ response: { error: { code: 'SERVICE_UNAVAILABLE', correlationId: 'correlation' } } }); }); });
