import { randomUUID } from 'node:crypto';
import type { InternalTransportCommand } from '@chatpro/contracts';
import type { InternalWorkerClient } from '../internal-worker-client.js';
import type { RealtimeHub } from '../realtime.js';
import { log } from '../logging.js';
import { normalizedPhone, phoneFromIdentifier, type ContactIdentityResolver } from './contact-identity-resolver.service.js';
import type { IdentitySyncTarget } from './whatsapp-identity-sync.service.js';

export type ContactSyncStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ContactSyncJob = { id: string; workspaceId: string; wahaSession: string; status: ContactSyncStatus; cursor: string; contactsProcessed: number; contactsResolved: number; contactsSkipped: number; startedAt: string; completedAt: string | null; lastErrorSafe: string | null; updatedAt: string };
/** `syncKind` é o que separa este job do de histórico no evento
 * `conversation.sync.updated`, que os dois dividem: o handler da Inbox lê
 * `chatsProcessed`/`messagesProcessed` e redesenharia o banner do histórico
 * com números de contatos se não filtrasse o campo. */
export type ContactSyncJobStatus = ContactSyncJob & { jobId: string; syncKind: 'contacts'; hasMore: boolean; progressLabel: string };
export interface ContactSyncJobStore { get(workspaceId: string, wahaSession: string): Promise<ContactSyncJob | undefined>; save(job: ContactSyncJob): Promise<void>; }
export type ContactSyncOptions = { pageSize?: number; maxContactsPerRun?: number; continuationDelayMs?: number; maxAttempts?: number; retryBaseMs?: number; staleRunningAfterMs?: number; sleep?: (milliseconds: number) => Promise<void> };

const transientCodes = new Set(['TIMEOUT', 'SERVICE_UNAVAILABLE']);

/** Sincronização da agenda de contatos da sessão WhatsApp para a base interna.
 *
 *  Cobre quem nunca trocou mensagem com a conta: a base interna nasce do
 *  webhook (só quem conversa), mas o envio de cartão de contato precisa oferecer
 *  a agenda inteira. O fluxo por contato é o mesmo do webhook — resolver de
 *  identidade (telefone normalizado, aliases LID/JID, pendências) mais fila de
 *  enriquecimento (nome/foto/pushName, que tem cache próprio de 24 h) — então a
 *  reexecução é idempotente e segura.
 *
 *  Limitação do provedor, registrada para quem opera: `GET /api/contacts/all`
 *  da WAHA devolve os contatos **carregados pela sessão Web**, não a agenda do
 *  telefone, e só usuários WhatsApp. Contatos recém-adicionados aparecem na
 *  reexecução, depois que o app do telefone sincroniza com a sessão. */
export class WhatsAppContactSyncService {
  private readonly active = new Set<string>();
  private readonly cancelling = new Set<string>();
  /** Corridas em que a agenda não respondeu e o job passou a ler as conversas
   *  sincronizadas. Vive fora do job porque é estado do processo, não do
   *  checkpoint: uma retomada tenta a agenda de novo antes de cair no fallback. */
  private readonly chatsFallback = new Set<string>();
  private readonly starts = new Map<string, Promise<ContactSyncJobStatus>>();
  private readonly options: Required<Omit<ContactSyncOptions, 'sleep'>> & { sleep: (milliseconds: number) => Promise<void> };

  constructor(private readonly worker: InternalWorkerClient, private readonly contacts: ContactIdentityResolver, private readonly jobs: ContactSyncJobStore, private readonly identitySync: { enqueue(target: IdentitySyncTarget): void }, private readonly realtime: RealtimeHub, options: ContactSyncOptions = {}) {
    this.options = {
      pageSize: options.pageSize ?? 100,
      maxContactsPerRun: options.maxContactsPerRun ?? 500,
      continuationDelayMs: options.continuationDelayMs ?? 1_000,
      maxAttempts: options.maxAttempts ?? 3,
      retryBaseMs: options.retryBaseMs ?? 250,
      staleRunningAfterMs: options.staleRunningAfterMs ?? 300_000,
      sleep: options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    };
  }

  start(workspaceId: string, wahaSession: string): Promise<ContactSyncJobStatus> {
    const key = this.key(workspaceId, wahaSession);
    const starting = this.starts.get(key);
    if (starting) return starting;
    const result = this.createStart(workspaceId, wahaSession).finally(() => this.starts.delete(key));
    this.starts.set(key, result);
    return result;
  }

