import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';

describe('worker configuration', () => {
  it('keeps demo mode disabled by default and validates its explicit flag', () => {
    expect(loadWorkerConfig({}).demoMode).toBe(false);
    expect(loadWorkerConfig({ WHATSAPP_DEMO_MODE: 'true' }).demoMode).toBe(true);
    expect(() => loadWorkerConfig({ WHATSAPP_DEMO_MODE: 'yes' })).toThrow('WHATSAPP_DEMO_MODE must be true or false');
  });
});
