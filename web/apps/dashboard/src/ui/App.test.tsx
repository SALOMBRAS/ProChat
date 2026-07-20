import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session, SessionsApi } from '../api/sessions';
import type { InboxApi } from '../api/inbox';
import { Devices, Inbox } from './App';

const realtime = vi.hoisted(() => ({ handler: undefined as undefined | ((event: any) => void) }));
vi.mock('../api/realtime.js', () => ({ connectRealtime: (handler: (event: any) => void) => { realtime.handler = handler; return () => undefined; } }));

const waiting: Session = { id: 'session-a', name: 'Atendimento', status: 'waiting_qr', updatedAt: '2026-07-16T18:00:00.000Z' };
const connected: Session = { ...waiting, status: 'connected' };

describe('Devices', () => {
  it('consults status before QR and stops when WAHA is already connected', async () => {
    const api = { list: vi.fn().mockResolvedValue([waiting]), status: vi.fn().mockResolvedValue(connected), qr: vi.fn() } as unknown as SessionsApi;
    render(<Devices api={api} />);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(api.qr).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not request or display a QR for a connected session', async () => {
    const api = { list: vi.fn().mockResolvedValue([connected]), status: vi.fn(), qr: vi.fn() } as unknown as SessionsApi;
    render(<Devices api={api} />);
    expect(await screen.findByText('connected')).toBeInTheDocument();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.qr).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not reopen the QR modal after a manual close while status is unchanged', async () => {
    const api = { list: vi.fn().mockResolvedValue([waiting]), status: vi.fn().mockResolvedValue(waiting), qr: vi.fn().mockResolvedValue({ sessionId: waiting.id, qr: 'temporary-qr', expiresAt: new Date(Date.now() + 60_000).toISOString() }) } as unknown as SessionsApi;
    render(<Devices api={api} />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.qr).toHaveBeenCalledTimes(1);
  });
});