  private async createStart(workspaceId: string, wahaSession: string): Promise<ContactSyncJobStatus> {
    const key = this.key(workspaceId, wahaSession);
    const previous = await this.jobs.get(workspaceId, wahaSession);
    if (previous && (this.active.has(key) || (previous.status === 'running' && !this.abandoned(previous)))) return this.view(previous);
    this.cancelling.delete(key);
    const now = new Date().toISOString();
    // Concluída recomeça do zero: a agenda pode ter crescido desde a corrida
    // anterior, e é a reexecução que puxa os contatos novos. Falha/cancelamento
    // retomam do cursor gravado — o trabalho já ingerido não se repete.
    const job: ContactSyncJob = previous && previous.status === 'completed'
      ? { ...previous, status: 'pending', cursor: '0', contactsProcessed: 0, contactsResolved: 0, contactsSkipped: 0, startedAt: now, completedAt: null, lastErrorSafe: null, updatedAt: now }
      : previous
        ? { ...previous, status: 'pending', completedAt: null, lastErrorSafe: null, updatedAt: now }
        : { id: randomUUID(), workspaceId, wahaSession, status: 'pending', cursor: '0', contactsProcessed: 0, contactsResolved: 0, contactsSkipped: 0, startedAt: now, completedAt: null, lastErrorSafe: null, updatedAt: now };
    await this.save(job, previous?.status === 'running' ? 'adopted after an interrupted run' : previous?.status === 'failed' || previous?.status === 'cancelled' ? 'resumed manually' : 'started');
    this.launch(job);
    return this.view(job);
  }

  /** Mesma regra do histórico: `active` só conhece corridas deste processo, e um
   *  job cujo processo morreu ficaria `running` para sempre — com o botão da UI
   *  desabilitado. Checkpoint é gravado a cada página, então silêncio muito
   *  maior que uma página significa que ninguém é dono do job. */
  private abandoned(job: ContactSyncJob): boolean {
    const updatedAt = Date.parse(job.updatedAt);
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= this.options.staleRunningAfterMs;
  }

  async status(workspaceId: string, wahaSession: string): Promise<ContactSyncJobStatus | undefined> {
    const job = await this.jobs.get(workspaceId, wahaSession);
    return job ? this.view(job) : undefined;
  }

  async cancel(workspaceId: string, wahaSession: string): Promise<ContactSyncJobStatus | undefined> {
    const job = await this.jobs.get(workspaceId, wahaSession);
    if (!job || job.status === 'completed') return job ? this.view(job) : undefined;
    // A corrida lê este conjunto entre dois contatos da mesma página, então o
    // cancelamento vale sem esperar a página inteira terminar.
    this.cancelling.add(this.key(workspaceId, wahaSession));
    return this.view(await this.save({ ...job, status: 'cancelled', updatedAt: new Date().toISOString() }, 'cancelled'));
  }

  private launch(job: ContactSyncJob): void {
    const key = this.key(job.workspaceId, job.wahaSession);
    if (this.active.has(key)) return;
    this.active.add(key);
    setImmediate(() => {
      // A tarefa destacada consome a própria rejeição — um `finally` rejeitado
      // sem `catch` derruba o processo (mesma lição do job de histórico).
      void this.run(job.workspaceId, job.wahaSession)
        .catch(error => log('error', 'WhatsApp contact synchronization failed', { workspaceId: job.workspaceId, wahaSession: job.wahaSession, error: error instanceof Error ? error.stack ?? error.message : String(error) }))
        .finally(() => this.active.delete(key));
    });
  }

