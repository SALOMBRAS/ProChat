import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WhatsAppProviderError, type WhatsAppProvider } from "@chatpro/whatsapp-core";

const INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_ORIGINS = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);
function send(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); }
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += buffer.length; if (length > 32_768) throw new WhatsAppProviderError("invalid_request", "O corpo da solicitação é muito grande."); chunks.push(buffer); }
  if (length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new WhatsAppProviderError("invalid_request", "O corpo da solicitação deve ser JSON válido."); }
}
function instanceId(value: string | undefined): string { if (!value || !INSTANCE_ID.test(value)) throw new WhatsAppProviderError("invalid_request", "O identificador da instância é inválido."); return value; }
function errorStatus(error: WhatsAppProviderError): number { switch (error.code) { case "invalid_request": return 400; case "not_found": return 404; case "timeout": return 504; case "unavailable": return 503; default: return 502; } }

export function createConnectorServer(provider: WhatsAppProvider): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://connector.local"); const parts = url.pathname.split("/").filter(Boolean);
    try {
      const origin = request.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) { send(response, 403, { error: { code: "not_found", message: "Rota não encontrada." } }); return; }
      if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
      if (request.method === "OPTIONS") { response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); response.end(); return; }
      if (request.method === "GET" && url.pathname === "/health") { await provider.health(); send(response, 200, { status: "ok", dependency: "waha" }); return; }
      if (request.method === "POST" && url.pathname === "/instances") { const body = await readJson(request); const id = instanceId(body && typeof body === "object" ? (body as Record<string, unknown>).id as string | undefined : undefined); send(response, 201, await provider.createInstance(id)); return; }
      const id = parts[1] ? instanceId(parts[1]) : undefined;
      if (parts[0] === "instances" && id && request.method === "GET" && parts[2] === "status" && parts.length === 3) { send(response, 200, await provider.getInstanceStatus(id)); return; }
      if (parts[0] === "instances" && id && request.method === "GET" && parts[2] === "qr" && parts.length === 3) { send(response, 200, await provider.getQrCode(id)); return; }
      if (parts[0] === "instances" && id && request.method === "POST" && parts[2] === "start" && parts.length === 3) { send(response, 200, await provider.startInstance(id)); return; }
      if (parts[0] === "instances" && id && request.method === "POST" && parts[2] === "stop" && parts.length === 3) { send(response, 200, await provider.stopInstance(id)); return; }
      send(response, 404, { error: { code: "not_found", message: "Rota não encontrada." } });
    } catch (error) {
      const normalized = error instanceof WhatsAppProviderError ? error : new WhatsAppProviderError("provider_error", "Falha inesperada no conector.");
      console.warn(`[whatsapp-connector] Solicitação ${request.method} ${url.pathname} falhou (${normalized.code}).`);
      send(response, errorStatus(normalized), { error: { code: normalized.code, message: normalized.message } });
    }
  });
}
