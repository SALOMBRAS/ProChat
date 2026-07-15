import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { internalTransportRequestSchema, type InternalTransportRequest, type InternalTransportResponse } from '@chatpro/contracts';

export type InternalTransportServerOptions = { host: '127.0.0.1'; port: number };
export type InternalTransportHandler = (request: InternalTransportRequest) => Promise<InternalTransportResponse>;

export function controlledTransportHandler(request: InternalTransportRequest): Promise<InternalTransportResponse> {
  const payload = request.command.payload;
  return new Promise(resolve => setTimeout(() => resolve(payload.fail
    ? { success: false, correlationId: request.correlationId, workspaceId: request.workspaceId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Controlled worker failure', details: {} } }
    : { success: true, correlationId: request.correlationId, workspaceId: request.workspaceId, data: { message: payload.message } }), payload.delayMs ?? 0));
}

export function createInternalTransportServer(handler: InternalTransportHandler = controlledTransportHandler): Server {
  return createServer(async (req, res) => {
    let responded = false;
    const respond = (status: number, body: InternalTransportResponse) => { if (responded) return; responded = true; res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/internal/transport') { res.statusCode = 404; res.end(); return; }
    try {
      const input = await readJson(req);
      const parsed = internalTransportRequestSchema.safeParse(input);
      if (!parsed.success) { const candidate = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}; const correlationId = typeof candidate.correlationId === 'string' ? candidate.correlationId : 'invalid'; const workspaceId = typeof candidate.workspaceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate.workspaceId) ? candidate.workspaceId : 'invalid'; respond(400, { success: false, correlationId, workspaceId, error: { code: 'VALIDATION_ERROR', message: 'Invalid internal transport request', details: {} } }); return; }
      respond(200, await handler(parsed.data));
    } catch { respond(500, { success: false, correlationId: 'unknown', workspaceId: 'unknown', error: { code: 'SERVICE_UNAVAILABLE', message: 'Internal worker command failed', details: {} } }); }
  });
}

export async function listenInternalTransport(options: InternalTransportServerOptions, handler?: InternalTransportHandler): Promise<{ server: Server; close: () => Promise<void> }> {
  const server = createInternalTransportServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); }); });
  return { server, close: () => new Promise(resolve => server.close(() => resolve())) };
}
function readJson(req: IncomingMessage): Promise<unknown> { return new Promise((resolve, reject) => { let text = ''; req.setEncoding('utf8'); req.on('data', chunk => { text += chunk; if (text.length > 32_768) reject(new Error('body too large')); }); req.once('end', () => resolve(JSON.parse(text))); req.once('error', reject); }); }
