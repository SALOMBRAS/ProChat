import { describe, expect, it } from "vitest";
import type { HistorySyncJob } from "../api/inbox.js";
import { isActiveSync, progressDetail, progressPercent, resumeAttribution, syncView, type SyncResume } from "./syncProgress.js";

const job = (over: Partial<HistorySyncJob> = {}): HistorySyncJob => ({
  id: "job-a",
  jobId: "job-a",
  wahaSession: "session-a",
  status: "running",
  chatsProcessed: 240,
  messagesProcessed: 1834,
  chatsTotal: null,
  currentChat: "5511999999999@c.us",
  hasMore: true,
  progressLabel: "Sincronizando histórico…",
  lastErrorSafe: null,
  updatedAt: "2026-07-31T12:00:00.000Z",
  ...over,
});

describe("contagem do progresso", () => {
  it("conta conversas e mensagens com separador de milhar", () => {
    expect(progressDetail(job())).toBe("240 conversas percorridas, 1.834 mensagens");
  });

  it("usa o singular quando é uma só", () => {
    expect(progressDetail(job({ chatsProcessed: 1, messagesProcessed: 1 }))).toBe("1 conversa percorrida, 1 mensagem");
  });

  it("não anuncia progresso nenhum antes do primeiro chat", () => {
    expect(progressDetail(job({ chatsProcessed: 0, messagesProcessed: 0 }))).toBe("");
  });

  it("sem denominador, não diz que as conversas foram lidas", () => {
    // `chatsProcessed` conta posições andadas: inclui a conversa fechada cedo por
    // tempo esgotado, que o operador não deve achar que foi lida.
    const detail = progressDetail(job({ chatsTotal: null }));
    expect(detail).toContain("percorridas");
    expect(detail).not.toMatch(/\d+ conversas,/);
  });

  it("com total conhecido, conta de quantas e mostra a fração", () => {
    expect(progressDetail(job({ chatsProcessed: 240, chatsTotal: 551 }))).toBe("240 de 551 conversas (44%), 1.834 mensagens");
  });

  it("sem total, volta a contar sem denominador em vez de inventar um", () => {
    // `chatsTotal` nulo é "a contagem não veio", e a corrida falha aberta.
    expect(progressDetail(job({ chatsTotal: null }))).toBe("240 conversas percorridas, 1.834 mensagens");
  });

  it("total zero não é denominador, é ausência de conversa", () => {
    expect(progressDetail(job({ chatsTotal: 0 }))).toBe("240 conversas percorridas, 1.834 mensagens");
  });
});

describe("a fração andada", () => {
  it("arredonda para inteiro", () => {
    expect(progressPercent({ chatsProcessed: 240, chatsTotal: 551 })).toBe(44);
    expect(progressPercent({ chatsProcessed: 551, chatsTotal: 551 })).toBe(100);
  });

  it("prende em 100 quando a corrida anda mais posições do que o retrato tinha", () => {
    // A listagem se reordena enquanto a corrida anda: um chat que recebe mensagem
    // pula para o topo e empurra os outros, então o cursor pode passar do total
    // contado no início. Mostrar 118% seria pior do que prender.
    expect(progressPercent({ chatsProcessed: 650, chatsTotal: 551 })).toBe(100);
    expect(progressDetail(job({ chatsProcessed: 650, chatsTotal: 551 }))).toBe("551 de 551 conversas (100%), 1.834 mensagens");
  });

  it("sem denominador não há fração", () => {
    expect(progressPercent({ chatsProcessed: 240, chatsTotal: null })).toBe(0);
    expect(progressPercent({ chatsProcessed: 240, chatsTotal: 0 })).toBe(0);
  });
});

