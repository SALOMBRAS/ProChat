import { describe, expect, it } from 'vitest';
import { AttachmentOutboxService, type AttachmentOutboxStore, type OutboxJob, type TemporaryAttachmentStorage } from '../src/services/attachment-outbox.service.js';
import { AppError } from '../src/errors.js';

const context = { workspaceId: 'workspace-a', correlationId: 'attachment-test' };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const pdf = Buffer.from('%PDF-1.7');
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const mp4 = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]);
const mp3 = Buffer.from('ID3\u0003\u0000\u0000\u0000');
class MemoryStore implements AttachmentOutboxStore {
  jobs = new Map<string, OutboxJob>();
  async create(job: OutboxJob) { if ([...this.jobs.values()].some(item => item.workspaceId === job.workspaceId && item.clientRequestId === job.clientRequestId)) throw new Error('unique constraint'); this.jobs.set(`${job.workspaceId}:${job.id}`, job); return job; }
  async get(workspaceId: string, id: string) { return this.jobs.get(`${workspaceId}:${id}`); }
  async findByClientRequest(workspaceId: string, clientRequestId: string) { return [...this.jobs.values()].find(job => job.workspaceId === workspaceId && job.clientRequestId === clientRequestId); }
  async claim(workspaceId: string, id: string) { const current = await this.get(workspaceId, id); if (!current || current.status !== 'pending') return undefined; return this.update(workspaceId, id, { status: 'processing', attemptCount: current.attemptCount + 1 }); }
  async update(workspaceId: string, id: string, changes: Partial<OutboxJob>) { const current = await this.get(workspaceId, id); if (!current) return undefined; const job = { ...current, ...changes, updatedAt: new Date().toISOString() }; this.jobs.set(`${workspaceId}:${id}`, job); return job; }
  async confirm(workspaceId: string, externalMessageId: string) { const job = [...this.jobs.values()].find(item => item.workspaceId === workspaceId && item.externalMessageId === externalMessageId && item.status === 'sent'); return job ? this.update(workspaceId, job.id, { status: 'confirmed' }) : undefined; }
  async staleUnreconciled(before: string) { return [...this.jobs.values()].filter(job => ['pending', 'processing'].includes(job.status) && job.createdAt < before && !job.externalMessageId && !job.providerAcceptedAt); }
  async expired() { return []; }
}
class MemoryStorage implements TemporaryAttachmentStorage { paths: string[] = []; removed: string[] = []; async upload(path: string) { this.paths.push(path); } async signedUrl(path: string) { return `https://storage.example.test/${encodeURIComponent(path)}`; } async remove(path: string) { this.removed.push(path); } }
const conversation = { getConversation: async (workspaceId: string, id: string) => workspaceId === 'workspace-a' && id === '00000000-0000-4000-8000-000000000001' ? { id, whatsappSessionId: 'waha-a', chatId: '5511999999999@c.us' } : undefined };
const worker = { send: async () => ({ success: true as const, correlationId: 'attachment-test', workspaceId: 'workspace-a', data: { sentMessage: { id: 'waha-file-a', timestamp: new Date().toISOString() } } }) };
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('AttachmentOutboxService', () => {
  it('stores an allowed private upload, dispatches it, and waits for webhook confirmation', async () => { const store = new MemoryStore(), storage = new MemoryStorage(); const service = new AttachmentOutboxService(conversation, store, storage, worker as never); const job = await service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: '../../photo.jpg', mimetype: 'image/jpeg', size: jpeg.length }, '00000000-0000-4000-8000-000000000010', 'foto'); expect(storage.paths[0]).toMatch(/^workspace-a\/00000000-0000-4000-8000-000000000001\//); expect(storage.paths[0]).not.toContain('..'); await flush(); expect((await service.get(context, job.id)).status).toBe('sent'); await service.confirm('workspace-a', 'waha-file-a'); expect((await service.get(context, job.id)).status).toBe('confirmed'); expect(storage.removed).toHaveLength(1); });
  it('rejects oversized files before storage', async () => { const storage = new MemoryStorage(); const service = new AttachmentOutboxService(conversation, new MemoryStore(), storage, worker as never); await expect(service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: 'big.jpg', mimetype: 'image/jpeg', size: 16 * 1024 * 1024 }, '00000000-0000-4000-8000-000000000012')).rejects.toMatchObject({ status: 413, message: 'Arquivo excede o limite permitido' }); expect(storage.paths).toEqual([]); });
  it('accepts PDF, ZIP and MP4 as their correct media kinds', async () => { const service = new AttachmentOutboxService(conversation, new MemoryStore(), new MemoryStorage(), worker as never); const conversationId = '00000000-0000-4000-8000-000000000001'; await expect(service.create(context, conversationId, { buffer: pdf, originalname: 'invoice.pdf', mimetype: 'application/pdf', size: pdf.length }, '00000000-0000-4000-8000-000000000016')).resolves.toMatchObject({ type: 'document' }); await expect(service.create(context, conversationId, { buffer: zip, originalname: 'archive.zip', mimetype: 'application/zip', size: zip.length }, '00000000-0000-4000-8000-000000000017')).resolves.toMatchObject({ type: 'document' }); await expect(service.create(context, conversationId, { buffer: mp4, originalname: 'clip.mp4', mimetype: 'video/mp4', size: mp4.length }, '00000000-0000-4000-8000-000000000018')).resolves.toMatchObject({ type: 'video' }); });
  it('returns a safe 503 on temporary storage failure without dispatching', async () => { const store = new MemoryStore(); const storage: TemporaryAttachmentStorage = { upload: async () => { throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Temporary attachment storage is unavailable'); }, signedUrl: async () => '', remove: async () => undefined }; let calls = 0; const service = new AttachmentOutboxService(conversation, store, storage, { send: async () => { calls += 1; return { success: true, correlationId: context.correlationId, workspaceId: context.workspaceId, data: {} }; } } as never); await expect(service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: 'photo.jpg', mimetype: 'image/jpeg', size: jpeg.length }, '00000000-0000-4000-8000-000000000019')).rejects.toMatchObject({ status: 503 }); expect(calls).toBe(0); expect([...store.jobs.values()][0]).toMatchObject({ status: 'failed', lastErrorSafe: 'Temporary upload failed' }); });
  it('isolates jobs by workspace and removes a cancelled temporary object', async () => { const storage = new MemoryStorage(); const service = new AttachmentOutboxService(conversation, new MemoryStore(), storage, worker as never); const job = await service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: 'photo.jpg', mimetype: 'image/jpeg', size: jpeg.length }, '00000000-0000-4000-8000-000000000013'); await expect(service.get({ ...context, workspaceId: 'workspace-b' }, job.id)).rejects.toMatchObject({ status: 404 }); expect((await service.cancel(context, job.id)).status).toBe('cancelled'); expect(storage.removed).toHaveLength(1); });
  it('claims one job once even when dispatch is triggered concurrently', async () => { const store = new MemoryStore(), storage = new MemoryStorage(); let calls = 0; const service = new AttachmentOutboxService(conversation, store, storage, { send: async () => { calls += 1; return { success: true, correlationId: context.correlationId, workspaceId: context.workspaceId, data: { sentMessage: {} } }; } } as never); const requestId = '00000000-0000-4000-8000-000000000014'; const [first, second] = await Promise.all([service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: 'photo.jpg', mimetype: 'image/jpeg', size: jpeg.length }, requestId), service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: 'photo.jpg', mimetype: 'image/jpeg', size: jpeg.length }, requestId)]); expect(first.id).toBe(second.id); await flush(); expect(calls).toBe(1); expect((await service.get(context, first.id)).providerAcceptedAt).not.toBeNull(); });
  it('does not retry an attachment after an uncertain worker failure', async () => { const store = new MemoryStore(), storage = new MemoryStorage(); let calls = 0; const service = new AttachmentOutboxService(conversation, store, storage, { send: async () => { calls += 1; return { success: false, correlationId: context.correlationId, workspaceId: context.workspaceId, error: { code: 'TIMEOUT', message: 'timeout', details: {} } }; } } as never); const job = await service.create(context, '00000000-0000-4000-8000-000000000001', { buffer: jpeg, originalname: 'photo.jpg', mimetype: 'image/jpeg', size: jpeg.length }, '00000000-0000-4000-8000-000000000015'); await flush(); expect(calls).toBe(1); await new Promise(resolve => setTimeout(resolve, 20)); expect(calls).toBe(1); expect((await service.get(context, job.id)).status).toBe('failed'); });
  it('reconciles old pending and processing rows without calling the worker', async () => { const store = new MemoryStore(), storage = new MemoryStorage(); const createdAt = '2020-01-01T00:00:00.000Z'; const base: OutboxJob = { id: 'old-pending', workspaceId: context.workspaceId, conversationId: '00000000-0000-4000-8000-000000000001', wahaSession: 'waha-a', clientRequestId: 'old-pending', type: 'image', storageObjectPath: 'old/pending.jpg', filename: 'pending.jpg', mimeType: 'image/jpeg', sizeBytes: 1, caption: null, status: 'pending', attemptCount: 0, externalMessageId: null, providerAcceptedAt: null, lastErrorSafe: null, createdAt, updatedAt: createdAt }; await store.create(base); await store.create({ ...base, id: 'old-processing', clientRequestId: 'old-processing', status: 'processing' }); await store.create({ ...base, id: 'already-sent', clientRequestId: 'already-sent', status: 'sent', externalMessageId: 'provider-id', providerAcceptedAt: createdAt }); let calls = 0; const service = new AttachmentOutboxService(conversation, store, storage, { send: async () => { calls += 1; return { success: true, correlationId: context.correlationId, workspaceId: context.workspaceId, data: {} }; } } as never); await expect(service.reconcileStartup()).resolves.toBe(2); expect(calls).toBe(0); await expect(service.get(context, 'old-pending')).resolves.toMatchObject({ status: 'cancelled', lastErrorSafe: 'stale_unverified_job' }); await expect(service.get(context, 'old-processing')).resolves.toMatchObject({ status: 'failed', lastErrorSafe: 'provider_acceptance_uncertain' }); await expect(service.get(context, 'already-sent')).resolves.toMatchObject({ status: 'sent' }); });
});

