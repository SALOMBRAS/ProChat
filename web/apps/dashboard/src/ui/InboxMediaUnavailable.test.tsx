import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { InboxApi, InboxConversation, InboxMessage, Page } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * Mídia que não volta.
 *
 * A WAHA guarda o arquivo por 180 s e o descarta. A mensagem que não foi
 * persistida nessa janela fica no banco com `mediaPersistenceStatus =
 * 'unavailable'`: registro, legenda e metadados, sem arquivo. O reprocessamento
 * do histórico traz ~4.587 mensagens assim.
 *
 * Medido na base e na API de produção em 03/08/2026, e é o que estes testes
 * imitam:
 *
 *   payload da Inbox    tem `mediaUrl`, NÃO tem `mediaPersistenceStatus`
 *   GET media/access    200, devolve a URL do proxy
 *   GET/HEAD no proxy   404 {"code":"NOT_FOUND","message":"Media file not found"}
 *
 * Como o campo de estado não chega ao dashboard, quem responde "sumiu de vez" é
 * o proxy — e por isso a pergunta é feita uma vez, depois de o elemento já ter
 * falhado. Antes desta correção a imagem virava ícone quebrado, o vídeo dizia
 * "Formato de vídeo inválido ou não suportado" sobre um arquivo que não existe,
 * e o documento baixava um JSON de 404.
 */
const conversationId = "11111111-1111-4111-8111-111111111111";
const conversation = (): InboxConversation => ({
  id: conversationId, whatsappSessionId: "session-a", chatId: "5511999990001@c.us", contactId: null, conversationType: "direct",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Ana", phone: "5511999990001", pushName: "Ana", profileName: "Ana", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
/** O `mediaUrl` morto que a linha de produção guarda, e nenhum campo de estado —
 *  é exatamente o que a API entrega hoje. */
const message = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: "m-1", direction: "inbound", content: null, timestamp: "2026-07-29T12:00:00.000Z",
  status: "received", messageType: "text", chatId: "5511999990001@c.us", metadata: {},
  mediaUrl: "http://127.0.0.1:3002/api/files/chatpro-4221/arquivo", ...over,
});
const page = <T,>(items: T[]): Page<T> => ({ items, page: 1, pageSize: 50, total: items.length });

