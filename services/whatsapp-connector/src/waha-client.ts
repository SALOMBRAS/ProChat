import { WhatsAppProviderError } from "@chatpro/whatsapp-core";
import type { ConnectorConfig } from "./config.js";
import { mapWahaError } from "./waha-mappers.js";

export class WahaClient {
  public constructor(private readonly config: ConnectorConfig) {}

  public async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const method = init.method || "GET";

    try {
      const response = await fetch(`${this.config.wahaBaseUrl}${path}`, {
        ...init,
        headers: { "X-Api-Key": this.config.wahaApiKey, Accept: "application/json", ...init.headers },
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = mapWahaError(response.status);
        console.warn(`[whatsapp-connector] WAHA ${method} ${path} falhou (${error.code}).`);
        throw error;
      }

      const contentType = response.headers.get("content-type") || "";
      return contentType.includes("application/json") ? response.json() : undefined;
    } catch (error) {
      if (error instanceof WhatsAppProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new WhatsAppProviderError("timeout", "O provedor WhatsApp excedeu o tempo limite.");
      }
      console.warn(`[whatsapp-connector] WAHA ${method} ${path} está indisponível.`);
      throw new WhatsAppProviderError("unavailable", "O provedor WhatsApp está indisponível.");
    } finally {
      clearTimeout(timeout);
    }
  }
}