describe("a faixa de sincronização", () => {
  it("mostra o andamento enquanto roda, em vez do último rótulo gravado", () => {
    const view = syncView(job(), "unknown", false);
    expect(view.tone).toBe("active");
    expect(view.headline).toBe("Sincronizando o histórico");
    expect(view.detail).toBe("240 conversas percorridas, 1.834 mensagens");
    // Rodando não se retoma: o botão que aparece é o de cancelar.
    expect(view.canStart).toBe(false);
    expect(view.canCancel).toBe(true);
  });

  it("um job que falhou e voltou a rodar não continua dizendo que falhou", () => {
    // É o defeito relatado: `progressLabel` guarda a última frase gravada, e um
    // job retomado seguia anunciando "Falhou; corrija o problema e retome".
    const view = syncView(job({ status: "running", progressLabel: "Falhou; corrija o problema e retome." }), "unknown", false);
    expect(view.headline).toBe("Sincronizando o histórico");
    expect(`${view.headline} ${view.detail} ${view.note}`).not.toMatch(/falh/i);
  });

  it("na fila, diz que está na fila e não finge que já processa", () => {
    const view = syncView(job({ status: "pending", chatsProcessed: 0, messagesProcessed: 0 }), "unknown", false);
    expect(view.headline).toBe("Sincronização na fila");
    expect(view.detail).toBe("Aguardando o primeiro ciclo");
    expect(view.canCancel).toBe(true);
  });

  it("só o estado de falha oferece retomar, e mostra o erro seguro", () => {
    const view = syncView(job({ status: "failed", lastErrorSafe: "A WAHA recusou a sessão." }), "unknown", false);
    expect(view.tone).toBe("error");
    expect(view.headline).toBe("A sincronização falhou");
    expect(view.note).toBe("A WAHA recusou a sessão.");
    expect(view.startLabel).toBe("Retomar sincronização");
    expect(view.canStart).toBe(true);
    expect(view.canCancel).toBe(false);
  });

  it("cancelada oferece retomar sem pintar de erro", () => {
    const view = syncView(job({ status: "cancelled" }), "unknown", false);
    expect(view.tone).toBe("idle");
    expect(view.headline).toBe("Sincronização cancelada");
    expect(view.startLabel).toBe("Retomar sincronização");
  });

  it("concluída sem truncamento é conclusão limpa", () => {
    const view = syncView(job({ status: "completed" }), "unknown", false);
    expect(view.tone).toBe("done");
    expect(view.headline).toBe("Histórico sincronizado");
    expect(view.note).toBe("");
  });

  it("concluída com truncamento avisa, porque o histórico não ficou completo", () => {
    const view = syncView(job({ status: "completed", lastErrorSafe: "tempo esgotado no chat" }), "unknown", false);
    expect(view.tone).toBe("warn");
    expect(view.note).toBe("Conversas muito longas foram truncadas.");
  });

  it("sem job nenhum, não é falha e não oferece retomar", () => {
    const view = syncView(undefined, "unknown", false);
    expect(view.headline).toBe("Histórico não sincronizado");
    expect(view.startLabel).toBe("Sincronizar histórico");
    expect(view.tone).toBe("idle");
  });

  it("nunca mostra porcentagem, porque não há denominador", () => {
    // O job não carrega o total de conversas da sessão (ver o cabeçalho de
    // syncProgress.ts). Inventar um "de 550" seria número falso na tela.
    for (const status of ["pending", "running", "completed", "failed", "cancelled"] as const) {
      const view = syncView(job({ status }), "unknown", false);
      expect(`${view.headline} ${view.detail} ${view.note}`).not.toContain("%");
    }
  });

  it("nunca vaza o identificador da conversa em curso", () => {
    // Regra 6 do CLAUDE.md: JID não é informação de usuário.
    const view = syncView(job({ currentChat: "5511999999999@c.us" }), "unknown", false);
    expect(`${view.headline} ${view.detail} ${view.note}`).not.toContain("@c.us");
  });

  it("enquanto o pedido está em voo, o botão diz o que está fazendo", () => {
    expect(syncView(job({ status: "failed" }), "unknown", true).startLabel).toBe("Retomando…");
    expect(syncView(undefined, "unknown", true).startLabel).toBe("Iniciando…");
  });
});

describe("quem retomou a sincronização", () => {
  it("credita ao operador quando o clique daqui precedeu a transição", () => {
    expect(resumeAttribution("failed", "pending", true, "unknown")).toBe("operator");
    expect(syncView(job({ status: "running" }), "operator", false).note).toBe("Retomada por você.");
  });

  it("credita ao servidor quando o job voltou a andar sem clique", () => {
    expect(resumeAttribution("failed", "running", false, "unknown")).toBe("auto");
    expect(syncView(job(), "auto", false).note).toBe("Retomada automaticamente.");
  });

  it("não atribui nada quando a tela abriu com o job já rodando", () => {
    // Sem transição observada não há o que creditar, e chutar "automática" seria
    // informação inventada.
    expect(resumeAttribution(undefined, "running", false, "unknown")).toBe("unknown");
    expect(syncView(job(), "unknown", false).note).toBe("");
  });

  it("respirar entre ciclos não é retomada", () => {
    expect(resumeAttribution("running", "pending", false, "operator")).toBe("operator");
    expect(resumeAttribution("pending", "running", false, "auto")).toBe("auto");
  });

  it("parar apaga a atribuição, para a próxima retomada começar limpa", () => {
    for (const status of ["completed", "failed", "cancelled", undefined] as const)
      expect(resumeAttribution("running", status, false, "operator")).toBe("unknown");
  });

  it("o crédito ao operador não sobrevive a uma retomada seguinte sem clique", () => {
    const afterClick: SyncResume = resumeAttribution("failed", "running", true, "unknown");
    expect(afterClick).toBe("operator");
    const afterStop = resumeAttribution("running", "failed", false, afterClick);
    expect(afterStop).toBe("unknown");
    expect(resumeAttribution("failed", "running", false, afterStop)).toBe("auto");
  });
});

describe("quais estados contam como ativos", () => {
  it("rodando e na fila são ativos; o resto não", () => {
    expect(isActiveSync("running")).toBe(true);
    expect(isActiveSync("pending")).toBe(true);
    for (const status of ["completed", "failed", "cancelled", undefined] as const) expect(isActiveSync(status)).toBe(false);
  });
});