  private async run(workspaceId: string, wahaSession: string): Promise<void> {
    const key = this.key(workspaceId, wahaSession);
    let job = await this.jobs.get(workspaceId, wahaSession);
    if (!job || job.status === 'cancelled') return;
    try {
      job = await this.save({ ...job, status: 'running', updatedAt: new Date().toISOString() }, 'running');
      let contactsThisBatch = 0;
      while (job.status === 'running') {
        job = await this.current(job);
        if (job.status === 'cancelled') return;
        // Lote fechado: checkpoint, pausa e retomada automática. A agenda de uma
        // conta grande não segura a sessão do provedor numa varredura só.
        if (contactsThisBatch >= this.options.maxContactsPerRun) {
          job = await this.save({ ...job, status: 'pending', updatedAt: new Date().toISOString() }, 'batch checkpoint persisted; continuing automatically');
          await this.options.sleep(this.options.continuationDelayMs);
          job = await this.current(job);
          if (job.status === 'cancelled') return;
          job = await this.save({ ...job, status: 'running', updatedAt: new Date().toISOString() }, 'next batch started');
          contactsThisBatch = 0;
          continue;
        }
        const offset = integerCursor(job.cursor);
        const page = await this.page(job, offset, this.options.pageSize);
        if (page.reset) {
          // O cursor paginava a agenda; o conjunto das conversas é outro e
          // começa do zero. A ingestão é idempotente, então o que já foi
          // resolvido pela agenda não se duplica ao reler como conversa.
          job = await this.save({ ...job, cursor: '0', lastErrorSafe: 'Agenda do WhatsApp não respondeu; contatos sincronizados a partir das conversas.', updatedAt: new Date().toISOString() }, 'address book timed out; falling back to synced chats');
          continue;
        }
        if (!page.items.length) {
          if (page.hasMore) {
            // Defensivo: a WAHA pagina um conjunto em memória; uma página vazia
            // com `hasMore` é o conjunto encolhendo sob o job, não o fim.
            job = await this.save({ ...job, cursor: String(offset + this.options.pageSize), updatedAt: new Date().toISOString() }, 'skipped empty contact page');
            continue;
          }
          await this.save({ ...job, status: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 'completed');
          return;
        }
        let resolved = 0;
        let skipped = 0;
        // A origem distingue "salvo no celular" de "veio do histórico de
        // conversas" na listagem (`origin` de `/domain/contacts`): no fallback
        // o item é uma conversa, não um contato da agenda.
        const source = this.chatsFallback.has(key) ? 'waha_chat_history' : 'waha_contact_sync';
        for (const item of page.items) {
          if (this.cancelling.has(key)) return;
          const outcome = await this.ingest(job, item, source);
          if (outcome === 'resolved') resolved += 1; else skipped += 1;
        }
        contactsThisBatch += page.items.length;
        job = await this.save({ ...job, cursor: String(offset + page.items.length), contactsProcessed: job.contactsProcessed + page.items.length, contactsResolved: job.contactsResolved + resolved, contactsSkipped: job.contactsSkipped + skipped, updatedAt: new Date().toISOString() }, 'contact page persisted');
        // Sem `hasMore` a próxima página repetiria itens: a WAHA pagina um
        // conjunto em memória, e o fim só é certo quando a página vem curta.
        if (!page.hasMore) {
          await this.save({ ...job, status: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 'completed');
          return;
        }
      }
    } catch (error) {
      if (!job) return;
      const latest = await this.current(job);
      if (latest.status !== 'cancelled') await this.save({ ...latest, status: 'failed', lastErrorSafe: safeError(error), updatedAt: new Date().toISOString() }, 'failed');
    } finally {
      this.chatsFallback.delete(key);
    }
  }

  /** Um contato por vez, pelo mesmo pipeline do webhook. Erro em UM contato é
   *  logado e o lote segue: um registro ruim não pode derrubar a agenda inteira. */
  private async ingest(job: ContactSyncJob, item: Record<string, unknown>, source: 'waha_contact_sync' | 'waha_chat_history'): Promise<'resolved' | 'skipped'> {
    const id = typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
    // Comparações diretas em vez dos type-guards de `conversation-identity`:
    // os guards estreitam `string` para `never` no ramo falso dentro da mesma
    // expressão, e as regras aqui são só sufixo.
    const group = item.isGroup === true || id.endsWith('@g.us');
    const technical = id === 'status@broadcast' || id.endsWith('@broadcast') || id.endsWith('@newsletter');
    const conversation = id.endsWith('@c.us') || id.endsWith('@lid') || id.endsWith('@s.whatsapp.net') || id.endsWith('@g.us');
    if (!id || group || technical || !conversation) return 'skipped';
    const phone = normalizedPhone(typeof item.number === 'string' ? item.number : undefined) ?? phoneFromIdentifier(id);
    const displayName = text(item.name) ?? text(item.pushname);
    // Um identificador sem nome e sem telefone discável não vira contato: não
    // exibe, não busca, não liga — é o que inchava a base com linhas vazias
    // (LIDs que a WAHA conhece de grupos). Se a pessoa falar com a conta, o
    // webhook cria o contato na hora, com os dados da mensagem de verdade.
    const lidOnly = id.endsWith('@lid') && !normalizedPhone(typeof item.number === 'string' ? item.number : undefined);
    if (!displayName && (!phone || lidOnly)) return 'skipped';
    // Nome que é só o próprio identificador em dígitos ("200339068317777") não é
    // nome: a WAHA preenche `name` com o id quando não conhece a pessoa, e a
    // guarda acima deixava esse fantasma passar. Telefone com mais de 13
    // dígitos também não é discável (LID tem 14-15; E.164 discável cabe em 13
    // para os países que a operação atende). Nome = telefone discável continua
    // entrando: dá para ligar.
    const digits = (value: string) => value.replace(/\D/g, '');
    const technicalName = displayName !== undefined && (digits(displayName) === digits(id.split('@')[0]) || (phone !== undefined && digits(displayName) === phone));
    if (technicalName && (!phone || phone.length > 13 || lidOnly)) return 'skipped';
    try {
      await this.contacts.resolve({ workspaceId: job.workspaceId, identifier: id, phone: phone ?? null, displayName: displayName ?? null, source });
    } catch (error) {
      log('error', 'WhatsApp contact sync skipped a contact after resolver failure', { workspaceId: job.workspaceId, wahaSession: job.wahaSession, jobId: job.id, errorClass: error instanceof Error ? error.name : 'UnknownError' });
      return 'skipped';
    }
    // Enriquecimento (nome/foto/pushName) sob demanda: a fila já deduplica por
    // alvo e o cache de 24 h no banco torna a reexecução barata.
    this.identitySync.enqueue({ workspaceId: job.workspaceId, wahaSession: job.wahaSession, chatId: id });
    return 'resolved';
  }

  /** A página vem da agenda (`contacts.page`) enquanto ela responde. Esgotado o
   *  backoff com `TIMEOUT` — a WAHA materializa o store inteiro da sessão para
   *  responder `contacts/all`, e há base que não cabe no orçamento — a corrida
   *  passa a ler as conversas que o telefone já sincronizou (`history.page`,
   *  kind `chats`): é o pedido de quem opera, "sincronizar as conversas para
   *  depois puxar os contatos". `reset` avisa o laço para zerar o cursor,
   *  porque o offset da agenda não vale no conjunto das conversas. */
  private async page(job: ContactSyncJob, offset: number, limit: number): Promise<{ items: Record<string, unknown>[]; hasMore: boolean; reset?: boolean }> {
    if (this.chatsFallback.has(this.key(job.workspaceId, job.wahaSession))) return this.chatsPage(job, offset, limit);
    try {
      return await this.requestPage(job, { type: 'contacts.page', payload: { wahaSession: job.wahaSession, offset, limit } }, data => {
        const page = (data as { contactsPage?: { items?: Record<string, unknown>[]; hasMore?: boolean } }).contactsPage;
        if (!page) throw new ProviderFailure('PROVIDER_CONTRACT_ERROR');
        return { items: page.items ?? [], hasMore: page.hasMore === true };
      });
    } catch (error) {
      if (error instanceof ProviderFailure && error.code === 'TIMEOUT') {
        this.chatsFallback.add(this.key(job.workspaceId, job.wahaSession));
        log('info', 'WhatsApp contact sync falling back to synced chats after address book timeouts', { workspaceId: job.workspaceId, wahaSession: job.wahaSession, jobId: job.id });
        return { items: [], hasMore: true, reset: true };
      }
      throw error;
    }
  }

  /** As conversas da sessão como fonte de contatos: quem já conversou com a
   *  conta é exatamente o subconjunto que o picker mais precisa quando a agenda
   *  inteira não cabe no orçamento. Grupos e canais são rejeitados na ingestão. */
  private chatsPage(job: ContactSyncJob, offset: number, limit: number): Promise<{ items: Record<string, unknown>[]; hasMore: boolean }> {
    return this.requestPage(job, { type: 'history.page', payload: { wahaSession: job.wahaSession, offset, limit } }, data => {
      const page = (data as { historyPage?: { kind?: string; items?: Record<string, unknown>[]; hasMore?: boolean } }).historyPage;
      if (!page || page.kind !== 'chats') throw new ProviderFailure('PROVIDER_CONTRACT_ERROR');
      return { items: page.items ?? [], hasMore: page.hasMore === true };
    });
  }

  private async requestPage(job: ContactSyncJob, command: InternalTransportCommand, extract: (data: unknown) => { items: Record<string, unknown>[]; hasMore: boolean }): Promise<{ items: Record<string, unknown>[]; hasMore: boolean }> {
    let last: ProviderFailure | undefined;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      // Sem deadline próprio: o cliente de transporte já carrega o orçamento do
      // deployment, e um segundo número aqui era o que deixava os dois divergirem.
      const response = await this.worker.send({ correlationId: `contact-sync-${randomUUID()}`, workspaceId: job.workspaceId, command });
      if (response.success) return extract(response.data);
      last = new ProviderFailure(response.error.code, response.error.message);
      if (!transientCodes.has(last.code) || attempt === this.options.maxAttempts) throw last;
      await this.options.sleep(Math.min(this.options.retryBaseMs * 2 ** (attempt - 1), 4_000));
    }
    throw last ?? new ProviderFailure('SERVICE_UNAVAILABLE');
  }

  private async current(job: ContactSyncJob): Promise<ContactSyncJob> { return (await this.jobs.get(job.workspaceId, job.wahaSession)) ?? job; }

  private async save(job: ContactSyncJob, event: string): Promise<ContactSyncJob> {
    await this.jobs.save(job);
    const status = this.view(job);
    this.realtime.publish(job.workspaceId, 'conversation.sync.updated', { jobId: status.jobId, syncKind: 'contacts', wahaSession: job.wahaSession, status: job.status, contactsProcessed: job.contactsProcessed, contactsResolved: job.contactsResolved, contactsSkipped: job.contactsSkipped, hasMore: status.hasMore, progressLabel: status.progressLabel, lastErrorSafe: job.lastErrorSafe, updatedAt: job.updatedAt });
    log('info', 'WhatsApp contact sync', { workspaceId: job.workspaceId, wahaSession: job.wahaSession, jobId: job.id, event, status: job.status, contactsProcessed: job.contactsProcessed, contactsResolved: job.contactsResolved, contactsSkipped: job.contactsSkipped });
    return job;
  }

  private view(job: ContactSyncJob): ContactSyncJobStatus {
    const progressLabel = job.status === 'completed'
      ? 'Agenda de contatos sincronizada.'
      : job.status === 'running'
        ? 'Sincronizando agenda de contatos…'
        : job.status === 'pending'
          ? 'Aguardando próximo ciclo…'
          : job.status === 'failed'
            ? 'Falhou; corrija o problema e retome.'
            : 'Sincronização cancelada.';
    return { ...job, jobId: job.id, syncKind: 'contacts', hasMore: job.status === 'running' || job.status === 'pending', progressLabel };
  }

  private key(workspaceId: string, wahaSession: string): string { return `${workspaceId}:${wahaSession}`; }
}

/** Store em memória, decisão consciente: a tabela `whatsapp_sync_jobs` é do job
 *  de histórico e reusá-la exigiria migration — que não se cria sem pedido
 *  explícito. O preço é perder o checkpoint num restart, e ele é baixo porque a
 *  ingestão é idempotente (resolver com `INSERT OR IGNORE` nos aliases): o job
 *  refaz leitura, não trabalho duplicado. O `staleRunningAfterMs` cobre o caso
 *  inverso — um `running` abandonado é adotado pelo próximo `start`.
 *
 *  As cópias nas duas direções são o que permite à corrida reler o job a cada
 *  página sem que mutações externas vazem para dentro dela. */
export class MemoryContactSyncStore implements ContactSyncJobStore {
  private readonly jobs = new Map<string, ContactSyncJob>();
  async get(workspaceId: string, wahaSession: string): Promise<ContactSyncJob | undefined> { const job = this.jobs.get(`${workspaceId}:${wahaSession}`); return job ? { ...job } : undefined; }
  async save(job: ContactSyncJob): Promise<void> { this.jobs.set(`${job.workspaceId}:${job.wahaSession}`, { ...job }); }
}

function integerCursor(value: string | null): number { const number = Number(value ?? 0); return Number.isInteger(number) && number >= 0 ? number : 0; }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
/** Carrega o código do provedor ao lado da mensagem — é o código que decide
 *  retry, e colapsar os dois persistia um `TIMEOUT` nu para causas diferentes. */
class ProviderFailure extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail && detail !== code ? `${code}: ${detail}` : code);
    this.name = 'ProviderFailure';
  }
}
function safeError(error: unknown): string {
  const source = error instanceof Error
    ? error.message
    : error && typeof error === 'object'
      ? [
          typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined,
          typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : undefined,
        ].filter(Boolean).join(': ')
      : '';
  return (source || 'Contact synchronization failed').replace(/(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 240);
}
