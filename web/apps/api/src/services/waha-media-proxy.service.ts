import { Readable } from 'node:stream';
import type { Response } from 'express';
import { AppError } from '../errors.js';

export class WahaMediaProxyService {
  constructor(private readonly options: { baseUrl?: string; apiKey?: string; fetchImpl?: typeof fetch } = {}) {}

  async stream(url: string, fallbackMimeType: string | null, fallbackFilename: string | null, response: Response): Promise<void> {
    if (!this.options.baseUrl || !this.options.apiKey) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'WAHA media access is not configured');
    const target = new URL(url); const base = new URL(this.options.baseUrl);
    if (target.origin !== base.origin || !target.pathname.startsWith('/api/files/')) throw new AppError(400, 'VALIDATION_ERROR', 'Media URL is not a WAHA file URL');
    let upstream: globalThis.Response;
    try { upstream = await (this.options.fetchImpl ?? fetch)(target, { headers: { 'x-api-key': this.options.apiKey } }); }
    catch { throw new AppError(503, 'SERVICE_UNAVAILABLE', 'WAHA media service is unavailable'); }
    if (upstream.status === 404) throw new AppError(404, 'NOT_FOUND', 'Media file not found');
    if (!upstream.ok || !upstream.body) throw new AppError(502, 'SERVICE_UNAVAILABLE', 'WAHA media service failed');
    response.status(200);
    response.setHeader('content-type', upstream.headers.get('content-type') ?? fallbackMimeType ?? 'application/octet-stream');
    const length = upstream.headers.get('content-length'); if (length) response.setHeader('content-length', length);
    const filename = (fallbackFilename ?? 'attachment').replace(/[\\\r\n"]/g, '_');
    response.setHeader('content-disposition', `inline; filename="${filename}"`);
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(response);
  }
}
