import { describe, expect, it, vi } from 'vitest';
import { DemoWhatsAppWorkerAdapter } from '../src/demo-whatsapp-worker.adapter.js';

const context = { workspaceId: 'demo-workspace', correlationId: 'test-correlation' };
const command = (type: 'createSession' | 'connectSession' | 'disconnectSession' | 'logoutSession' | 'removeSession' | 'getSession' | 'getQr', sessionId = 'demo-session') => type === 'createSession' ? { type, sessionId, input: { name: 'Demonstração' } } : { type, sessionId };

describe('DemoWhatsAppWorkerAdapter', () => {
  it('is empty on creation and never persists sessions across adapter restarts', async () => {
    const adapter = new DemoWhatsAppWorkerAdapter();
    expect(await adapter.execute(context, { type: 'listSessions' })).toEqual([]);
    await adapter.execute(context, command('createSession'));
    adapter.shutdown();
    expect(await new DemoWhatsAppWorkerAdapter().execute(context, { type: 'listSessions' })).toEqual([]);
  });

  it('creates an isolated fictitious session and simulates the complete lifecycle without external calls', async () => {
    vi.useFakeTimers();
    const adapter = new DemoWhatsAppWorkerAdapter();
    await adapter.execute(context, command('createSession'));
    await adapter.execute({ ...context, workspaceId: 'real-workspace' }, command('createSession'));
    expect((await adapter.execute(context, { type: 'listSessions' }) as unknown[]).length).toBe(1);
    await adapter.execute(context, command('connectSession'));
    expect((await adapter.execute(context, command('getSession')) as { status: string }).status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(350);
    expect((await adapter.execute(context, command('getSession')) as { status: string }).status).toBe('waiting_qr');
    const qr = await adapter.execute(context, command('getQr')) as { qr: string };
    expect(qr.qr).toContain('CHATPRO_DEMONSTRACAO_SEM_CREDENCIAL');
    expect(qr.qr).not.toMatch(/whatsapp|credential|auth/i);
    await adapter.execute(context, command('connectSession'));
    expect((await adapter.execute(context, command('getSession')) as { status: string }).status).toBe('connected');
    await expect(adapter.execute(context, command('getQr'))).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
    await adapter.execute(context, command('disconnectSession'));
    expect((await adapter.execute(context, command('getSession')) as { status: string }).status).toBe('stopped');
    await adapter.execute(context, command('logoutSession'));
    expect((await adapter.execute(context, command('getSession')) as { status: string }).status).toBe('disconnected');
    await adapter.execute(context, command('removeSession'));
    await expect(adapter.execute(context, command('getSession'))).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
    vi.useRealTimers();
  });

  it('clears a pending QR on stop and does not retain timers', async () => {
    vi.useFakeTimers();
    const adapter = new DemoWhatsAppWorkerAdapter();
    await adapter.execute(context, command('createSession'));
    await adapter.execute(context, command('connectSession'));
    await adapter.execute(context, command('disconnectSession'));
    await vi.advanceTimersByTimeAsync(350);
    expect((await adapter.execute(context, command('getSession')) as { status: string }).status).toBe('stopped');
    await expect(adapter.execute(context, command('getQr'))).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
    vi.useRealTimers();
  });
});
