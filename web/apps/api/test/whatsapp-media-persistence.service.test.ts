import { describe, expect, it, vi } from 'vitest';
import { SupabaseWhatsAppMediaStorage, WhatsAppMediaPersistenceService, type WhatsAppMediaPersistenceStore } from '../src/services/whatsapp-media-persistence.service.js';

const source = 'http://waha.test/api/files/media.bin';
const store = (): WhatsAppMediaPersistenceStore & { saved: Array<Record<string, unknown>>; unavailable: string[] } => ({ saved: [], unavailable: [], persistMedia: async input => { result.saved.push(input); }, pendingMedia: async () => [], markMediaUnavailable: async (_workspace, id) => { result.unavailable.push(id); } });
let result: ReturnType<typeof store>;
const storage = (upload = vi.fn().mockResolvedValue({ error: null })) => new SupabaseWhatsAppMediaStorage({ storage: { from: () => ({ upload, createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.test/signed' }, error: null }) }) } } as never);

describe('WhatsAppMediaPersistenceService', () => {
  it.each(['image/jpeg', 'video/mp4', 'application/pdf', 'audio/ogg', 'image/webp'])('persists %s with a deterministic checksum path', async mimeType => {
    result = store(); const upload = vi.fn().mockResolvedValue({ error: null }); const service = new WhatsAppMediaPersistenceService(result, storage(upload), { baseUrl: 'http://waha.test', apiKey: 'key', fetchImpl: vi.fn().mockResolvedValue(new Response('permanent-media', { headers: { 'content-type': mimeType } })) });
    await expect(service.persist({ workspaceId: 'workspace-a', externalMessageId: mimeType, url: source, mimeType, filename: 'file name.bin' })).resolves.toBe(true);
    expect(result.saved).toHaveLength(1); expect(result.saved[0]).toMatchObject({ workspaceId: 'workspace-a', externalMessageId: mimeType, mimeType, filename: 'file-name.bin', size: 15, checksum: expect.stringMatching(/^[a-f0-9]{64}$/), storagePath: expect.stringMatching(/^workspace-a\/[a-f0-9]{64}\/file-name\.bin$/) });
  });

  it('keeps the message and marks only missing historical media unavailable', async () => {
    result = store(); const service = new WhatsAppMediaPersistenceService(result, storage(), { baseUrl: 'http://waha.test', apiKey: 'key', fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 404 })) });
    await expect(service.persist({ workspaceId: 'workspace-a', externalMessageId: 'old', url: source, mimeType: null, filename: null })).resolves.toBe(false);
    expect(result.unavailable).toEqual(['old']); expect(result.saved).toHaveLength(0);
  });

  it('serves a new private signed URL after a previous URL expires', async () => {
    const signed = vi.fn().mockResolvedValueOnce({ data: { signedUrl: 'https://storage.test/old' }, error: null }).mockResolvedValueOnce({ data: { signedUrl: 'https://storage.test/new' }, error: null }); const permanent = new SupabaseWhatsAppMediaStorage({ storage: { from: () => ({ createSignedUrl: signed }) } } as never);
    await expect(permanent.signedUrl('workspace-a/checksum/file')).resolves.toBe('https://storage.test/old'); await expect(permanent.signedUrl('workspace-a/checksum/file')).resolves.toBe('https://storage.test/new');
  });
});
