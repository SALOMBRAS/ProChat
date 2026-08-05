import { describe, expect, it } from 'vitest';
import { internalTransportRequestSchema, internalTransportResponseSchema } from '../src/index.js';

describe('internal transport contracts', () => {
  it('validates a controlled command with correlation and workspace isolation', () => {
    const result = internalTransportRequestSchema.parse({ correlationId: 'corr-a', workspaceId: 'workspace-a', timeoutMs: 500, command: { type: 'transport.ping', payload: { message: 'hello' } } });
    expect(result.workspaceId).toBe('workspace-a');
  });
  it('validates both typed response variants', () => {
    expect(internalTransportResponseSchema.safeParse({ success: true, correlationId: 'corr-a', workspaceId: 'workspace-a', data: { message: 'hello' } }).success).toBe(true);
    expect(internalTransportResponseSchema.safeParse({ success: false, correlationId: 'corr-a', workspaceId: 'workspace-a', error: { code: 'SERVICE_UNAVAILABLE', message: 'offline' } }).success).toBe(true);
  });
  it('accepts a reaction command, including the empty string that removes it', () => {
    const command = (reaction: string) => ({ correlationId: 'corr-a', workspaceId: 'workspace-a', timeoutMs: 500, command: { type: 'message.sendReaction', payload: { wahaSession: 'session-a', chatId: '1@c.us', messageId: 'false_1@c.us_A1', reaction } } });
    expect(internalTransportRequestSchema.safeParse(command('👍')).success).toBe(true);
    expect(internalTransportRequestSchema.safeParse(command('')).success).toBe(true);
    expect(internalTransportRequestSchema.safeParse(command('x'.repeat(33))).success).toBe(false);
    expect(internalTransportResponseSchema.safeParse({ success: true, correlationId: 'corr-a', workspaceId: 'workspace-a', data: { reactionSent: { timestamp: new Date().toISOString() } } }).success).toBe(true);
  });
  it('accepts mentions on message.send only as WhatsApp JIDs, and stays optional', () => {
    const command = (mentions: unknown) => ({ correlationId: 'corr-a', workspaceId: 'workspace-a', timeoutMs: 500, command: { type: 'message.send', payload: { wahaSession: 'session-a', chatId: '1@g.us', text: 'olá @5511999990001', ...(mentions === undefined ? {} : { mentions }) } } });
    // Ausente: conversas sem menção seguem como antes.
    expect(internalTransportRequestSchema.safeParse(command(undefined)).success).toBe(true);
    // Válidos: @c.us e @lid são primeira classe.
    expect(internalTransportRequestSchema.safeParse(command(['5511999990001@c.us'])).success).toBe(true);
    expect(internalTransportRequestSchema.safeParse(command(['5511999990001@c.us', '123456789012345@lid'])).success).toBe(true);
    // Inválidos: @g.us não é pessoa, texto solto não é JID, array gigante estoura o teto.
    expect(internalTransportRequestSchema.safeParse(command(['120363@g.us'])).success).toBe(false);
    expect(internalTransportRequestSchema.safeParse(command(['Ada'])).success).toBe(false);
    expect(internalTransportRequestSchema.safeParse(command(Array.from({ length: 51 }, (_, index) => `551199999${String(index).padStart(4, '0')}@c.us`))).success).toBe(false);
  });
  it('accepts a contacts page command and its paginated response', () => {
    const command = (offset: unknown, limit: unknown) => ({ correlationId: 'corr-a', workspaceId: 'workspace-a', timeoutMs: 500, command: { type: 'contacts.page', payload: { wahaSession: 'session-a', offset, limit } } });
    expect(internalTransportRequestSchema.safeParse(command(0, 100)).success).toBe(true);
    expect(internalTransportRequestSchema.safeParse(command(200, 1)).success).toBe(true);
    expect(internalTransportRequestSchema.safeParse(command(-1, 100)).success).toBe(false);
    expect(internalTransportRequestSchema.safeParse(command(0, 0)).success).toBe(false);
    expect(internalTransportRequestSchema.safeParse(command(0, 101)).success).toBe(false);
    expect(internalTransportResponseSchema.safeParse({ success: true, correlationId: 'corr-a', workspaceId: 'workspace-a', data: { contactsPage: { items: [{ id: '1@c.us', number: '5511999990001', name: 'Ada' }], unsupported: [], hasMore: true } } }).success).toBe(true);
    expect(internalTransportResponseSchema.safeParse({ success: true, correlationId: 'corr-a', workspaceId: 'workspace-a', data: { contactsPage: { items: [], unsupported: [], hasMore: false } } }).success).toBe(true);
  });
});
