import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';

describe('worker configuration', () => {
  it('keeps demo mode disabled by default and validates its explicit flag', () => {
    expect(loadWorkerConfig({}).demoMode).toBe(false);
    expect(loadWorkerConfig({ WHATSAPP_DEMO_MODE: 'true' }).demoMode).toBe(true);
    expect(() => loadWorkerConfig({ WHATSAPP_DEMO_MODE: 'yes' })).toThrow('WHATSAPP_DEMO_MODE must be true or false');
  });
  it('selects WAHA explicitly and rejects an invalid provider', () => {
    expect(loadWorkerConfig({ WHATSAPP_PROVIDER: 'waha' }).whatsAppProvider).toBe('waha');
    expect(() => loadWorkerConfig({ WHATSAPP_PROVIDER: 'other' })).toThrow('WHATSAPP_PROVIDER must be baileys or waha');
  });
});
