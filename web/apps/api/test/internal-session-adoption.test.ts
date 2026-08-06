import { describe, expect, it, vi } from 'vitest';
import type { InternalWorkerClient } from '../src/internal-worker-client.js';
import { InternalSessionService } from '../src/services/internal-session.service.js';

const context = { workspaceId: 'workspace-a', correlationId: 'corr-a', userId: 'user-a' };

const makeService = (sessions: unknown[], send?: ReturnType<typeof vi.fn>) => {
  const worker = {
    send: send ?? vi.fn().mockResolvedValue({ success: true, data: { sessions } }),
  } as unknown as InternalWorkerClient;
  return { service: new InternalSessionService(worker), worker };
};

describe('InternalSessionService — adoção por número', () => {
  it('registra no worker os nomes históricos do mesmo telefone como aliases da sessão viva', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { sessions: [{ id: 'session-a', workspaceId: 'workspace-a', name: 'Principal', status: 'connected', updatedAt: 'now', wahaName: 'chatpro-novo', aliases: [], managed: true, phone: '5585999990000' }] } })
      .mockResolvedValueOnce({ success: true, data: { completed: true } });
    const { service } = makeService([], send);
    service.sessionPhoneHistory = async () => new Map([['5585999990000', ['chatpro-novo', 'chatpro-antigo']]]);

    const sessions = await service.list(context as never);

    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: { type: 'session.mergeAliases', payload: { sessionId: 'session-a', aliases: ['chatpro-antigo'] } } }));
    expect(sessions[0]).toMatchObject({ aliases: ['chatpro-antigo'] });
  });

  it('não chama o worker quando o histórico não traz nome novo', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, data: { sessions: [{ id: 'session-a', workspaceId: 'workspace-a', name: 'Principal', status: 'connected', updatedAt: 'now', wahaName: 'chatpro-novo', aliases: ['chatpro-antigo'], managed: true, phone: '5585999990000' }] } });
    const { service } = makeService([], send);
    service.sessionPhoneHistory = async () => new Map([['5585999990000', ['chatpro-novo', 'chatpro-antigo']]]);

    await service.list(context as never);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sessão sem telefone aprendido não dispara adoção', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, data: { sessions: [{ id: 'session-a', workspaceId: 'workspace-a', name: 'Principal', status: 'waiting_qr', updatedAt: 'now', wahaName: 'chatpro-novo', managed: true }] } });
    const { service } = makeService([], send);
    service.sessionPhoneHistory = async () => new Map([['5585999990000', ['chatpro-antigo']]]);

    await service.list(context as never);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('falha na descoberta não derruba a listagem', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, data: { sessions: [{ id: 'session-a', workspaceId: 'workspace-a', name: 'Principal', status: 'connected', updatedAt: 'now', wahaName: 'chatpro-novo', managed: true, phone: '5585999990000' }] } });
    const { service } = makeService([], send);
    service.sessionPhoneHistory = async () => { throw new Error('store down'); };

    const sessions = await service.list(context as never);

    expect(sessions).toHaveLength(1);
  });
});
