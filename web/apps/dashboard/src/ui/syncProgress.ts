/** O estado da sincronização de histórico, do jeito que o operador precisa ler.
 *
 *  Fica fora do componente porque é a parte que pede teste próprio: são regras de
 *  redação e de atribuição, não desenho.
 *
 *  ## De onde vem a porcentagem
 *
 *  Do `chatsTotal` do job, contado uma vez por corrida. A WAHA não tem rota de
 *  contagem para chats, então o servidor descobre o total por busca binária sobre
 *  o `offset` (ver `countChats` em whatsapp-history-sync.service.ts e
 *  web/docs/history-sync-chats-total.md).
 *
 *  `chatsTotal` é **nulo** quando a contagem não veio — a corrida falha aberta e
 *  segue sem denominador. Nulo não é zero: zero seria "nenhuma conversa". Sem
 *  total, esta tela volta a contar sem porcentagem, que é o que ela fazia antes.
 *
 *  A porcentagem é **presa em 100%** de propósito. O numerador conta posições
 *  andadas na listagem, e a listagem se reordena enquanto a corrida anda: um chat
 *  que recebe mensagem pula para o topo e empurra os outros para trás, então a
 *  corrida pode consumir mais posições do que o total que contou no início. O
 *  denominador é um retrato, não uma verdade estável.
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
export const progressDetail = (job: Pick<HistorySyncJob, "chatsProcessed" | "messagesProcessed" | "chatsTotal">): string => {
  if (!job.chatsProcessed && !job.messagesProcessed) return "";
  const messages = count(job.messagesProcessed, "mensagem", "mensagens");
  const total = job.chatsTotal ?? 0;
  if (total <= 0) return `${count(job.chatsProcessed, "conversa", "conversas")}, ${messages}`;
  const walked = Math.min(job.chatsProcessed, total);
  return `${decimal.format(walked)} de ${count(total, "conversa", "conversas")} (${progressPercent(job)}%), ${messages}`;
};

/** A fração andada, de 0 a 100. Presa nas duas pontas: o denominador é o retrato
 *  do começo da corrida, e a listagem anda por baixo dele. */
export const progressPercent = (job: Pick<HistorySyncJob, "chatsProcessed" | "chatsTotal">): number => {
  const total = job.chatsTotal ?? 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((job.chatsProcessed / total) * 100)));
};

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
