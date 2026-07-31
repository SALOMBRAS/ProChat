import type { RequestContext } from '@chatpro/contracts';
import { AppError } from '../errors.js';
import { log } from '../logging.js';

/** O bastante de `SessionSummary` para responder "esta sessão ainda existe?".
 *  `wahaName` é o nome que o banco grava em `conversations.wahaSession`; `id` é
 *  o identificador interno do ChatPro e não serve para comparar. */
export type ListedSession = { status: string; wahaName?: string };
export interface SessionLister { list(context: RequestContext): Promise<ListedSession[]>; }

/** Vai em `details` do 409 para o dashboard distinguir esta recusa de qualquer
 *  outro conflito, sem precisar de um `ErrorCode` novo no contrato. */
export const inactiveSessionReason = 'whatsapp_session_inactive';

/**
 * Quais nomes de sessão WAHA ainda existem num workspace.
 *
 * A verdade não está no banco: `conversations.wahaSession` é um nome
 * denormalizado, sem tabela de sessões do outro lado, e quem sabe quais existem
 * é a WAHA — via worker, que já devolve o `wahaName` em `SessionSummary`.
 *
 * Por isso o serviço **falha aberto**. Quando a resposta não pode ser obtida —
 * worker fora do ar, timeout, provider que não expõe `wahaName` —
 * `activeSessions` devolve `undefined` e todo chamador trata tudo como ativo.
 * Marcar como morta uma conversa viva é o único erro que não pode acontecer:
 * há contatos com conversa nas duas sessões, e a que está viva não pode perder
 * o envio por causa de uma falha de infraestrutura.
 *
 * O status da sessão de propósito não entra na conta. O problema são sessões que
 * **deixaram de existir**; uma que está apenas `stopped` ou reconectando continua
 * na lista e volta a funcionar sozinha. Filtrar por `connected` faria a marcação
 * piscar a cada reconexão e bloquearia envio na sessão certa. Sessão que existe
 * mas não está conectada já é recusada adiante pelo worker, com `CONFLICT`.
 */
export class WhatsAppSessionActivityService {
  private readonly cache = new Map<string, { at: number; names: ReadonlySet<string> | undefined }>();
  constructor(private readonly sessions: SessionLister, private readonly ttlMs = 30_000, private readonly clock: () => number = Date.now) {}

  /** `undefined` quer dizer "não deu para saber", não "nenhuma ativa". */
  async activeSessions(context: RequestContext): Promise<ReadonlySet<string> | undefined> {
    const cached = this.cache.get(context.workspaceId);
    if (cached && this.clock() - cached.at < this.ttlMs) return cached.names;
    const names = await this.resolve(context);
    this.cache.set(context.workspaceId, { at: this.clock(), names });
    return names;
  }

  /** `true` quando a sessão existe ou quando não dá para saber. */
  async isActive(context: RequestContext, wahaSession: string): Promise<boolean> {
    const active = await this.activeSessions(context);
    return !active || active.has(wahaSession);
  }

  async assertActive(context: RequestContext, wahaSession: string): Promise<void> {
    if (await this.isActive(context, wahaSession)) return;
    // A mensagem não cita o nome da sessão: é identificador técnico e não pode
    // chegar ao operador.
    throw new AppError(409, 'CONFLICT', 'This conversation belongs to a WhatsApp connection that no longer exists', { reason: inactiveSessionReason });
  }

  private async resolve(context: RequestContext): Promise<ReadonlySet<string> | undefined> {
    let listed: ListedSession[];
    try {
      listed = await this.sessions.list(context);
    } catch (error) {
      log('error', 'WhatsApp session activity lookup failed', { workspaceId: context.workspaceId, errorMessage: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
    const names = listed.flatMap(session => session.wahaName ? [session.wahaName] : []);
    // Nenhum nome resolvível é indistinguível de "não perguntei": um provider
    // que não preenche `wahaName` responderia lista vazia e condenaria todas as
    // conversas do workspace de uma vez.
    return names.length ? new Set(names) : undefined;
  }
}

/** Marca cada conversa com a vitalidade da sessão que a originou, sem esconder
 *  nenhuma: a lista continua a mesma, com um campo a mais. Sem conjunto
 *  conhecido, tudo continua ativo. */
export function withSessionActivity<T extends { whatsappSessionId: string }>(items: readonly T[], active: ReadonlySet<string> | undefined): Array<T & { whatsappSessionActive: boolean }> {
  return items.map(item => ({ ...item, whatsappSessionActive: !active || active.has(item.whatsappSessionId) }));
}
