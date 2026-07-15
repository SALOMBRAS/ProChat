import type { InstanceResult, QrCodeResult, WhatsAppProvider } from "@chatpro/whatsapp-core";
import { WahaClient } from "./waha-client.js";
import { mapWahaInstance, mapWahaQrCode } from "./waha-mappers.js";

export class WahaProvider implements WhatsAppProvider {
  public constructor(private readonly client: WahaClient) {}

  public async health(): Promise<void> { await this.client.request("/health"); }
  public async createInstance(id: string): Promise<InstanceResult> {
    const payload = await this.client.request("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: id }) });
    return mapWahaInstance(id, payload);
  }
  public async getInstanceStatus(id: string): Promise<InstanceResult> { return mapWahaInstance(id, await this.client.request(`/api/sessions/${encodeURIComponent(id)}`)); }
  public async getQrCode(id: string): Promise<QrCodeResult> { return mapWahaQrCode(id, await this.client.request(`/api/${encodeURIComponent(id)}/auth/qr`)); }
  public async startInstance(id: string): Promise<InstanceResult> { return mapWahaInstance(id, await this.client.request(`/api/sessions/${encodeURIComponent(id)}/start`, { method: "POST" })); }
  public async stopInstance(id: string): Promise<InstanceResult> { return mapWahaInstance(id, await this.client.request(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" })); }
}