/** The operator's intent is the only thing that separates a voice note from a
 *  music file: both are `audio`, both may be `audio/mpeg`, and the file is what
 *  the outbox stores either way. These pin that the intent reaches the worker
 *  command and that it does NOT become part of the row — the row's `type` is
 *  mirrored by a CHECK constraint in both databases, so keeping it at `audio` is
 *  what lets this ship without a migration. */
describe('AttachmentOutboxService audio intent', () => {
  const conversationId = '00000000-0000-4000-8000-000000000001';
  const audio = { buffer: mp3, originalname: 'musica.mp3', mimetype: 'audio/mpeg', size: mp3.length };
  const capture = () => { const sent: Record<string, unknown>[] = []; return { sent, worker: { send: async (request: { command: { payload: Record<string, unknown> } }) => { sent.push(request.command.payload); return { success: true as const, correlationId: context.correlationId, workspaceId: context.workspaceId, data: { sentMessage: { id: 'waha-audio-a', timestamp: new Date().toISOString() } } }; } } }; };

  it('carries an explicit music-file intent to the worker while the stored kind stays audio', async () => {
    const { sent, worker: spy } = capture(); const store = new MemoryStore();
    const service = new AttachmentOutboxService(conversation, store, new MemoryStorage(), spy as never);
    const job = await service.create(context, conversationId, audio, '00000000-0000-4000-8000-000000000020', undefined, false);
    await flush();
    expect(sent[0]).toMatchObject({ type: 'audio', voiceNote: false });
    expect(job.type).toBe('audio');
    expect(Object.keys(store.jobs.get(`${context.workspaceId}:${job.id}`)!)).not.toContain('voiceNote');
  });

  it('says nothing when the caller states no intent, so the recorder keeps the behaviour it had', async () => {
    const { sent, worker: spy } = capture();
    const service = new AttachmentOutboxService(conversation, new MemoryStore(), new MemoryStorage(), spy as never);
    await service.create(context, conversationId, audio, '00000000-0000-4000-8000-000000000021');
    await flush();
    expect(sent[0]).toMatchObject({ type: 'audio' });
    expect(sent[0]).not.toHaveProperty('voiceNote');
  });

  it('carries an explicit voice-note intent as well, so the default is never the only way to get one', async () => {
    const { sent, worker: spy } = capture();
    const service = new AttachmentOutboxService(conversation, new MemoryStore(), new MemoryStorage(), spy as never);
    await service.create(context, conversationId, audio, '00000000-0000-4000-8000-000000000022', undefined, true);
    await flush();
    expect(sent[0]).toMatchObject({ voiceNote: true });
  });
});

