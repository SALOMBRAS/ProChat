import { vi } from 'vitest';
import type { GowaClientPort } from '../../src/gowa-client.js';

/**
 * One stub for every GOWA client test. Centralised on purpose: when the port
 * grows, the compiler points here instead of at each suite, and no test can
 * silently keep passing against a method the real client no longer has.
 */
export function gowaClientStub(overrides: Partial<GowaClientPort> = {}): GowaClientPort {
  return {
    health: vi.fn().mockResolvedValue(undefined),
    createDevice: vi.fn().mockResolvedValue({ id: 'internal-device', state: 'disconnected' }),
    listDevices: vi.fn().mockResolvedValue([{ id: 'internal-device', state: 'disconnected' }]),
    getSessionStatus: vi.fn().mockResolvedValue({ isConnected: false, isLoggedIn: false }),
    startLogin: vi.fn().mockResolvedValue({ qrLink: 'http://gowa.test/scan-qr.png', qrDurationSeconds: 60 }),
    fetchQrImage: vi.fn().mockResolvedValue('data:image/png;base64,cXItYnl0ZXM='),
    logout: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    removeDevice: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ id: 'gowa-message-a' }),
    sendMedia: vi.fn().mockResolvedValue({ id: 'gowa-media-a' }),
    sendLocation: vi.fn().mockResolvedValue({ id: 'gowa-location-a' }),
    sendContact: vi.fn().mockResolvedValue({ id: 'gowa-contact-a' }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    listContacts: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    getAvatar: vi.fn().mockResolvedValue(null),
    listChats: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listMessages: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    getGroupInfo: vi.fn().mockResolvedValue({}),
    getGroupParticipants: vi.fn().mockResolvedValue([]),
    downloadMedia: vi.fn().mockResolvedValue({ fileUrl: null, filename: null, mediaType: null, fileSize: null }),
    ...overrides,
  };
}
