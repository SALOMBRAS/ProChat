import { WhatsAppProviderError } from "@chatpro/whatsapp-core";

export interface ConnectorConfig {
  host: string;
  port: number;
  wahaBaseUrl: string;
  wahaApiKey: string;
  timeoutMs: number;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new WhatsAppProviderError("invalid_request", `A variável ${name} é obrigatória.`);
  }

  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WhatsAppProviderError("invalid_request", `A variável ${name} é inválida.`);
  }

  return value;
}

function localHost(name: string, value: string): string {
  if (!LOCAL_HOSTS.has(value)) {
    throw new WhatsAppProviderError("invalid_request", `A variável ${name} deve apontar para loopback.`);
  }

  return value;
}

export function loadConfig(): ConnectorConfig {
  const host = localHost("CONNECTOR_HOST", process.env.CONNECTOR_HOST?.trim() || "127.0.0.1");
  const port = boundedInteger("CONNECTOR_PORT", 3001, 1, 65535);
  const timeoutMs = boundedInteger("WAHA_TIMEOUT_MS", 10_000, 1_000, 30_000);
  const wahaBaseUrl = process.env.WAHA_BASE_URL?.trim() || "http://127.0.0.1:3000";

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(wahaBaseUrl);
  } catch {
    throw new WhatsAppProviderError("invalid_request", "A variável WAHA_BASE_URL é inválida.");
  }

  if (parsedUrl.protocol !== "http:" || !LOCAL_HOSTS.has(parsedUrl.hostname)) {
    throw new WhatsAppProviderError("invalid_request", "WAHA_BASE_URL deve usar HTTP em loopback.");
  }

  return { host, port, wahaBaseUrl: parsedUrl.origin, wahaApiKey: required("WAHA_API_KEY"), timeoutMs };
}
