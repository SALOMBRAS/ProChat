import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { CallHistoryRow, CallService } from '../services/call.service.js';
import type { ConversationStore } from '../services/waha-webhook.service.js';

const startCallSchema = z.object({ conversationId: z.string().uuid() });
const webrtcSchema = z.object({ sdpOffer: z.string().min(1).max(65_536) });

function routeId(value: string | string[] | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new AppError(400, 'VALIDATION_ERROR', `Invalid ${field}`, { field });
  return value;
}

/**
 * CallsController — superfície HTTP das chamadas de voz. O botão 📞 da
 * conversa bate aqui; quem fala com o WhatsApp é o Call Service (Go).
 */
export class CallsController {
  constructor(private readonly conversations: ConversationStore, private readonly calls: CallService) {}

  /** O número sai da própria conversa: conversa @c.us é discada pelos dígitos
   *  do chatId (endereço de protocolo); conversa @lid usa o telefone curado da
   *  identidade (LID→telefone) quando ele difere do LID, e sem ele a chamada
   *  segue pelo LID: o Call Service resolve LID→PN pelo store da sessão (e
   *  disca o @lid direto quando o mapa ainda não existe). */
  start: RequestHandler = async (req, res) => {
    const { conversationId } = startCallSchema.parse(req.body);
    const conversation = await this.conversations.getConversation(req.context!.workspaceId, conversationId);
    if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversa não encontrada', { conversationId });
    if (conversation.conversationType === 'group') throw new AppError(409, 'CONFLICT', 'Chamadas de grupo ainda não são suportadas.');
    const chatDigits = conversation.chatId.split('@', 1)[0]!.replace(/\D/g, '');
    const isLidChat = conversation.chatId.endsWith('@lid');
    // identity.phone pode guardar os dígitos do próprio LID (dado sujo de
    // sync). Isso NÃO é telefone discável: o Call Service mandaria o offer
    // para <lid>@s.whatsapp.net e o WhatsApp descartaria em silêncio —
    // "chamando" eterno. Telefone curado só vale quando difere do LID;
    // conversa @c.us já é endereçada pelo número real.
    const curated = conversation.identity.phone;
    const phone = isLidChat ? (curated && curated !== chatDigits ? curated : null) : conversation.chatId.endsWith('@c.us') ? chatDigits : curated;
    const lid = isLidChat ? chatDigits : null;
    if (!phone && !lid) throw new AppError(409, 'CONFLICT', 'O contato não possui telefone nem LID identificável. Sincronize a identidade do contato.');
    const call = await this.calls.startCall(phone ? { phone } : { lid: lid! });
    res.status(201).json({ ...call, conversationId });
  };

  active: RequestHandler = async (_req, res) => {
    res.json({ calls: this.calls.activeCalls() });
  };

  /** Histórico de chamadas. Com `conversationId`, filtra pela conversa (painel
   *  do cliente); sem ele, devolve todas enriquecidas com o nome do contato
   *  (aba Chamadas). O peer gravado pelo Go pode ser @lid ou número — por isso
   *  o casamento é sempre pelos dígitos. */
  history: RequestHandler = async (req, res) => {
    const query = z.object({ conversationId: z.string().uuid().optional() }).parse(req.query);
    const rows = await this.calls.callHistory();
    const present = (row: CallHistoryRow) => ({ callId: row.callId, direction: row.direction, status: row.status, startedAt: row.startedAt, endedAt: row.endedAt ?? null, endReason: row.endReason ?? null, recording: row.recording === true });
    if (query.conversationId) {
      const conversation = await this.conversations.getConversation(req.context!.workspaceId, query.conversationId);
      if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversa não encontrada', { conversationId: query.conversationId });
      const candidates = new Set([conversation.chatId.split('@', 1)[0]!.replace(/\D/g, ''), conversation.identity.phone].filter((value): value is string => Boolean(value)));
      res.json({ calls: rows.filter(row => [...candidates].some(digits => digits && row.peer.replace(/\D/g, '').includes(digits))).map(present) });
      return;
    }
    // Aba Chamadas: o nome vem da conversa conhecida (contato/identidade); o
    // telefone só é exibido quando o peer é um número real — dígitos de @lid
    // são identificador técnico e nunca sobem para a tela.
    const chatIdOf = (peer: string) => peer.replace('@s.whatsapp.net', '@c.us');
    const names = await this.conversations.callPeerNames(req.context!.workspaceId, [...new Set(rows.map(row => chatIdOf(row.peer)))]);
    res.json({
      calls: rows.map(row => {
        const digits = row.peer.split('@', 1)[0]!.replace(/\D/g, '');
        return { ...present(row), contactName: names.get(chatIdOf(row.peer)) ?? null, phone: row.peer.endsWith('@lid') ? null : digits };
      }),
    });
  };

  /** Stream da gravação (WAV) feita pelo Call Service — a API só repassa. */
  recording: RequestHandler = async (req, res) => {
    const upstream = await this.calls.recordingStream(routeId(req.params.callId, 'callId'));
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.status(upstream.status);
    if (!upstream.body) { res.end(); return; }
    const { Readable } = await import('node:stream');
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
  };


  /** Pareamento unificado: a tela de sessões mostra o QR da WAHA e o das
   *  chamadas lado a lado (são duas sessões WhatsApp independentes — um scan
   *  cada, no mesmo aparelho). */
  pairing: RequestHandler = async (_req, res) => {
    res.json(await this.calls.pairingStatus());
  };

  startPairing: RequestHandler = async (req, res) => {
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : 'ChatPro';
    res.status(201).json(await this.calls.ensurePairing(name));
  };

  webrtc: RequestHandler = async (req, res) => {
    const { sdpOffer } = webrtcSchema.parse(req.body);
    const sdpAnswer = await this.calls.exchangeSdp(routeId(req.params.callId, 'callId'), sdpOffer);
    res.json({ sdpAnswer });
  };

  accept: RequestHandler = async (req, res) => {
    await this.calls.accept(routeId(req.params.callId, 'callId'));
    res.status(204).end();
  };

  reject: RequestHandler = async (req, res) => {
    await this.calls.reject(routeId(req.params.callId, 'callId'));
    res.status(204).end();
  };

  end: RequestHandler = async (req, res) => {
    await this.calls.end(routeId(req.params.callId, 'callId'));
    res.status(204).end();
  };
}
