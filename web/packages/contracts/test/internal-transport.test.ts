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
  it('accepts optional group mention JIDs on message.send', () => {
    const base = { correlationId: 'corr-a', workspaceId: 'workspace-a', timeoutMs: 500 };
    const withMentions = internalTransportRequestSchema.safeParse({ ...base, command: { type: 'message.send', payload: { wahaSession: 'waha-a', chatId: '120363363444637332@g.us', text: 'oi @5511999990001', mentions: ['5511999990001@c.us', '100000000000001@lid'] } } });
    expect(withMentions.success).toBe(true);
    const withoutMentions = internalTransportRequestSchema.safeParse({ ...base, command: { type: 'message.send', payload: { wahaSession: 'waha-a', chatId: '120363363444637332@g.us', text: 'oi' } } });
    expect(withoutMentions.success).toBe(true);
  });
  it('rejects malformed mention JIDs on message.send', () => {
    const base = { correlationId: 'corr-a', workspaceId: 'workspace-a', timeoutMs: 500, command: { type: 'message.send', payload: { wahaSession: 'waha-a', chatId: '120363363444637332@g.us', text: 'oi @1' } } };
    expect(internalTransportRequestSchema.safeParse({ ...base, command: { ...base.command, payload: { ...base.command.payload, mentions: ['not-a-jid'] } } }).success).toBe(false);
    expect(internalTransportRequestSchema.safeParse({ ...base, command: { ...base.command, payload: { ...base.command.payload, mentions: ['123@g.us'] } } }).success).toBe(false);
    expect(internalTransportRequestSchema.safeParse({ ...base, command: { ...base.command, payload: { ...base.command.payload, mentions: ['12345@c.us'] } } }).success).toBe(false);
  });
});
