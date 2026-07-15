import {
  type InstanceResult,
  type QrCodeResult,
  type WhatsAppInstanceStatus,
  WhatsAppProviderError,
} from "@chatpro/whatsapp-core";

export function mapWahaStatus(value: unknown): WhatsAppInstanceStatus {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "STARTING": return "starting";
    case "SCAN_QR": return "qr_ready";
    case "WORKING": return "connected";
    case "STOPPING": return "stopping";
    case "STOPPED": return "stopped";
    case "FAILED": return "disconnected";
    default: return "unknown";
  }
}

export function mapWahaInstance(id: string, payload: unknown): InstanceResult {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return { id, status: mapWahaStatus(record.status) };
}

export function mapWahaQrCode(id: string, payload: unknown): QrCodeResult {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const value = [record.value, record.qr, record.qrCode].find((candidate) => typeof candidate === "string" && candidate.length > 0);
  return typeof value === "string"
    ? { instanceId: id, status: "available", qrCode: value }
    : { instanceId: id, status: "unavailable" };
}

export function mapWahaError(status?: number): WhatsAppProviderError {
  if (status === 401 || status === 403) return new WhatsAppProviderError("unauthorized", "Não foi possível autenticar no provedor WhatsApp.");
  if (status === 404) return new WhatsAppProviderError("not_found", "Instância não encontrada.");
  if (status === 409 || status === 422 || status === 400) return new WhatsAppProviderError("invalid_request", "A solicitação da instância é inválida.");
  if (status && status >= 500) return new WhatsAppProviderError("unavailable", "O provedor WhatsApp está indisponível.");
  return new WhatsAppProviderError("provider_error", "O provedor WhatsApp retornou um erro inesperado.");
}
