import { describe, expect, it } from 'vitest';
import { AttachmentOutboxService, type AttachmentOutboxStore, type OutboxJob, type TemporaryAttachmentStorage } from '../src/services/attachment-outbox.service.js';

const context = { workspaceId: 'workspace-a', correlationId: 'attachment-test' };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
class MemoryStore implements AttachmentOutboxStore {
  jobs = new Map<string, OutboxJob>();
  async create(job: OutboxJob) { this.jobs.set(`${job.workspaceId}:${job.id}`, job); return job; }
  async get(workspaceId: string, id: string) { return this.jobs.get(`${workspaceId}:${id}`); }
  async update(workspaceId: string, id: string, changes: Partial<OutboxJob>) { const current = await this.get(workspaceId, id); if (!current) return undefined; const job = { ...current, ...changes, updatedAt: new Date().toISOString() }; this.jobs.set(`${workspaceId}:${id}`, job); return job; }
  async confirm(workspaceId: string, externalMessageId: string) { const job = [...this.jobs.values()].find(item => item.workspaceId === workspaceId && item.externalMessageId === externalMessageId && item.status === 'sent'); return job ? this.update(workspaceId, job.id, { status: 'confirmed' }) : undefined; }
  async expired() { return []; }
}
class MemoryStorage implements TemporaryAttachmentStorage { paths: string[] = []; removed: string[] = []; async upload(path: string) { this.paths.push(path); } async signedUrl(path: string) { return `https://storage.example.test/${encodeURIComponent(path)}`; } async remove(path: string) { this.removed.push(path); } }
const conversation = { getConversation: async (workspaceId: string, id: string) => workspaceId === 'workspace-a' && id === '00000000-0000-4000-8000-000000000001' ? { id, whatsappSessionId: 'waha-a', chatId: '5511999999999@c.us' } : undefined };
const worker = { send: async () => ({ success: true as const, correlationId: 'attachment-test', workspaceId: 'workspace-a', data: { sentMessage: { id: 'waha-file-a', timestamp: new Date().toISOString() } } }) };
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('AttachmentOutboxService', () => {
  it('stores an allowed private upload, dispatches it, and waits for webhook confirmation', async () => { const store = new MemoryStore(), storage = new MemoryStorage(); const service = new AttachmentOutboxService(conversation, store, storage, worker as never); const job = await service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: '../../photo.jpg', mimetype: 'image/jpeg', size: jpeg.length }, 'foto'); expect(storage.paths[0]).toMatch(/^workspace-a\/00000000-0000-4000-8000-000000000001\//); expect(storage.paths[0]).not.toContain('..'); await flush(); expect((await service.get(context, job.id)).status).toBe('sent'); await service.confirm('workspace-a', 'waha-file-a'); expect((await service.get(context, job.id)).status).toBe('confirmed'); expect(storage.removed).toHaveLength(1); });
  it('rejects blocked MIME types and oversized files before storage', async () => { const storage = new MemoryStorage(); const service = new AttachmentOutboxService(conversation, new MemoryStore(), storage, worker as never); await expect(service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: Buffer.from('MZ'), originalname: 'run.exe', mimetype: 'application/octet-stream', size: 2 })).rejects.toMatchObject({ status: 400 }); await expect(service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: 'big.jpg', mimetype: 'image/jpeg', size: 16 * 1024 * 1024 })).rejects.toMatchObject({ status: 400 }); expect(storage.paths).toEqual([]); });
  it('isolates jobs by workspace and removes a cancelled temporary object', async () => { const storage = new MemoryStorage(); const service = new AttachmentOutboxService(conversation, new MemoryStore(), storage, worker as never); const job = await service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: 'photo.jpg', mimetype: 'image/jpeg', size: jpeg.length }); await expect(service.get({ ...context, workspaceId: 'workspace-b' }, job.id)).rejects.toMatchObject({ status: 404 }); expect((await service.cancel(context, job.id)).status).toBe('cancelled'); expect(storage.removed).toHaveLength(1); });
});
