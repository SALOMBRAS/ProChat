/** O estado da sincronização de histórico, do jeito que o operador precisa ler.
 *
 *  Fica fora do componente porque é a parte que pede teste próprio: são regras de
 *  redação e de atribuição, não desenho.
 *
 *  ## Por que não há porcentagem
 *
 *  "240 de 550 conversas (44%)" precisa de um denominador, e ele não existe.
 *
 *  O job (`SyncJob`, em `whatsapp-history-sync.service.ts`) carrega `status`,
 *  `chatsProcessed`, `messagesProcessed`, `chatCursor`, `currentChatId`,
 *  `messageCursor`, `startedAt`, `completedAt` e `lastErrorSafe`. A projeção que
 *  chega em `/api/v1/inbox/sync/status` acrescenta `jobId`, `currentChat`,
 *  `hasMore` e `progressLabel`. **Nenhum campo traz o total de conversas da
 *  sessão.**
 *
 *  `chatCursor` engana: é a posição do cursor na lista de chats, e anda junto com
 *  `chatsProcessed` — é o mesmo número com outro nome, não o alvo.
 *
 *  O total de conversas já importadas (`conversationPage.total`) também não serve:
 *  ele cresce *por causa* da sincronização. Seria numerador dos dois lados da
 *  divisão e mostraria 100% o tempo inteiro, que é pior do que não mostrar nada.
 *
 *  Para haver porcentagem, o servidor precisaria contar os chats da sessão na WAHA
 *  ao abrir o job e gravar esse número — um campo novo (`chatsTotal`) na tabela
 *  `whatsapp_sync_jobs`, no tipo `SyncJob` e na projeção de status. Enquanto ele
 *  não existir, esta tela conta o que de fato sabe e não finge precisão.
 *
 *  ## Por que a conversa atual não aparece
 *
 *  `currentChat` é um JID (`5511999999999@c.us`). A regra 6 do CLAUDE.md proíbe
 *  renderizar identificador técnico como informação visível, e resolver o JID para
 *  um nome exigiria uma busca por conversa a cada tique do polling. Fica de fora.
 */
import type { HistorySyncJob } from "../api/inbox.js";

export type SyncStatus = HistorySyncJob["status"];
/** Quem pôs o job para andar. `unknown` é a resposta honesta quando a tela abriu
 *  com ele já rodando: aí não houve transição para observar. */
export type SyncResume = "operator" | "auto" | "unknown";
/** Só para escolher a cor da faixa. Não carrega texto. */
export type SyncTone = "idle" | "active" | "done" | "warn" | "error";

export type SyncView = {
  tone: SyncTone;
  headline: string;
  /** A contagem, ou "" quando ainda não há o que contar. */
  detail: string;
  /** A linha extra: atribuição da retomada, truncamento, ou o erro seguro. */
  note: string;
  busy: boolean;
  canStart: boolean;
  canCancel: boolean;
  startLabel: string;
};

const ACTIVE: readonly SyncStatus[] = ["running", "pending"];
export const isActiveSync = (status?: SyncStatus): boolean => !!status && ACTIVE.includes(status);

const decimal = new Intl.NumberFormat("pt-BR");
const count = (value: number, one: string, many: string) =>
  `${decimal.format(Math.max(0, Math.trunc(value || 0)))} ${Math.abs(value) === 1 ? one : many}`;

/** "240 conversas, 1.834 mensagens" — e "" enquanto os dois são zero, para a faixa
 *  não anunciar um progresso que ainda não houve. */
export const progressDetail = (job: Pick<HistorySyncJob, "chatsProcessed" | "messagesProcessed">): string =>
  job.chatsProcessed || job.messagesProcessed
    ? `${count(job.chatsProcessed, "conversa", "conversas")}, ${count(job.messagesProcessed, "mensagem", "mensagens")}`
    : "";

const RESUME_NOTE: Record<SyncResume, string> = {
  operator: "Retomada por você.",
  auto: "Retomada automaticamente.",
  unknown: "",
};

/** Decide a quem creditar a retomada, observando a transição de status.
 *
 *  Só uma transição de um status parado para um status ativo é uma retomada. Abrir
 *  a tela com o job já rodando não é — não há transição, e chutar "automática"
 *  seria informação inventada. `running -> pending` também não é: é o mesmo job
 *  respirando entre ciclos.
 */
export const resumeAttribution = (
  previous: SyncStatus | undefined,
  next: SyncStatus | undefined,
  operatorAsked: boolean,
  current: SyncResume,
): SyncResume => {
  if (!isActiveSync(next)) return "unknown";
  if (previous === next) return current;
  // Primeira observação: a tela acabou de abrir e o job já estava assim.
  if (!previous) return "unknown";
  if (isActiveSync(previous)) return current;
  return operatorAsked ? "operator" : "auto";
};

/** O job em palavras. `undefined` é "nunca sincronizou nesta sessão", que não é
 *  falha nenhuma e não deve oferecer "retomar". */
export const syncView = (job: HistorySyncJob | undefined, resume: SyncResume, starting: boolean): SyncView => {
  const base = { busy: starting, canCancel: false, startLabel: starting ? "Iniciando…" : "Sincronizar histórico" };
  if (!job)
    return { ...base, tone: "idle", headline: "Histórico não sincronizado", detail: "", note: "", canStart: true };

  const detail = progressDetail(job);
  if (job.status === "running" || job.status === "pending")
    return {
      ...base,
      tone: "active",
      headline: job.status === "running" ? "Sincronizando o histórico" : "Sincronização na fila",
      // "Aguardando o primeiro ciclo" só cabe enquanto nada foi processado; um job
      // pendente que já trouxe conversas está entre ciclos, não parado.
      detail: detail || (job.status === "pending" ? "Aguardando o primeiro ciclo" : "Procurando conversas"),
      note: RESUME_NOTE[resume],
      canStart: false,
      canCancel: true,
    };

  if (job.status === "completed")
    return {
      ...base,
      // Um job que fechou conversas longas antes do fim terminou, mas não trouxe
      // tudo: esconder isso reportaria um histórico exaustivo que não é.
      tone: job.lastErrorSafe ? "warn" : "done",
      headline: "Histórico sincronizado",
      detail,
      note: job.lastErrorSafe ? "Conversas muito longas foram truncadas." : "",
      canStart: true,
    };

  if (job.status === "failed")
    return {
      ...base,
      tone: "error",
      headline: "A sincronização falhou",
      detail,
      note: job.lastErrorSafe ?? "",
      canStart: true,
      startLabel: starting ? "Retomando…" : "Retomar sincronização",
    };

  return {
    ...base,
    tone: "idle",
    headline: "Sincronização cancelada",
    detail,
    note: "",
    canStart: true,
    startLabel: starting ? "Retomando…" : "Retomar sincronização",
  };
};