const api = (messages: InboxMessage[]) => ({
  conversations: vi.fn().mockResolvedValue(page([conversation()])),
  messages: vi.fn().mockResolvedValue(page(messages)),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  mediaUrl: vi.fn().mockResolvedValue({ url: "/api/v1/inbox/messages/m-1/media?access_token=t", expiresAt: "2026-07-29T13:00:00.000Z" }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}) as unknown as InboxApi;

/** O proxy. `sumiu` devolve o 404 real; qualquer outro status é problema de agora. */
let respostas: number[] = [];
let sondas: Array<{ url: string; method?: string }> = [];
const proxy = (...status: number[]) => { respostas = status; };
beforeEach(() => {
  respostas = [404];
  sondas = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    sondas.push({ url: String(url), method: init?.method });
    const status = respostas[Math.min(sondas.length - 1, respostas.length - 1)];
    return Promise.resolve({ status, ok: status < 400 } as Response);
  }));
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn().mockReturnValue("blob:preview"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null) as never;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const abrirConversa = async (messages: InboxMessage[]) => {
  const client = api(messages);
  render(<Inbox api={client} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  await screen.findByLabelText("Adicionar anexo");
  return client;
};
/** O elemento só falha quando o navegador tenta carregar; o jsdom não tenta, então
 *  o `error` é disparado à mão — é o mesmo evento que o navegador emitiria. */
const falhar = async (seletor: string) => {
  const node = await waitFor(() => {
    const found = document.querySelector(seletor);
    if (!found) throw new Error(`sem ${seletor}`);
    return found;
  });
  fireEvent.error(node);
};
const cartao = () => screen.findByText(/indisponível$/);

describe("mídia que o WhatsApp já descartou", () => {
  it("imagem: troca o ícone quebrado por um aviso que não parece erro do sistema", async () => {
    await abrirConversa([message({ id: "m-1", messageType: "image", mediaMimeType: "image/jpeg", mediaSize: 23255, content: "🔥 Monitor Gamer" })]);

    await falhar(".message-image-preview img");

    expect(await cartao()).toHaveTextContent("Imagem indisponível");
    expect(screen.getByText(/já o descartou/)).toBeTruthy();
    // O tamanho sobreviveu à perda do arquivo e continua dizendo do que se trata.
    expect(screen.getByText("23 KB")).toBeTruthy();
    // E a legenda é do balão, não do cartão: some o arquivo, fica o texto.
    expect(screen.getByText("🔥 Monitor Gamer")).toBeTruthy();
  });

  it("figurinha: é chamada de figurinha, não de imagem", async () => {
    await abrirConversa([message({ id: "m-1", messageType: "sticker", mediaMimeType: "image/webp" })]);

    await falhar(".message-image-preview img");

    expect(await cartao()).toHaveTextContent("Figurinha indisponível");
  });

  it("vídeo: para de culpar o formato por um arquivo que não existe", async () => {
    await abrirConversa([message({ id: "m-1", messageType: "video", mediaMimeType: "video/mp4", metadata: { _data: { duration: "35" } } })]);

    await falhar("video");

    expect(await cartao()).toHaveTextContent("Vídeo indisponível");
    expect(screen.queryByText(/Formato de vídeo inválido/)).toBeNull();
    // A duração veio do payload e continua à vista.
    expect(screen.getByText(/0:35/)).toBeTruthy();
  });

  it("nota de voz: o aviso aparece sem o operador precisar clicar em tocar", async () => {
    await abrirConversa([message({ id: "m-1", messageType: "ptt", mediaMimeType: "audio/ogg", metadata: { _data: { type: "ptt", duration: "8" } } })]);

    await falhar(".voice-note audio");

    expect(await cartao()).toHaveTextContent("Mensagem de voz indisponível");
  });

  it("arquivo de áudio: mantém nome e duração ao lado do aviso", async () => {
    await abrirConversa([message({ id: "m-1", messageType: "audio", mediaMimeType: "audio/mpeg", mediaFilename: "entrevista.mp3", metadata: { _data: { duration: "125" } } })]);

    await falhar(".audio-track audio");

    expect(await cartao()).toHaveTextContent("Áudio indisponível");
    expect(screen.getByText(/entrevista\.mp3/)).toBeTruthy();
    expect(screen.getByText(/2:05/)).toBeTruthy();
  });

  it("documento: o primeiro clique pergunta antes de baixar, em vez de entregar um 404", async () => {
    await abrirConversa([message({ id: "m-1", messageType: "document", mediaMimeType: "application/pdf", mediaFilename: "contrato.pdf", mediaSize: 91234 })]);

    const link = await screen.findByLabelText("Baixar contrato.pdf");
    fireEvent.click(link);

    expect(await cartao()).toHaveTextContent("Documento indisponível");
    expect(screen.getByText(/contrato\.pdf/)).toBeTruthy();
  });

  it("documento que ainda existe baixa normalmente, sem virar aviso", async () => {
    proxy(200);
    await abrirConversa([message({ id: "m-1", messageType: "document", mediaMimeType: "application/pdf", mediaFilename: "vivo.pdf" })]);

    const link = await screen.findByLabelText("Baixar vivo.pdf");
    let cliques = 0;
    link.addEventListener("click", () => { cliques += 1; });
    fireEvent.click(link);

    await waitFor(() => expect(sondas).toHaveLength(1));
    // O primeiro clique foi engolido para perguntar; o download só acontece se o
    // clique for repassado ao link depois da resposta. Sem isso o cartão continua
    // bonito na tela e o arquivo nunca baixa.
    await waitFor(() => expect(cliques).toBe(2));
    expect(screen.queryByText(/indisponível/)).toBeNull();
    expect(screen.getByLabelText("Baixar vivo.pdf")).toBeTruthy();
  });

  it("falha passageira não vira perda: 502 mantém a mensagem de agora", async () => {
    proxy(502);
    await abrirConversa([message({ id: "m-1", messageType: "video", mediaMimeType: "video/mp4" })]);

    await falhar("video");

    await waitFor(() => expect(sondas).toHaveLength(1));
    // Chamar de perdido o que talvez volte apagaria a diferença entre "tente de
    // novo" e "não há o que tentar".
    expect(screen.queryByText(/indisponível/)).toBeNull();
    expect(screen.getByText(/Formato de vídeo inválido/)).toBeTruthy();
  });

  it("rede caída também não vira perda", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await abrirConversa([message({ id: "m-1", messageType: "image", mediaMimeType: "image/jpeg" })]);

    await falhar(".message-image-preview img");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/indisponível/)).toBeNull();
  });

  it("pergunta uma vez por mídia, e com HEAD: uma por mensagem no render seria N+1", async () => {
    proxy(502);
    await abrirConversa([message({ id: "m-1", messageType: "image", mediaMimeType: "image/jpeg" })]);
    // Nada é perguntado enquanto a mídia carrega bem.
    expect(sondas).toHaveLength(0);

    // O elemento pode falhar mais de uma vez — o `src` é reavaliado a cada
    // repintura. Perguntar de novo a cada falha multiplicaria as requisições
    // justamente na conversa que tem mais mídia quebrada.
    await falhar(".message-image-preview img");
    await waitFor(() => expect(sondas).toHaveLength(1));
    await falhar(".message-image-preview img");
    await falhar(".message-image-preview img");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sondas).toHaveLength(1);
    expect(sondas[0].method).toBe("HEAD");
    expect(sondas[0].url).toContain("/media?access_token=");
  });

  it("o cartão tem estilo próprio, cinza e sem hex novo", () => {
    // Vermelho faria o operador procurar defeito no sistema a cada mensagem antiga.
    const regra = /\.chat-inbox \.message-media-gone\s*\{([^}]*)\}/.exec(stylesheet);
    expect(regra, "regra .message-media-gone ausente").toBeTruthy();
    expect(regra![1]).toMatch(/border/);
    for (const token of new Set([...regra![1].matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0])))
      expect(stylesheet.split(token).length - 1, `${token} é uma cor nova`).toBeGreaterThan(1);
  });
});

