export type ConnectionUpdate = { connection?: 'connecting' | 'open' | 'close'; qr?: string; lastDisconnect?: { error?: unknown } };
export type SocketEvent = 'connection.update' | 'creds.update';
export type WhatsAppSocket = {
  ev: {
    on(event: 'connection.update', listener: (update: ConnectionUpdate) => void): void;
    on(event: 'creds.update', listener: () => void | Promise<void>): void;
  };
  end(error?: Error): void | Promise<void>;
  logout(): Promise<void>;
};
export type SocketCreation = { socket: WhatsAppSocket; saveCreds: () => Promise<void> };
export interface WhatsAppSocketFactory { create(authDirectory: string): Promise<SocketCreation>; }
