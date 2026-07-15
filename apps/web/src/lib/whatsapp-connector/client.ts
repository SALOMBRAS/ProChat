export type ConnectorInstanceStatus = "not_started" | "starting" | "qr_ready" | "connected" | "stopping" | "stopped" | "disconnected" | "unknown";
export interface ConnectorInstance { id: string; status: ConnectorInstanceStatus; }
export interface ConnectorQrCode { instanceId: string; status: "available" | "unavailable"; qrCode?: string; }
type ConnectorErrorPayload = { error?: { code?: string; message?: string } };
export class ConnectorApiError extends Error { public constructor(public readonly code: string, message: string) { super(message); this.name = "ConnectorApiError"; } }

export class ConnectorApiClient {
  public constructor(private readonly baseUrl: string, private readonly requestFetch: typeof fetch = fetch) {}
  public health(): Promise<void> { return this.request("/health").then(() => undefined); }
  public createInstance(id: string): Promise<ConnectorInstance> { return this.request("/instances", { method: "POST", body: JSON.stringify({ id }) }); }
  public getStatus(id: string): Promise<ConnectorInstance> { return this.request(`/instances/${encodeURIComponent(id)}/status`); }
  public getQrCode(id: string): Promise<ConnectorQrCode> { return this.request(`/instances/${encodeURIComponent(id)}/qr`); }
  public startInstance(id: string): Promise<ConnectorInstance> { return this.request(`/instances/${encodeURIComponent(id)}/start`, { method: "POST" }); }
  public stopInstance(id: string): Promise<ConnectorInstance> { return this.request(`/instances/${encodeURIComponent(id)}/stop`, { method: "POST" }); }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.baseUrl) throw new ConnectorApiError("not_configured", "A API local do conector não está configurada.");
    let response: Response;
    try { response = await this.requestFetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init.headers } }); }
    catch { throw new ConnectorApiError("unavailable", "Não foi possível alcançar a API local do WhatsApp."); }
    const body = await response.json().catch(() => ({})) as ConnectorErrorPayload & T;
    if (!response.ok) throw new ConnectorApiError(body.error?.code || "request_failed", body.error?.message || "Não foi possível concluir a operação do WhatsApp.");
    return body as T;
  }
}
