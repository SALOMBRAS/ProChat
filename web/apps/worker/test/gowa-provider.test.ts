import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@chatpro/contracts';
import { GowaClientError, GowaHttpClient, type GowaClientPort } from '../src/gowa-client.js';
import { GowaProvider } from '../src/gowa-provider.js';

const context: RequestContext = { userId: 'user-a', workspaceId: 'workspace-a', correlationId: 'correlation-a' };
const image = 'data:image/png;base64,cXItYnl0ZXM=';

function client(overrides: Partial<GowaClientPort> = {}): GowaClientPort {
  return {
    health: vi.fn().mockResolvedValue(undefined),
    createDevice: vi.fn().mockResolvedValue({ id: 'internal-device', state: 'disconnected' }),
    listDevices: vi.fn().mockResolvedValue([{ id: 'internal-device', state: 'disconnected' }]),
    getSessionStatus: vi.fn().mockResolvedValue({ isConnected: false, isLoggedIn: false }),
    startLogin: vi.fn().mockResolvedValue({ qrLink: 'http://gowa.test/scan-qr.png', qrDurationSeconds: 60 }),
    fetchQrImage: vi.fn().mockResolvedValue(image),
    logout: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ id: 'gowa-message-a' }),
    ...overrides,
  };
}

describe('GOWA provider session lifecycle', () => {
  it('creates a session, requests an internal QR image and logs out without exposing GOWA identifiers', async () => {
    const api = client();
    const provider = new GowaProvider(api);
    const created = await provider.execute(context, { type: 'createSession', sessionId: 'session-a', input: { name: 'Atendimento' } });
    expect(created).toMatchObject({ id: 'session-a', name: 'Atendimento', status: 'disconnected' });
    expect(created).not.toHaveProperty('deviceId');
    expect(api.createDevice).toHaveBeenCalledWith(expect.stringMatching(/^chatpro-gowa-[a-f0-9]{40}$/));

    await provider.execute(context, { type: 'connectSession', sessionId: 'session-a' });
    const qr = await provider.execute(context, { type: 'getQr', sessionId: 'session-a' });
    expect(qr).toMatchObject({ sessionId: 'session-a', workspaceId: 'workspace-a', qr: image });
    expect(String((qr as { qr: string }).qr)).not.toContain('internal-device');

    await provider.execute(context, { type: 'logoutSession', sessionId: 'session-a' });
    expect(api.logout).toHaveBeenCalledOnce();
  });

  it('turns an unknown remote device state into a safe error status', async () => {
    let deviceId = '';
    const api = client({
      createDevice: vi.fn().mockImplementation(async id => { deviceId = id; return { id, state: 'disconnected' }; }),
      listDevices: vi.fn().mockImplementation(async () => [{ id: deviceId, state: 'mystery' }]),
    });
    const provider = new GowaProvider(api);
    await provider.execute(context, { type: 'createSession', sessionId: 'session-a', input: {} });
    const sessions = await provider.execute(context, { type: 'listSessions' });
    expect(sessions).toMatchObject([{ id: 'session-a', status: 'error' }]);
  });

  it('reports an unavailable GOWA server without leaking its remote error details', async () => {
    const provider = new GowaProvider(client({ createDevice: vi.fn().mockRejectedValue(new GowaClientError('unavailable')) }));
    await expect(provider.execute(context, { type: 'createSession', sessionId: 'session-a', input: {} })).rejects.toMatchObject({ response: { error: { code: 'SERVICE_UNAVAILABLE', details: {} } } });
  });

  it('sends text through the standard worker command using the mapped GOWA device', async () => {
    const api = client({ getSessionStatus: vi.fn().mockResolvedValue({ isConnected: true, isLoggedIn: true }) });
    const provider = new GowaProvider(api);
    await provider.execute(context, { type: 'createSession', sessionId: 'session-a', input: {} });
    await expect(provider.execute(context, { type: 'sendMessage', wahaSession: 'session-a', chatId: '5511999999999@c.us', text: 'Olá' })).resolves.toMatchObject({ id: 'gowa-message-a', pending: false });
    expect(api.sendText).toHaveBeenCalledWith(expect.stringMatching(/^chatpro-gowa-[a-f0-9]{40}$/), '5511999999999', 'Olá');
  });

  it('maps GOWA HTTP and timeout failures to the existing worker error contract', async () => {
    const unavailable = new GowaProvider(client({ getSessionStatus: vi.fn().mockResolvedValue({ isConnected: true, isLoggedIn: true }), sendText: vi.fn().mockRejectedValue(new GowaClientError('response', 502)) }));
    await unavailable.execute(context, { type: 'createSession', sessionId: 'session-a', input: {} });
    await expect(unavailable.execute(context, { type: 'sendMessage', wahaSession: 'session-a', chatId: '5511999999999@c.us', text: 'Olá' })).rejects.toMatchObject({ response: { error: { code: 'SERVICE_UNAVAILABLE' } } });

    const timeout = new GowaProvider(client({ getSessionStatus: vi.fn().mockResolvedValue({ isConnected: true, isLoggedIn: true }), sendText: vi.fn().mockRejectedValue(new GowaClientError('timeout')) }));
    await timeout.execute(context, { type: 'createSession', sessionId: 'session-a', input: {} });
    await expect(timeout.execute(context, { type: 'sendMessage', wahaSession: 'session-a', chatId: '5511999999999@c.us', text: 'Olá' })).rejects.toMatchObject({ response: { error: { code: 'TIMEOUT' } } });
  });

  it('refuses a missing session and a session from another workspace', async () => {
    const api = client({ getSessionStatus: vi.fn().mockResolvedValue({ isConnected: true, isLoggedIn: true }) });
    const provider = new GowaProvider(api);
    await provider.execute(context, { type: 'createSession', sessionId: 'session-a', input: {} });
    await expect(provider.execute(context, { type: 'sendMessage', wahaSession: 'missing-session', chatId: '5511999999999@c.us', text: 'Olá' })).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
    await expect(provider.execute({ ...context, workspaceId: 'workspace-b' }, { type: 'sendMessage', wahaSession: 'session-a', chatId: '5511999999999@c.us', text: 'Olá' })).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
  });
});

