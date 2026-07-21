import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { AppError } from '../errors.js';

export class WahaMediaProxyService {
  constructor(private readonly options: { baseUrl?: string; apiKey?: string; signingKey?: string; fetchImpl?: typeof fetch; now?: () => number } = {}) {}

  issueAccessToken(claims: { workspaceId: string; userId?: string; messageId: string }) {
    const expiresAt = Math.floor(this.now() / 1_000) + 300;
    const payload = Buffer.from(JSON.stringify({ ...claims, expiresAt })).toString('base64url');
    return { token: `${payload}.${this.sign(payload)}`, expiresAt: new Date(expiresAt * 1_000).toISOString() };
  }

  verifyAccessToken(token: string, messageId: string) {
    const [payload, signature, ...extra] = token.split('.');
    if (!payload || !signature || extra.length || !this.safeEqual(this.sign(payload), signature)) throw new AppError(401, 'UNAUTHORIZED', 'Media access token is invalid');
    let claims: { workspaceId?: unknown; userId?: unknown; messageId?: unknown; expiresAt?: unknown };
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new AppError(401, 'UNAUTHORIZED', 'Media access token is invalid'); }
    if (claims.messageId !== messageId || typeof claims.workspaceId !== 'string' || !claims.workspaceId || typeof claims.expiresAt !== 'number' || claims.expiresAt < Math.floor(this.now() / 1_000)) throw new AppError(401, 'UNAUTHORIZED', 'Media access token is invalid');
    return { workspaceId: claims.workspaceId, userId: typeof claims.userId === 'string' ? claims.userId : undefined };
  }

  async stream(url: string, fallbackMimeType: string | null, fallbackFilename: string | null, response: Response, request: { method?: string; range?: string } = {}): Promise<void> {
    if (!this.options.baseUrl || !this.options.apiKey) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'WAHA media access is not configured');
    const target = new URL(url); const base = new URL(this.options.baseUrl);
    if (target.origin !== base.origin || !target.pathname.startsWith('/api/files/')) throw new AppError(400, 'VALIDATION_ERROR', 'Media URL is not a WAHA file URL');
    let upstream: globalThis.Response;
    const headers: Record<string, string> = { 'x-api-key': this.options.apiKey }; if (request.range) headers.range = request.range;
    try { upstream = await (this.options.fetchImpl ?? fetch)(target, { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers }); }
    catch { throw new AppError(503, 'SERVICE_UNAVAILABLE', 'WAHA media service is unavailable'); }
    if (upstream.status === 404) throw new AppError(404, 'NOT_FOUND', 'Media file not found');
    if (upstream.status === 416) { response.status(416); for (const name of ['content-range', 'accept-ranges']) { const value = upstream.headers.get(name); if (value) response.setHeader(name, value); } response.end(); return; }
    if (!upstream.ok || (request.method !== 'HEAD' && !upstream.body)) throw new AppError(502, 'SERVICE_UNAVAILABLE', 'WAHA media service failed');
    response.status(upstream.status);
    response.setHeader('content-type', upstream.headers.get('content-type') ?? fallbackMimeType ?? 'application/octet-stream');
    const length = upstream.headers.get('content-length'); if (length) response.setHeader('content-length', length);
    for (const name of ['content-range', 'accept-ranges']) { const value = upstream.headers.get(name); if (value) response.setHeader(name, value); }
    const filename = (fallbackFilename ?? 'attachment').replace(/[\\\r\n"]/g, '_');
    response.setHeader('content-disposition', `inline; filename="${filename}"`);
    // Never use Readable.pipe() here: an upstream socket reset otherwise emits
    // an unhandled error on the Node stream and terminates the API process.
    if (request.method === 'HEAD') { response.end(); return; }
    try { await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), response); }
    catch {
      // Headers may already be on the wire, so a JSON error is no longer valid.
      // Destroy only this client response; pipeline has consumed the stream error
      // and the Express process remains available for all other requests.
      if (!response.destroyed) response.destroy();
    }
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private sign(payload: string) { const key = this.options.signingKey ?? this.options.apiKey; if (!key) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'WAHA media access is not configured'); return createHmac('sha256', key).update(payload).digest('base64url'); }
  private safeEqual(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
}
