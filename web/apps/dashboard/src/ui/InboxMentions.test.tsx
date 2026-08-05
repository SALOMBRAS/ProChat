import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupParticipant, InboxApi, InboxConversation, InboxMessage } from '../api/inbox.js';
import Inbox from './Inbox.js';

vi.mock('../api/realtime.js', () => ({ connectRealtime: () => () => undefined }));
vi.mock('./InboxKanban.js', () => ({ InboxKanban: () => <div>Kanban operacional</div> }));

const participants: GroupParticipant[] = [
  { whatsappId: '5511999990001@c.us', name: 'Ana', phone: '5511999990001', role: 'admin', avatarUrl: null, lastActiveAt: null },
  { whatsappId: '100000000000001@lid', name: 'Bruno', phone: null, role: null, avatarUrl: null, lastActiveAt: null },
];
const conversation = (id: string, chatId: string, conversationType: 'direct' | 'group' = 'group') => ({ id, whatsappSessionId: 'session-a', chatId, contactId: null, conversationType, status: 'open', lastMessage: null, lastMessageAt: '2026-07-16T18:00:00.000Z', unreadCount: 0, createdAt: '2026-07-16T18:00:00.000Z', updatedAt: '2026-07-16T18:00:00.000Z' }) as unknown as InboxConversation;
const page = (items: unknown[]) => ({ items, page: 1, pageSize: 50, total: items.length });
const message = (over: Partial<InboxMessage>) => ({ id: 'message-a', direction: 'inbound', content: 'oi', timestamp: '2026-07-16T18:00:00.000Z', status: 'received', messageType: 'text', chatId: '120363363444637332@g.us', metadata: {}, ...over }) as unknown as InboxMessage;

const apiFor = (item: InboxConversation, messages: InboxMessage[] = []) => ({
  conversations: vi.fn().mockResolvedValue(page([item])),
  messages: vi.fn().mockResolvedValue(page(messages)),
  sendMessage: vi.fn().mockResolvedValue(message({ id: 'sent-a', direction: 'outbound' })),
  markRead: vi.fn().mockResolvedValue(undefined),
  participants: vi.fn().mockResolvedValue({ items: participants }),
}) as unknown as InboxApi & { sendMessage: ReturnType<typeof vi.fn>; participants: ReturnType<typeof vi.fn> };

const openGroup = async (api: InboxApi, item: InboxConversation, messages: InboxMessage[] = []) => {
  render(<Inbox api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`Abrir conversa ${item.chatId}`) }));
  await waitFor(() => expect((api as never as { messages: ReturnType<typeof vi.fn> }).messages).toHaveBeenCalledWith(item.id, 1, 50));
  return screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
};
const typeText = (textarea: HTMLTextAreaElement, value: string) => {
  fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
};

const mentionOptions = async () => within(await screen.findByRole('listbox')).findAllByRole('option');
afterEach(() => history.replaceState({}, '', '/inbox'));

describe('Inbox group mentions', () => {
  it('opens the participant list on @ and filters it by name', async () => {
    const item = conversation('conversation-a', '120363363444637332@g.us');
    const api = apiFor(item);
    const textarea = await openGroup(api, item);
    await waitFor(() => expect(api.participants).toHaveBeenCalledWith(item.id));
    typeText(textarea, '@');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(2);
    typeText(textarea, '@An');
    expect(within(listbox).getAllByRole('option')).toHaveLength(1);
    expect(within(listbox).getByRole('option', { name: /Ana/ })).toBeInTheDocument();
  });
  it('navigates with arrows and selects with Enter, inserting the display name', async () => {
    const item = conversation('conversation-a', '120363363444637332@g.us');
    const api = apiFor(item);
    const textarea = await openGroup(api, item);
    typeText(textarea, 'oi @');
    await mentionOptions();
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(textarea.value).toBe('oi @Bruno '));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
  it('selects with Tab and with a mouse click', async () => {
    const item = conversation('conversation-a', '120363363444637332@g.us');
    const api = apiFor(item);
    const textarea = await openGroup(api, item);
    typeText(textarea, '@An');
    await mentionOptions();
    fireEvent.keyDown(textarea, { key: 'Tab' });
    await waitFor(() => expect(textarea.value).toBe('@Ana '));
    // Let the cursor-reposition animation frame from the first selection run
    // before typing again, so the next caret read is the one we set.
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    typeText(textarea, '@Ana e @Br');
    const option = await screen.findByRole('option', { name: /Bruno/ });
    fireEvent.mouseDown(option);
    await waitFor(() => expect(textarea.value).toBe('@Ana e @Bruno '));
  });
  it('closes on Escape without changing the text and never opens on direct conversations', async () => {
    const item = conversation('conversation-a', '120363363444637332@g.us');
    const api = apiFor(item);
    const textarea = await openGroup(api, item);
    typeText(textarea, 'oi @');
    await mentionOptions();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textarea.value).toBe('oi @');
  });
  it('does not open the popup on a direct conversation', async () => {
    const item = conversation('conversation-b', '5511999990000@c.us', 'direct');
    const api = apiFor(item);
    const textarea = await openGroup(api, item);
    typeText(textarea, 'oi @');
    await waitFor(() => expect(textarea.value).toBe('oi @'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(api.participants).not.toHaveBeenCalled();
  });
  it('serializes tracked mentions into WAHA @digits on submit', async () => {
    const item = conversation('conversation-a', '120363363444637332@g.us');
    const api = apiFor(item);
    const textarea = await openGroup(api, item);
    typeText(textarea, 'oi @');
    await mentionOptions();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(textarea.value).toBe('oi @Ana '));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(item.id, 'oi @5511999990001', ['5511999990001@c.us']));
  });
  it('omits mentions whose display text was deleted before submitting', async () => {
    const item = conversation('conversation-a', '120363363444637332@g.us');
    const api = apiFor(item);
    const textarea = await openGroup(api, item);
    typeText(textarea, '@');
    await mentionOptions();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(textarea.value).toBe('@Ana '));
    typeText(textarea, 'mensagem sem menção');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(item.id, 'mensagem sem menção'));
  });
  it('highlights received and sent mentions with the participant name', async () => {
    const item = conversation('conversation-a', '120363363444637332@g.us');
    const received = message({ id: 'received-a', content: '@100000000000001 viu isso?', metadata: { _data: { mentionedJidList: ['100000000000001@lid'] } } });
    const sent = message({ id: 'sent-a', direction: 'outbound', content: 'vi sim @5511999990001', metadata: { mentions: ['5511999990001@c.us'] } });
    const api = apiFor(item, [received, sent]);
    await openGroup(api, item, [received, sent]);
    const highlights = await screen.findAllByText(/@Ana|@Bruno/);
    const mentionTexts = highlights.filter((node) => node.className.includes('message-mention')).map((node) => node.textContent);
    expect(mentionTexts).toEqual(['@Bruno', '@Ana']);
  });
});