describe('GOWA HTTP client', () => {
  it('uses documented device lifecycle endpoints and converts its QR image to data-only output', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'SUCCESS', results: { id: 'device-a', state: 'disconnected' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'SUCCESS', results: [{ id: 'device-a', state: 'disconnected' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'SUCCESS', results: { is_connected: false, is_logged_in: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'SUCCESS', results: { qr_link: 'http://gowa.test/scan-qr.png', qr_duration: 60 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([113, 114]), { status: 200, headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'SUCCESS', results: null }), { status: 200 }));
    const http = new GowaHttpClient({ baseUrl: 'http://gowa.test/', timeoutMs: 1_000, fetchImpl: fetcher });
    await http.createDevice('device-a'); await http.listDevices(); await http.getSessionStatus('device-a');
    const login = await http.startLogin('device-a'); await expect(http.fetchQrImage(login.qrLink)).resolves.toBe('data:image/png;base64,cXI='); await http.logout('device-a');
    expect(fetcher.mock.calls.map(call => [String(call[0]), call[1]?.method])).toEqual([
      ['http://gowa.test/devices', 'POST'], ['http://gowa.test/devices', 'GET'], ['http://gowa.test/devices/device-a/status', 'GET'], ['http://gowa.test/devices/device-a/login', 'GET'], ['http://gowa.test/scan-qr.png', 'GET'], ['http://gowa.test/devices/device-a/logout', 'POST'],
    ]);
  });

  it('uses the device-scoped GOWA text endpoint and documented Basic Auth when configured', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'SUCCESS', results: { message_id: 'gowa-message-a', status: 'sent' } }), { status: 200 }));
    const http = new GowaHttpClient({ baseUrl: 'http://gowa.test', basicAuthUsername: 'operator', basicAuthPassword: 'secret', timeoutMs: 1_000, fetchImpl: fetcher });
    await expect(http.sendText('device-a', '5511999999999', 'Olá')).resolves.toEqual({ id: 'gowa-message-a' });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://gowa.test/send/message');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ phone: '5511999999999', message: 'Olá' }) });
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-device-id')).toBe('device-a');
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('operator:secret').toString('base64')}`);
  });

  it('reports an invalid GOWA response and connection refusal as typed errors', async () => {
    const invalid = new GowaHttpClient({ baseUrl: 'http://gowa.test', timeoutMs: 1_000, fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'SUCCESS', results: [{ id: 7 }] }), { status: 200 })) });
    await expect(invalid.listDevices()).rejects.toMatchObject({ kind: 'contract' });
    const unavailable = new GowaHttpClient({ baseUrl: 'http://gowa.test', timeoutMs: 1_000, fetchImpl: vi.fn().mockRejectedValue(new TypeError('connection refused')) });
    await expect(unavailable.health()).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