describe('Inbox', () => {
  const conversation = (id: string, chatId: string, conversationType: 'direct' | 'group' = 'direct') => ({ id, whatsappSessionId: 'session-a', chatId, contactId: null, conversationType, status: 'open' as const, lastMessage: null, lastMessageAt: '2026-07-16T18:00:00.000Z', unreadCount: 0, createdAt: '2026-07-16T18:00:00.000Z', updatedAt: '2026-07-16T18:00:00.000Z' });
  const page = (items: any[]) => ({ items, page: 1, pageSize: 50, total: items.length });
  const emptyMessages = { items: [], page: 1, pageSize: 50, total: 0 };
  it('loads a selected conversation, marks it as read and displays the history', async () => {
    const api = {
      conversations: vi.fn().mockResolvedValue({ items: [{ id: 'conversation-a', whatsappSessionId: 'session-a', chatId: '5511999999999@c.us', contactId: null, status: 'open', lastMessage: 'Olá', lastMessageAt: '2026-07-16T18:00:00.000Z', unreadCount: 2 }], page: 1, pageSize: 50, total: 1 }),
      messages: vi.fn().mockResolvedValue({ items: [{ id: 'message-a', direction: 'inbound', content: 'Olá', timestamp: '2026-07-16T18:00:00.000Z', status: 'received', messageType: 'text', chatId: '5511999999999@c.us', metadata: {} }], page: 1, pageSize: 100, total: 1 }),
      sendMessage: vi.fn().mockResolvedValue({ id: 'message-b', direction: 'outbound', content: 'Resposta', timestamp: '2026-07-16T18:01:00.000Z', status: 'sent', messageType: 'text', chatId: '5511999999999@c.us', metadata: {} }),
      markRead: vi.fn().mockResolvedValue(undefined),
    } as unknown as InboxApi;
    render(<Inbox api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir conversa 5511999999999@c.us' }));
    expect(await screen.findByText(/Recebida/)).toBeInTheDocument();
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith('conversation-a'));
    expect(api.messages).toHaveBeenCalledWith('conversation-a', 1, 50);
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem' }), { target: { value: 'Resposta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith('conversation-a', 'Resposta'));
  });
  it('labels a group and shows each message author', async () => {
    const api = {
      conversations: vi.fn().mockResolvedValue({ items: [{ id: 'conversation-group', whatsappSessionId: 'session-a', chatId: '120363363444637332@g.us', contactId: null, conversationType: 'group', status: 'open', lastMessage: 'Vamos sair?', lastMessageAt: '2026-07-16T18:00:00.000Z', unreadCount: 0, createdAt: '2026-07-16T18:00:00.000Z', updatedAt: '2026-07-16T18:00:00.000Z' }], page: 1, pageSize: 50, total: 1 }),
      messages: vi.fn().mockResolvedValue({ items: [{ id: 'group-message-a', direction: 'inbound', content: 'Bom dia', timestamp: '2026-07-16T18:00:00.000Z', status: 'received', messageType: 'text', chatId: '120363363444637332@g.us', senderWhatsappId: '5511999999999@c.us', metadata: {} }, { id: 'group-message-b', direction: 'inbound', content: 'Vamos sair?', timestamp: '2026-07-16T18:01:00.000Z', status: 'received', messageType: 'text', chatId: '120363363444637332@g.us', senderWhatsappId: '5511888888888@c.us', metadata: {} }], page: 1, pageSize: 100, total: 2 }),
      sendMessage: vi.fn(), markRead: vi.fn(),
    } as unknown as InboxApi;
    render(<Inbox api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir conversa 120363363444637332@g.us' }));
    expect(await screen.findByRole('heading', { name: 'Grupo WhatsApp', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('5511999999999:')).toBeInTheDocument();
    expect(screen.getByText('5511888888888:')).toBeInTheDocument();
  });

  it('does not show a late context response from conversation A in conversation B', async () => {
    let resolveA!: (value: any) => void;
    const contextA = new Promise(resolve => { resolveA = resolve; });
    const a = conversation('conversation-a', '5511999999999@c.us'); const b = conversation('conversation-b', '120363363444637332@g.us', 'group');
    const api = { conversations: vi.fn().mockResolvedValue(page([a, b])), messages: vi.fn().mockResolvedValue(emptyMessages), sendMessage: vi.fn(), markRead: vi.fn(), context: vi.fn((id: string) => id === a.id ? contextA : Promise.resolve({ notes: 'Nota de B', tags: [], firstInteractionAt: '2026-07-16T18:00:00.000Z', lastInteractionAt: '2026-07-16T18:00:00.000Z' })), updateContext: vi.fn() } as unknown as InboxApi;
    render(<Inbox api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir conversa 5511999999999@c.us' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abrir conversa 120363363444637332@g.us' }));
    expect(await screen.findByDisplayValue('Nota de B')).toBeInTheDocument();
    await act(async () => { resolveA({ notes: 'Nota de A', tags: ['VIP'], firstInteractionAt: '2026-07-16T18:00:00.000Z', lastInteractionAt: '2026-07-16T18:00:00.000Z' }); });
    expect(screen.getByRole('textbox', { name: 'Observação interna' })).toHaveValue('Nota de B');
    expect(screen.queryByText(/VIP/)).not.toBeInTheDocument();
  });

  it('cancels a pending note autosave when the selected conversation changes', async () => {
    const a = conversation('conversation-a', '5511999999999@c.us'); const b = conversation('conversation-b', '5511888888888@c.us');
    const api = { conversations: vi.fn().mockResolvedValue(page([a, b])), messages: vi.fn().mockResolvedValue(emptyMessages), sendMessage: vi.fn(), markRead: vi.fn(), context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: '2026-07-16T18:00:00.000Z', lastInteractionAt: '2026-07-16T18:00:00.000Z' }), updateContext: vi.fn() } as unknown as InboxApi;
    render(<Inbox api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir conversa 5511999999999@c.us' }));
    await screen.findByRole('textbox', { name: 'Observação interna' });
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByRole('textbox', { name: 'Observação interna' }), { target: { value: 'Nota A' } });
      fireEvent.click(screen.getByRole('button', { name: 'Abrir conversa 5511888888888@c.us' }));
      await act(async () => { vi.advanceTimersByTime(700); });
      expect(api.updateContext).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('ignores a realtime context event for a conversation other than the open one', async () => {
    const a = conversation('conversation-a', '5511999999999@c.us'); const b = conversation('conversation-b', '5511888888888@c.us');
    const api = { conversations: vi.fn().mockResolvedValue(page([a, b])), messages: vi.fn().mockResolvedValue(emptyMessages), sendMessage: vi.fn(), markRead: vi.fn(), context: vi.fn().mockResolvedValue({ notes: 'Nota', tags: [], firstInteractionAt: '2026-07-16T18:00:00.000Z', lastInteractionAt: '2026-07-16T18:00:00.000Z' }), updateContext: vi.fn() } as unknown as InboxApi;
    render(<Inbox api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir conversa 5511888888888@c.us' }));
    await screen.findByDisplayValue('Nota'); const callsBefore = (api.context as any).mock.calls.length;
    act(() => realtime.handler?.({ eventType: 'conversation.context.updated', payload: { conversationId: a.id } }));
    expect((api.context as any).mock.calls).toHaveLength(callsBefore);
  });

  it('keeps the visible history sync status scoped to its WAHA session', async () => {
    const a = conversation('conversation-a', '5511999999999@c.us');
    const syncJob = { id: 'job-a', jobId: 'job-a', wahaSession: 'session-a', status: 'running' as const, chatsProcessed: 1, messagesProcessed: 20, currentChat: '5511999999999@c.us', hasMore: true, progressLabel: 'Sincronizando histórico…', lastErrorSafe: null, updatedAt: '2026-07-16T18:00:00.000Z' };
    const api = { conversations: vi.fn().mockResolvedValue(page([a])), messages: vi.fn().mockResolvedValue(emptyMessages), sendMessage: vi.fn(), markRead: vi.fn(), syncStatus: vi.fn().mockResolvedValue(syncJob), startSync: vi.fn(), cancelSync: vi.fn() } as unknown as InboxApi;
    render(<Inbox api={api} />);
    expect(await screen.findByText(/Sincronizando histórico/)).toBeInTheDocument();
    act(() => realtime.handler?.({ eventType: 'conversation.sync.updated', payload: { wahaSession: 'session-b', status: 'completed', chatsProcessed: 99, messagesProcessed: 99, progressLabel: 'Histórico sincronizado.' } }));
    expect(screen.getByText(/Sincronizando histórico/)).toBeInTheDocument();
    expect(screen.queryByText(/99 conversas/)).not.toBeInTheDocument();
  });
});
