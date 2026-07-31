import { log } from '../logging.js';
import type { DiscardedEventStore, IngestResult, StoredWebhook } from './waha-webhook.service.js';

/** Reprocessamento dos eventos que o webhook recebeu e descartou.
 *
 * O descarte não deixa rastro: a mensagem não foi gravada, e não existe coluna
 * dizendo "este evento foi recusado". O que existe é o evento bruto em
 * `waha_webhook_events`, íntegro, com o payload inteiro. Então a pergunta que
 * esta rotina faz ao banco é pela ausência — evento de mensagem sem linha
 * correspondente em `whatsapp_messages` — e a resposta é o conjunto a recuperar.
 *
 * Três propriedades sustentam a rotina, e todas já existiam antes dela:
 *
 * 1. **Idempotência.** A gravação da mensagem é `INSERT OR IGNORE` no SQLite e
 *    tolera `23505` no Supabase, e a conversa é upsert. Rodar duas vezes não
 *    duplica; a segunda passada nem chega a encontrar o evento, porque a
 *    anti-junção já não o devolve.
 * 2. **Ordem preservada.** `upsertConversation` só move `lastMessage`,
 *    `lastMessageAt` e `unreadCount` quando a mensagem que chega é mais nova que
 *    a que está lá. Um evento de dez dias atrás não rebaixa a conversa nem
 *    ressuscita contador de não lidas.
 * 3. **Sem efeito colateral.** `reprocess` não dispara automação de Kanban nem
 *    relógio de SLA. Mover card por mensagem antiga e contar espera de dez dias
 *    como atraso de agora seriam os dois jeitos mais rápidos de estragar o
 *    estado atual para recuperar o histórico.
 *
 * O que não volta é o arquivo de mídia: a WAHA apaga em 180 s e as URLs
 * guardadas não resolvem mais. A mensagem entra como registro sem arquivo, com
 * `mediaPersistenceStatus = 'unavailable'`, que é o estado que a Inbox já sabe
 * representar.
 */
export type ReprocessProgress = { scanned: number; recovered: number; skipped: number; failed: number; mediaUnavailable: number; after: string | null };
export type ReprocessSummary = ReprocessProgress & { batches: number; done: boolean };

const mediaTypes: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'ptt', 'voice', 'sticker', 'document']);

export class ReprocessDiscardedEventsService {
  constructor(private readonly store: DiscardedEventStore) {}

  /** `maxEvents` limita uma execução sem perder o lugar: o `after` devolvido é
   * onde a próxima começa. É o que torna dez mil eventos uma sequência de
   * passadas curtas em vez de uma transação única que ou vai inteira ou não vai.
   */
  async run(input: { workspaceId?: string; after?: string; batchSize?: number; maxEvents?: number; onProgress?: (progress: ReprocessProgress) => void } = {}): Promise<ReprocessSummary> {
    const batchSize = Math.max(1, Math.min(input.batchSize ?? 200, 500));
    const maxEvents = input.maxEvents ?? Number.POSITIVE_INFINITY;
    const total: ReprocessProgress = { scanned: 0, recovered: 0, skipped: 0, failed: 0, mediaUnavailable: 0, after: input.after ?? null };
    let batches = 0;
    let done = false;

    while (total.scanned < maxEvents) {
      const limit = Math.min(batchSize, maxEvents - total.scanned);
      const page = await this.store.listDiscardedEvents({ workspaceId: input.workspaceId, after: total.after ?? undefined, limit });
      if (!page.events.length && page.nextAfter === null) { done = true; break; }
      for (const event of page.events) {
        total.scanned++;
        await this.recover(event, total);
      }
      batches++;
      total.after = page.nextAfter ?? (page.events.at(-1)?.externalEventId ?? total.after);
      input.onProgress?.({ ...total });
      log('info', 'Discarded event reprocessing batch', { batch: batches, ...total });
      if (page.nextAfter === null) { done = true; break; }
    }

    log('info', 'Discarded event reprocessing finished', { ...total, batches, done });
    return { ...total, batches, done };
  }

  /** Uma falha de um evento não derruba a passada: ela é contada, registrada com
   * o id do evento, e a varredura segue. Dez mil eventos vindos de um provedor
   * externo têm cauda, e parar no primeiro esquisito faria o reparo depender de
   * o histórico inteiro ser bem-comportado. */
  private async recover(event: StoredWebhook, total: ReprocessProgress): Promise<void> {
    let result: IngestResult;
    try {
      result = await this.store.reprocess(event);
    } catch (error) {
      total.failed++;
      log('error', 'Discarded event reprocessing failed', { eventId: event.externalEventId, workspaceId: event.workspaceId, errorClass: error instanceof Error ? error.name : 'UnknownError', errorMessage: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!result.messageId) { total.skipped++; return; }
    total.recovered++;
    if (!mediaTypes.has(result.messageType ?? '')) return;
    // Marcar é seguro em qualquer passada: o UPDATE só alcança linha sem arquivo
    // guardado, então reprocessar de novo não desfaz uma mídia que tenha sido
    // recuperada por outro caminho.
    try {
      await this.store.markMediaUnavailable(event.workspaceId, result.messageId);
      total.mediaUnavailable++;
    } catch (error) {
      log('error', 'Marking reprocessed media as unavailable failed', { eventId: event.externalEventId, messageId: result.messageId, errorClass: error instanceof Error ? error.name : 'UnknownError' });
    }
  }
}
