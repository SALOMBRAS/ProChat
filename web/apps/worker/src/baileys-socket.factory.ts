import { Browsers, makeWASocket, useMultiFileAuthState, type WASocket } from '@itsukichan/baileys';
import type { WhatsAppSocket, WhatsAppSocketFactory } from './whatsapp-socket.js';

const silentLogger = {
  level: 'silent',
  child() { return silentLogger; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

export class BaileysSocketFactory implements WhatsAppSocketFactory {
  async create(authDirectory: string) {
    const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
    const socket: WASocket = makeWASocket({
      auth: state,
      logger: silentLogger as never,
      printQRInTerminal: false,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      defaultQueryTimeoutMs: 90_000,
      connectTimeoutMs: 90_000,
      keepAliveIntervalMs: 20_000,
      retryRequestDelayMs: 2_000,
      maxMsgRetryCount: 5,
      qrTimeout: 120_000,
      getMessage: async () => undefined,
    });
    return { socket: socket as unknown as WhatsAppSocket, saveCreds };
  }
}
