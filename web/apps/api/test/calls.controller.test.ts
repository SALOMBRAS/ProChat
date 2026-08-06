import { describe, expect, it, vi } from 'vitest';
import { CallsController } from '../src/controllers/calls.controller.js';

const conversationId = '10000000-0000-4000-8000-000000000001';

const build = (conversation: unknown) => {
  const conversations = { getConversation: vi.fn().mockResolvedValue(conversation), callPeerNames: vi.fn().mockResolvedValue(new Map()) };
  const calls = {
    startCall: vi.fn().mockResolvedValue({ callId: 'call-1', sessionId: 's-1', direction: 'outbound', peer: 'x', status: 'ringing', startedAt: 1 }),
    callHistory: vi.fn().mockResolvedValue([]),
  };
  const controller = new CallsController(conversations as never, calls as never);
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const req = { body: { conversationId }, context: { workspaceId: 'workspace-a' }, params: {} };
  return { controller, res, req, calls, conversations };
};

const directConversation = (chatId: string, phone: string | null) => ({
  id: conversationId,
  workspaceId: 'workspace-a',
  chatId,
  conversationType: 'direct',
  identity: { phone },
});

describe('CallsController.start — escolha do endereço de discagem', () => {
  it('conversa @c.us disca pelos dígitos do chatId, mesmo com identity.phone sujo (LID)', async () => {
    const { controller, req, res, calls } = build(directConversation('558585263532@c.us', '153073372647624'));
    await controller.start(req as never, res as never, vi.fn());
    expect(calls.startCall).toHaveBeenCalledWith({ phone: '558585263532' });
  });

  it('conversa @lid com telefone curado real disca pelo telefone', async () => {
    const { controller, req, res, calls } = build(directConversation('153073372647624@lid', '558585263532'));
    await controller.start(req as never, res as never, vi.fn());
    expect(calls.startCall).toHaveBeenCalledWith({ phone: '558585263532' });
  });

  it('conversa @lid com identity.phone igual ao LID disca pelo LID (não é telefone)', async () => {
    const { controller, req, res, calls } = build(directConversation('153073372647624@lid', '153073372647624'));
    await controller.start(req as never, res as never, vi.fn());
    expect(calls.startCall).toHaveBeenCalledWith({ lid: '153073372647624' });
  });

  it('conversa @lid sem telefone disca pelo LID', async () => {
    const { controller, req, res, calls } = build(directConversation('153073372647624@lid', null));
    await controller.start(req as never, res as never, vi.fn());
    expect(calls.startCall).toHaveBeenCalledWith({ lid: '153073372647624' });
  });

  it('histórico filtra as chamadas da conversa pelo chatId e pelo telefone curado', async () => {
    const { controller, res, calls } = build(directConversation('558585263532@c.us', '153073372647624'));
    calls.callHistory.mockResolvedValue([
      { callId: 'a', sessionId: 's', direction: 'outbound', peer: '558585263532@s.whatsapp.net', startedAt: 1, status: 'ended', recording: true },
      { callId: 'b', sessionId: 's', direction: 'inbound', peer: '153073372647624@lid', startedAt: 2, status: 'ended', endReason: 'user_ended' },
      { callId: 'c', sessionId: 's', direction: 'outbound', peer: '5511999999999@s.whatsapp.net', startedAt: 3, status: 'ended', recording: true },
    ]);
    const req = { query: { conversationId }, context: { workspaceId: 'workspace-a' }, params: {} };
    await controller.history(req as never, res as never, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ calls: [
      expect.objectContaining({ callId: 'a', recording: true }),
      expect.objectContaining({ callId: 'b', recording: false, endReason: 'user_ended' }),
    ] });
  });

  it('histórico global enriquece com nome do contato e esconde dígitos de LID', async () => {
    const { controller, res, calls, conversations } = build(null);
    calls.callHistory.mockResolvedValue([
      { callId: 'a', sessionId: 's', direction: 'outbound', peer: '558585263532@s.whatsapp.net', startedAt: 1, status: 'ended', recording: true },
      { callId: 'b', sessionId: 's', direction: 'inbound', peer: '153073372647624@lid', startedAt: 2, status: 'ended' },
    ]);
    conversations.callPeerNames.mockResolvedValue(new Map([['558585263532@c.us', 'Sal'], ['153073372647624@lid', 'Sal LID']]));
    const req = { query: {}, context: { workspaceId: 'workspace-a' }, params: {} };
    await controller.history(req as never, res as never, vi.fn());
    expect(conversations.callPeerNames).toHaveBeenCalledWith('workspace-a', ['558585263532@c.us', '153073372647624@lid']);
    expect(res.json).toHaveBeenCalledWith({ calls: [
      expect.objectContaining({ callId: 'a', contactName: 'Sal', phone: '558585263532', recording: true }),
      expect.objectContaining({ callId: 'b', contactName: 'Sal LID', phone: null, recording: false }),
    ] });
  });

  it('grupo segue recusado com 409', async () => {
    const { controller, req, res } = build({ ...directConversation('120363012345678901@g.us', null), conversationType: 'group' });
    await expect(controller.start(req as never, res as never, vi.fn())).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });
});