/** Documento é o coringa: qualquer formato até 50 MB, paridade com o WhatsApp.
 *  Assinatura conhecida é conferida; desconhecida passa. */
describe('AttachmentOutboxService document policy', () => {
  const conversationId = '00000000-0000-4000-8000-000000000001';
  let request = 0;
  const id = () => `00000000-0000-4000-8000-${String(++request + 100).padStart(12, '0')}`;
  const service = () => new AttachmentOutboxService(conversation, new MemoryStore(), new MemoryStorage(), worker as never);

  it.each([
    ['rar4 ok', Buffer.from('Rar!\x1a\x07\x00'), 'application/vnd.rar', true],
    ['rar errado', Buffer.from('PK\x03\x04'), 'application/vnd.rar', false],
    ['rar5 ok', Buffer.from('Rar!\x1a\x07\x01\x00'), 'application/x-rar-compressed', true],
    ['7z ok', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), 'application/x-7z-compressed', true],
    ['7z errado', Buffer.from('Rar!\x1a\x07'), 'application/x-7z-compressed', false],
    ['psd ok', Buffer.from('8BPS\x00\x01'), 'image/vnd.adobe.photoshop', true],
    ['psd errado', Buffer.from('8BIM\x00\x01'), 'image/vnd.adobe.photoshop', false],
    ['ole2 doc ok', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'application/msword', true],
    ['ole2 xls errado', Buffer.from('%PDF-1.7'), 'application/vnd.ms-excel', false],
    ['apk zip ok', Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/vnd.android.package-archive', true],
    ['apk errado', Buffer.from('MZ'), 'application/vnd.android.package-archive', false],
    ['epub ok', Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/epub+zip', true],
    ['pdf ok', Buffer.from('%PDF-1.7'), 'application/pdf', true],
    ['pdf errado', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'application/pdf', false],
    ['ai %!PS', Buffer.from('%!PS-Adobe-3.0'), 'application/postscript', true],
    ['ai %PDF-', Buffer.from('%PDF-1.5'), 'application/postscript', true],
    ['ai errado', Buffer.from([0x50, 0x4b]), 'application/postscript', false],
    ['csv texto', Buffer.from('a;b;c\n1;2;3'), 'text/csv', true],
    ['csv com NUL', Buffer.from([0x61, 0x00, 0x62]), 'text/csv', false],
    ['svg ok', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', true],
  ])('magic bytes: %s', async (_label, buffer, mimetype, ok) => {
    const outcome = service().create(context, conversationId, { buffer, originalname: 'arquivo.bin', mimetype, size: buffer.length }, id());
    if (ok) await expect(outcome).resolves.toMatchObject({ type: 'document' });
    else await expect(outcome).rejects.toMatchObject({ status: 400, message: 'Arquivo inválido' });
  });

  it('aceita qualquer mime declarado como documento, até um executável', async () => {
    await expect(service().create(context, conversationId, { buffer: Buffer.from('MZ'), originalname: 'run.exe', mimetype: 'application/x-msdownload', size: 2 }, id())).resolves.toMatchObject({ type: 'document', mimeType: 'application/x-msdownload' });
    await expect(service().create(context, conversationId, { buffer: Buffer.from([0xde, 0xad]), originalname: 'desconhecido.xyz', mimetype: 'application/octet-stream', size: 2 }, id())).resolves.toMatchObject({ type: 'document' });
  });

  it('mantém o teto de 50 MB no documento coringa', async () => {
    const buffer = Buffer.from([0x50, 0x4b]);
    await expect(service().create(context, conversationId, { buffer, originalname: 'a.zip', mimetype: 'application/zip', size: 50 * 1024 * 1024 }, id())).resolves.toMatchObject({ type: 'document' });
    await expect(service().create(context, conversationId, { buffer, originalname: 'a.zip', mimetype: 'application/zip', size: 50 * 1024 * 1024 + 1 }, id())).rejects.toMatchObject({ status: 413 });
  });

  it.each([
    ['modelo.fig', 'application/octet-stream'],
    ['app.apk', 'application/vnd.android.package-archive'],
    ['notas.md', 'text/markdown'],
    ['sem-extensao', 'application/octet-stream'],
    ['planilha.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['livro.epub', 'application/epub+zip'],
  ])('mime canônico por extensão quando o navegador declara octet-stream: %s', async (originalname, mimeType) => {
    await expect(service().create(context, conversationId, { buffer: Buffer.from([0x00, 0x01]), originalname, mimetype: 'application/octet-stream', size: 2 }, id())).resolves.toMatchObject({ mimeType });
  });

  it('o declarado específico vence a extensão: relatorio.bin que é PDF chega como PDF', async () => {
    await expect(service().create(context, conversationId, { buffer: Buffer.from('%PDF-1.7'), originalname: 'relatorio.bin', mimetype: 'application/pdf', size: 8 }, id())).resolves.toMatchObject({ mimeType: 'application/pdf' });
  });
});
