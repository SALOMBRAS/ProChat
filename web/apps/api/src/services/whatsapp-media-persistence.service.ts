import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '../errors.js';

export const WHATSAPP_MEDIA_BUCKET = 'chatpro-whatsapp-media';
export type PersistableMedia = { workspaceId: string; externalMessageId: string; url: string; mimeType: string | null; filename: string | null };
export interface WhatsAppMediaPersistenceStore { persistMedia(input: { workspaceId: string; externalMessageId: string; storagePath: string; checksum: string; size: number; mimeType: string; filename: string }): Promise<void>; pendingMedia(limit: number): Promise<PersistableMedia[]>; markMediaUnavailable(workspaceId: string, externalMessageId: string): Promise<void>; }

export class SupabaseWhatsAppMediaStorage {
  constructor(private readonly client: SupabaseClient, private readonly bucket = WHATSAPP_MEDIA_BUCKET) {}
  async upload(path: string, content: Buffer, mimeType: string) {
    const { error } = await this.client.storage.from(this.bucket).upload(path, content, { contentType: mimeType, upsert: false });
    // A deterministic checksum path may already exist after a retry; it is safe
    // to reuse it because the checksum was calculated from this exact buffer.
    if (error && !/already exists|duplicate/i.test(error.message)) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Permanent media storage is unavailable');
  }
  async signedUrl(path: string, expiresInSeconds = 300) {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(path, expiresInSeconds);
    if (error || !data?.signedUrl) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Permanent media storage is unavailable');
    return data.signedUrl;
  }
}

export class WhatsAppMediaPersistenceService {
  constructor(private readonly store: WhatsAppMediaPersistenceStore, private readonly storage?: SupabaseWhatsAppMediaStorage, private readonly options: { baseUrl?: string; apiKey?: string; fetchImpl?: typeof fetch } = {}) {}
  get enabled() { return Boolean(this.storage && this.options.baseUrl && this.options.apiKey); }
  async persist(input: PersistableMedia): Promise<boolean> {
    if (!this.enabled) return false;
    const target = this.validTarget(input.url);
    let response: Response;
    try { response = await (this.options.fetchImpl ?? fetch)(target, { headers: { 'x-api-key': this.options.apiKey! } }); } catch { return false; }
    if (response.status === 404) { await this.store.markMediaUnavailable(input.workspaceId, input.externalMessageId); return false; }
    if (!response.ok) return false;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 50 * 1024 * 1024) return false;
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0] || input.mimeType || 'application/octet-stream';
    const checksum = createHash('sha256').update(buffer).digest('hex'); const filename = safeFilename(input.filename, mimeType);
    const path = `${safeSegment(input.workspaceId)}/${checksum}/${filename}`;
    await this.storage!.upload(path, buffer, mimeType);
    await this.store.persistMedia({ workspaceId: input.workspaceId, externalMessageId: input.externalMessageId, storagePath: path, checksum, size: buffer.length, mimeType, filename });
    return true;
  }
  async importPending(limit = 100) { let imported = 0; for (const media of await this.store.pendingMedia(limit)) if (await this.persist(media)) imported++; return imported; }
  private validTarget(value: string) { const target = new URL(value); const base = new URL(this.options.baseUrl!); if (target.origin !== base.origin || !target.pathname.startsWith('/api/files/')) throw new AppError(400, 'VALIDATION_ERROR', 'Media URL is not a WAHA file URL'); return target; }
}
function safeSegment(value: string) { return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'workspace'; }
function safeFilename(value: string | null, mime: string) { const source = value ?? (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'attachment'); const name = source.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 180); return name || 'attachment'; }
