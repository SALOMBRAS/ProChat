import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallService } from '../src/services/call.service.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pairedSession = { sessions: [{ id: 's-1', name: 'ChatPro', jid: '558592369359:4@s.whatsapp.net', state: 'open', paired: true }] };

afterEach(() => fetchMock.mockReset());

describe('CallService — uma ligação por instância', () => {
  it('a segunda ligação simultânea recebe 409 sem criar nova chamada', async () => {
    const service = new CallService({ baseUrl: 'http://127.0.0.1:8080', ownWhatsappNumbers: [] });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/sessions')) return jsonResponse(pairedSession);
      if (url.includes('/calls')) return jsonResponse({ call: { callId: 'call-1' } });
      throw new Error(`unexpected ${url}`);
    });

    const first = await service.startCall({ phone: '558585263532' });
    expect(first.callId).toBe('call-1');
    const callCreationsBefore = fetchMock.mock.calls.filter(([, { method }]) => method === 'POST').length;
    await expect(service.startCall({ phone: '558585263532' })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    const callCreationsAfter = fetchMock.mock.calls.filter(([, { method }]) => method === 'POST').length;
    expect(callCreationsAfter).toBe(callCreationsBefore);
  });
});
