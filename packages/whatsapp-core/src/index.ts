export type WhatsAppInstanceStatus =
  | "not_started"
  | "starting"
  | "qr_ready"
  | "connected"
  | "stopping"
  | "stopped"
  | "disconnected"
  | "unknown";

export interface InstanceResult {
  id: string;
  status: WhatsAppInstanceStatus;
}

export interface QrCodeResult {
  instanceId: string;
  status: "available" | "unavailable";
  qrCode?: string;
}

export type WhatsAppErrorCode =
  | "invalid_request"
  | "not_found"
  | "unauthorized"
  | "timeout"
  | "unavailable"
  | "provider_error";

export class WhatsAppProviderError extends Error {
  public constructor(
    public readonly code: WhatsAppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WhatsAppProviderError";
  }
}

export interface WhatsAppProvider {
  health(): Promise<void>;
  createInstance(id: string): Promise<InstanceResult>;
  getInstanceStatus(id: string): Promise<InstanceResult>;
  getQrCode(id: string): Promise<QrCodeResult>;
  startInstance(id: string): Promise<InstanceResult>;
  stopInstance(id: string): Promise<InstanceResult>;
}
