import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { CallService } from '../services/call.service.js';
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

  /** O número sai da própria conversa: identidade curada (LID→telefone) ou,
   *  em último caso, os dígitos do chatId @c.us. Sem telefone mas com chatId
   *  @lid, a chamada segue pelo LID: o Call Service resolve LID→PN pelo store
   *  da sessão (e disca o @lid direto quando o mapa ainda não existe). */
  start: RequestHandler = async (req, res) => {
    const { conversationId } = startCallSchema.parse(req.body);
    const conversation = await this.conversations.getConversation(req.context!.workspaceId, conversationId);
    if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversa não encontrada', { conversationId });
    if (conversation.conversationType === 'group') throw new AppError(409, 'CONFLICT', 'Chamadas de grupo ainda não são suportadas.');
    const phone = conversation.identity.phone ?? (conversation.chatId.endsWith('@c.us') ? conversation.chatId.split('@', 1)[0]!.replace(/\D/g, '') : null);
    const lid = conversation.chatId.endsWith('@lid') ? conversation.chatId.split('@', 1)[0]!.replace(/\D/g, '') : null;
    if (!phone && !lid) throw new AppError(409, 'CONFLICT', 'O contato não possui telefone nem LID identificável. Sincronize a identidade do contato.');
    const call = await this.calls.startCall(phone ? { phone } : { lid: lid! });
    res.status(201).json({ ...call, conversationId });
  };

  active: RequestHandler = async (_req, res) => {
    res.json({ calls: this.calls.activeCalls() });
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