describe("download do documento com barra", () => {
  it("pergunta com HEAD, baixa com GET e entrega o blob com o nome original", async () => {
    const criouURL = vi.fn().mockReturnValue("blob:download");
    Object.defineProperty(URL, "createObjectURL", { value: criouURL, configurable: true });
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      sondas.push({ url: String(url), method: init?.method });
      if (init?.method === "HEAD") return Promise.resolve({ status: 200, ok: true } as Response);
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "application/pdf", "content-length": "4" } }));
    }));
    await abrirConversa([message({ id: "m-1", messageType: "document", mediaMimeType: "application/pdf", mediaFilename: "vivo.pdf", mediaSize: 4 })]);

    fireEvent.click(await screen.findByLabelText("Baixar vivo.pdf"));

    await waitFor(() => expect(sondas).toHaveLength(2));
    expect(sondas[0].method).toBe("HEAD");
    expect(sondas[1].method).toBeUndefined();
    // O blob baixado virou object URL para a âncora de download.
    await waitFor(() => expect(criouURL).toHaveBeenCalled());
    // Sem resíduo: a barra some quando o download termina, e nenhum aviso aparece.
    await waitFor(() => expect(document.querySelector(".document-progress")).toBeNull());
    expect(screen.queryByText(/indisponível/)).toBeNull();
  });
});
