import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { WahaMediaProxyService } from '../src/services/waha-media-proxy.service.js';

class ResponseSink extends Writable {
  readonly headers = new Map<string, string>();
  headersSent = false;
  statusCode = 200;
  status(code: number) { this.statusCode = code; this.headersSent = true; return this; }
  setHeader(name: string, value: string) { this.headers.set(name, value); }
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { callback(); }
}

describe('WahaMediaProxyService', () => {
  it('contains an upstream body reset instead of emitting an unhandled stream error', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError('terminated')); } }), { status: 200, headers: { 'content-type': 'image/png' } }));
    const response = new ResponseSink();
    const service = new WahaMediaProxyService({ baseUrl: 'http://waha.test', apiKey: 'test-key', fetchImpl: fetcher });
    await expect(service.stream('http://waha.test/api/files/photo.png', 'image/png', 'photo.png', response as unknown as import('express').Response)).resolves.toBeUndefined();
    expect(response.destroyed).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(new URL('http://waha.test/api/files/photo.png'), { headers: { 'x-api-key': 'test-key' } });
  });
});
