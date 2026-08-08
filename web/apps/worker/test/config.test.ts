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
    expect(() => loadWorkerConfig({ WHATSAPP_PROVIDER: 'other' })).toThrow('WHATSAPP_PROVIDER must be baileys, gowa or waha');
  });
  it('keeps GOWA disabled unless it is explicitly selected and enabled', () => {
    const defaultConfig = loadWorkerConfig({});
    expect(defaultConfig.gowaEnabled).toBe(false);
    expect(defaultConfig.whatsAppProvider).toBe('baileys');
    expect(loadWorkerConfig({ GOWA_ENABLED: 'true', GOWA_BASE_URL: 'http://gowa.test/' })).toMatchObject({ gowaEnabled: true, gowaBaseUrl: 'http://gowa.test' });
    expect(() => loadWorkerConfig({ WHATSAPP_PROVIDER: 'gowa' })).toThrow('GOWA_ENABLED must be true when WHATSAPP_PROVIDER is gowa');
    expect(loadWorkerConfig({ WHATSAPP_PROVIDER: 'gowa', GOWA_ENABLED: 'true' }).whatsAppProvider).toBe('gowa');
    expect(() => loadWorkerConfig({ GOWA_ENABLED: 'yes' })).toThrow('GOWA_ENABLED must be true or false');
  });

  it('requires both GOWA Basic Auth values when either is configured', () => {
    expect(() => loadWorkerConfig({ GOWA_BASIC_AUTH_USERNAME: 'operator' })).toThrow('GOWA Basic Auth requires both');
    expect(loadWorkerConfig({ GOWA_BASIC_AUTH_USERNAME: 'operator', GOWA_BASIC_AUTH_PASSWORD: 'secret' })).toMatchObject({ gowaBasicAuthUsername: 'operator', gowaBasicAuthPassword: 'secret' });
  });
});
