import type { StoredWebhook } from './waha-webhook.service.js';

/** O que vale registrar na conversa quando uma chamada termina. */
export type CallLogEntry = {
  workspaceId: string;
  callId: string;
  direction: 'inbound' | 'outbound';
  /** JID do peer como veio do Call Service (`@s.whatsapp.net`, `@lid`). */
  peer: string;
  /** A chamada chegou a conectar (áudio) ou morreu no toque. */
  connected: boolean;
  reason?: string;
  startedAt: number;
  endedAt: number;
};

export type CallOutcome = 'completed' | 'unanswered' | 'received' | 'missed';

type CallLogStore = {
  findConversationByChat(workspaceId: string, chatIds: readonly string[]): Promise<{ wahaSession: string; chatId: string } | undefined>;
  ingest(event: StoredWebhook): Promise<unknown>;
};

export const callOutcomeOf = (entry: Pick<CallLogEntry, 'direction' | 'connected'>): CallOutcome =>
  entry.direction === 'outbound' ? (entry.connected ? 'completed' : 'unanswered') : (entry.connected ? 'received' : 'missed');

/**
 * CallLogService — grava o encerramento da chamada como mensagem `call` na
 * conversa ("Ligação feita/recebida/perdida"). É o registro PERMANENTE: o
 * histórico do Call Service guarda só as últimas 50, aqui fica no banco. O
 * operador vê a notificação na timeline; a gravação em áudio fica só na aba
 * Chamadas (acesso de dono, numa etapa futura).
 *
 * A mensagem é fabricada como evento `message.any` sintético e passa pelo
 * mesmo `ingest` das mensagens reais — idempotente pela PK (`call:<callId>`),
 * sem caminho novo de persistência.
 */
export class CallLogService {
  constructor(private readonly store: CallLogStore) {}

  async record(entry: CallLogEntry): Promise<void> {
    const digits = entry.peer.replace(/\D/g, '');
    if (!digits) return;
    const conversation = await this.store.findConversationByChat(entry.workspaceId, [`${digits}@c.us`, `${digits}@lid`]);
    if (!conversation) return; // sem conversa conhecida, não há onde pendurar o registro
    await this.store.ingest({
      workspaceId: entry.workspaceId,
      wahaSession: conversation.wahaSession,
      externalEventId: `call:${entry.callId}`,
      eventType: 'message.any',
      occurredAt: new Date(entry.endedAt).toISOString(),
      payload: {
        id: `call:${entry.callId}`,
        chatId: conversation.chatId,
        type: 'call',
        fromMe: entry.direction === 'outbound',
        callOutcome: callOutcomeOf(entry),
        callDurationSeconds: entry.connected ? Math.max(0, Math.round((entry.endedAt - entry.startedAt) / 1_000)) : 0,
        ...(entry.reason ? { callEndReason: entry.reason } : {}),
      },
      receivedAt: new Date().toISOString(),
    });
  }
}
