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
});
