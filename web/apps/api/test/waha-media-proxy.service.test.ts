import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { WahaMediaProxyService } from '../src/services/waha-media-proxy.service.js';

class ResponseSink extends Writable {
  readonly headers = new Map<string, string>();
  headersSent = false;
  statusCode = 200;
  status(code: number) { this.statusCode = code; this.headersSent = true; return this; }
  setHeader(name: string, value: string) { this.headers.set(name, value); }
  readonly chunks: Buffer[] = [];
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
}

describe('WahaMediaProxyService', () => {
  it('contains an upstream body reset instead of emitting an unhandled stream error', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError('terminated')); } }), { status: 200, headers: { 'content-type': 'image/png' } }));
    const response = new ResponseSink();
    const service = new WahaMediaProxyService({ baseUrl: 'http://waha.test', apiKey: 'test-key', fetchImpl: fetcher });
    await expect(service.stream('http://waha.test/api/files/photo.png', 'image/png', 'photo.png', response as unknown as import('express').Response)).resolves.toBeUndefined();
    expect(response.destroyed).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(new URL('http://waha.test/api/files/photo.png'), { method: 'GET', headers: { 'x-api-key': 'test-key' } });
  });

  it('forwards byte ranges and preserves partial-content headers', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('abcd', { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/10', 'accept-ranges': 'bytes' } }));
    const response = new ResponseSink(); const service = new WahaMediaProxyService({ baseUrl: 'http://waha.test', apiKey: 'test-key', fetchImpl: fetcher });
    await service.stream('http://waha.test/api/files/video.mp4', 'video/mp4', 'video.mp4', response as unknown as import('express').Response, { range: 'bytes=0-3' });
    expect(response.statusCode).toBe(206); expect(response.headers.get('content-range')).toBe('bytes 0-3/10'); expect(response.headers.get('accept-ranges')).toBe('bytes'); expect(Buffer.concat(response.chunks).toString()).toBe('abcd');
    expect(fetcher).toHaveBeenCalledWith(new URL('http://waha.test/api/files/video.mp4'), { method: 'GET', headers: { 'x-api-key': 'test-key', range: 'bytes=0-3' } });
  });

  it('handles HEAD and an invalid range without streaming a body', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/10', 'accept-ranges': 'bytes' } })).mockResolvedValueOnce(new Response(null, { status: 416, headers: { 'content-range': 'bytes */10', 'accept-ranges': 'bytes' } }));
    const service = new WahaMediaProxyService({ baseUrl: 'http://waha.test', apiKey: 'test-key', fetchImpl: fetcher });
    const head = new ResponseSink(); await service.stream('http://waha.test/api/files/video.mp4', 'video/mp4', 'video.mp4', head as unknown as import('express').Response, { method: 'HEAD', range: 'bytes=0-3' });
    expect(head.statusCode).toBe(206); expect(head.chunks).toHaveLength(0);
    const invalid = new ResponseSink(); await service.stream('http://waha.test/api/files/video.mp4', 'video/mp4', 'video.mp4', invalid as unknown as import('express').Response, { range: 'bytes=100-200' });
    expect(invalid.statusCode).toBe(416); expect(invalid.headers.get('content-range')).toBe('bytes */10');
  });

  it('issues scoped, expiring media access tokens', () => {
    const service = new WahaMediaProxyService({ apiKey: 'test-key', now: () => 1_000_000 }); const access = service.issueAccessToken({ workspaceId: 'workspace-a', userId: 'user-a', messageId: 'message-a' });
    expect(service.verifyAccessToken(access.token, 'message-a')).toEqual({ workspaceId: 'workspace-a', userId: 'user-a' });
    expect(() => service.verifyAccessToken(access.token, 'message-b')).toThrow('Media access token is invalid');
  });
});
