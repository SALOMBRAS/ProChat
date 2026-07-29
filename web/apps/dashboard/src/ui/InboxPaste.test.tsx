import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { InboxApi, InboxConversation, Page } from "../api/inbox.js";
import { ATTACHMENT_POLICY } from "./attachmentIntake.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * Colar imagem direto no compositor, e arrastar arquivo sobre a conversa.
 *
 * Os dois caminhos chegam pelo mesmo `DataTransfer` e terminam no mesmo
 * `applyAttachment` do menu "+". O que estes testes prendem é o que o operador
 * percebe: a imagem vira anexo, o texto continua colando, e o que não serve diz
 * por que não serve em vez de sumir.
 */
const conversation = (id: string): InboxConversation => ({
  id, whatsappSessionId: "session-a", chatId: "5511999990001@c.us", contactId: null, conversationType: "direct",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Ana", phone: "5511999990001", pushName: "Ana", profileName: "Ana", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
const conversationId = "11111111-1111-4111-8111-111111111111";
const emptyPage = <T,>(): Page<T> => ({ items: [], page: 1, pageSize: 50, total: 0 });
const api = () => ({
  conversations: vi.fn().mockResolvedValue({ items: [conversation(conversationId)], page: 1, pageSize: 50, total: 1 }),
  messages: vi.fn().mockResolvedValue(emptyPage()),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  sendAttachment: vi.fn().mockResolvedValue({ id: "job-1", status: "pending" }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}) as unknown as InboxApi;

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const GIF = [0x47, 0x49, 0x46, 0x38];
const file = (name: string, type: string, content: number[]) => new File([new Uint8Array(content)], name, { type });
const print = (name = "image.png") => file(name, "image/png", PNG);
const sized = (source: File, size: number) => { Object.defineProperty(source, "size", { value: size }); return source; };

/** `clipboardData` e `dataTransfer` são o mesmo objeto; o jsdom não constrói
 *  nenhum dos dois, então vem à mão. */
const transfer = (options: { files?: File[]; items?: { kind: string; getAsFile: () => File | null }[]; text?: string; html?: string }) => ({
  files: options.files ?? [],
  items: options.items ?? [],
  types: [...(options.files?.length || options.items?.length ? ["Files"] : []), ...(options.text ? ["text/plain"] : []), ...(options.html ? ["text/html"] : [])],
  getData: (format: string) => (format === "text/plain" ? options.text ?? "" : format === "text/html" ? options.html ?? "" : ""),
}) as unknown as DataTransfer;

const dispatch = (target: Element, type: string, payload: Record<string, unknown>) => {
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), payload);
  fireEvent(target, event);
  return event;
};

const abrirConversa = async (client = api()) => {
  render(<Inbox api={client} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  await screen.findByLabelText("Adicionar anexo");
  return {
    client,
    composer: document.querySelector<HTMLFormElement>(".message-composer")!,
    conversa: document.querySelector<HTMLElement>(".inbox-history")!,
  };
};
const colar = (composer: HTMLFormElement, data: DataTransfer) => dispatch(composer, "paste", { clipboardData: data });
const soltar = (conversa: HTMLElement, data: DataTransfer) => dispatch(conversa, "drop", { dataTransfer: data });
const anexoPendente = () => document.querySelector(".composer-pending-attachment");

beforeEach(() => {
  // O composer gera prévia de imagem e o editor abre a imagem por object URL.
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn().mockReturnValue("blob:preview"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null) as never;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("colar no compositor", () => {
  it("print de tela vira anexo e cai no mesmo envio do menu +", async () => {
    const { client, composer } = await abrirConversa();
    const evento = colar(composer, transfer({ files: [print()] }));
    // Impedir o padrão é o que evita o navegador colar o nome do arquivo como texto.
    expect(evento.defaultPrevented).toBe(true);

    await screen.findByText("image.png");
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    const [enviadaEm, arquivo] = (client.sendAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(enviadaEm).toBe(conversationId);
    expect((arquivo as File).type).toBe("image/png");
  });

  it("pega a colagem feita dentro do campo de mensagem, que é onde o cursor está", async () => {
    // O handler mora no form; o evento nasce no textarea e sobe. É esse o caminho
    // real — o teste que dispara no form não provaria a subida.
    await abrirConversa();
    dispatch(screen.getByLabelText("Mensagem"), "paste", { clipboardData: transfer({ files: [print("do-campo.png")] }) });
    await screen.findByText("do-campo.png");
  });

  it("a imagem colada abre a tela de composição, e o traço fica na barra dela", async () => {
    // Colar e enviar é o caso dominante: a tela abre, o editor não. Quem quer
    // marcar clica em Editar na barra, igual à imagem vinda do menu "+".
    const { composer } = await abrirConversa();
    colar(composer, transfer({ files: [print()] }));
    await screen.findByRole("region", { name: "Compor anexo" });
    await screen.findByText("image.png");
    expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull();

    fireEvent.click(screen.getByLabelText("Editar com a caneta"));
    await screen.findByRole("dialog", { name: "Editar imagem" });
  });

  it("colar texto puro continua colando texto", async () => {
    const { composer } = await abrirConversa();
    const evento = colar(composer, transfer({ text: "bom dia, tudo bem?" }));
    // Sem preventDefault o textarea recebe o texto do jeito que sempre recebeu.
    expect(evento.defaultPrevented).toBe(false);
    await waitFor(() => expect(anexoPendente()).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("colar formato não suportado explica o motivo, não falha calado", async () => {
    const { composer } = await abrirConversa();
    colar(composer, transfer({ files: [file("animado.gif", "image/gif", GIF)] }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent ?? "").toContain("image/gif");
    expect(alerta.textContent ?? "").toMatch(/aceita imagem JPEG, PNG ou WebP/);
    expect(anexoPendente()).toBeNull();
  });

  it("arquivo que mente sobre o tipo é recusado antes de subir", async () => {
    const { client, composer } = await abrirConversa();
    colar(composer, transfer({ files: [file("mentira.png", "image/png", PDF)] }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent ?? "").toMatch(/extens(ã|a)o trocada/);
    expect(client.sendAttachment).not.toHaveBeenCalled();
  });

  it("print acima de 15 MB é recusado com o tamanho medido", async () => {
    const { composer } = await abrirConversa();
    colar(composer, transfer({ files: [sized(print("enorme.png"), ATTACHMENT_POLICY.image.max + 1)] }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent ?? "").toContain("15.0 MB");
    expect(anexoPendente()).toBeNull();
  });

  it("imagem copiada da página, sem arquivo, diz o que fazer em vez de buscar a URL", async () => {
    const buscou = vi.fn();
    vi.stubGlobal("fetch", buscou);
    const { composer } = await abrirConversa();
    colar(composer, transfer({ html: '<img src="https://exemplo.test/banner.png">' }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent ?? "").toMatch(/salve a imagem/i);
    // O src é conteúdo de terceiro: buscá-lo viraria uma requisição do navegador
    // do operador para um endereço que ele não escolheu.
    expect(buscou).not.toHaveBeenCalled();
    expect(anexoPendente()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("parágrafo com imagem dentro cola como texto, sem aviso", async () => {
    const { composer } = await abrirConversa();
    const evento = colar(composer, transfer({ html: '<p>veja <img src="x"></p>', text: "veja" }));
    expect(evento.defaultPrevented).toBe(false);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("colar várias imagens anexa a primeira e diz que as outras ficaram", async () => {
    const { composer } = await abrirConversa();
    colar(composer, transfer({ files: [print("um.png"), print("dois.png"), print("tres.png")] }));
    await screen.findByText("um.png");
    // O composer guarda um anexo pendente e o envio cria um job por arquivo:
    // descartar em silêncio seria pior do que dizer.
    const recado = await screen.findByRole("status");
    expect(recado.textContent ?? "").toMatch(/De 3 arquivos, só o primeiro/);
    expect(screen.queryByText("dois.png")).toBeNull();
  });

  it("navegador que só preenche items ainda anexa", async () => {
    const { composer } = await abrirConversa();
    const arquivo = print("safari.png");
    colar(composer, transfer({ items: [{ kind: "file", getAsFile: () => arquivo }] }));
    await screen.findByText("safari.png");
  });

  it("com a tela aberta, um segundo arquivo não entra por cima do primeiro", async () => {
    const { conversa, composer } = await abrirConversa();
    colar(composer, transfer({ files: [print("primeira.png")] }));
    await screen.findByRole("region", { name: "Compor anexo" });
    await screen.findByText("primeira.png");

    // É um anexo por vez: soltar outro sobre a tela não pode trocar a mídia nem a
    // legenda que já estão ali. O `dragover` nem chega a pedir o drop.
    const arrastando = dispatch(conversa, "dragover", { dataTransfer: transfer({ files: [print("segunda.png")] }) });
    expect(arrastando.defaultPrevented).toBe(false);
    soltar(conversa, transfer({ files: [print("segunda.png")] }));
    await waitFor(() => expect(screen.queryByText("segunda.png")).toBeNull());
    expect(screen.getByText("primeira.png")).toBeTruthy();
  });
});

describe("arrastar sobre a conversa", () => {
  it("mostra a moldura enquanto o arquivo está sobre a conversa", async () => {
    const { conversa } = await abrirConversa();
    const arrastando = transfer({ files: [print()] });
    dispatch(conversa, "dragenter", { dataTransfer: arrastando });
    await waitFor(() => expect(conversa.className).toContain("dropping"));
    await screen.findByText("Solte para anexar");

    dispatch(conversa, "dragleave", { dataTransfer: arrastando });
    await waitFor(() => expect(conversa.className).not.toContain("dropping"));
  });

  it("o dragover pede o drop: sem isso o navegador abre o arquivo numa aba", async () => {
    const { conversa } = await abrirConversa();
    const evento = dispatch(conversa, "dragover", { dataTransfer: transfer({ files: [print()] }) });
    expect(evento.defaultPrevented).toBe(true);
  });

  it("arrastar texto não acende a moldura nem rouba o drop", async () => {
    const { conversa } = await abrirConversa();
    const evento = dispatch(conversa, "dragover", { dataTransfer: transfer({ text: "só texto" }) });
    expect(evento.defaultPrevented).toBe(false);
    expect(conversa.className).not.toContain("dropping");
  });

  it("soltar imagem cai na mesma tela de composição que colar", async () => {
    const { conversa } = await abrirConversa();
    dispatch(conversa, "dragenter", { dataTransfer: transfer({ files: [print("arrastada.png")] }) });
    soltar(conversa, transfer({ files: [print("arrastada.png")] }));
    await screen.findByRole("region", { name: "Compor anexo" });
    await screen.findByText("arrastada.png");
    expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull();
    expect(screen.getByLabelText("Editar com a caneta")).toBeTruthy();
    await waitFor(() => expect(conversa.className).not.toContain("dropping"));
  });

  it("soltar PDF anexa sem oferecer o editor: documento não tem o que marcar", async () => {
    const { client, conversa } = await abrirConversa();
    soltar(conversa, transfer({ files: [file("contrato.pdf", "application/pdf", PDF)] }));
    await screen.findByText("contrato.pdf");
    expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull();
    expect(screen.queryByLabelText("Editar contrato.pdf")).toBeNull();

    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    expect(((client.sendAttachment as ReturnType<typeof vi.fn>).mock.calls[0][1] as File).type).toBe("application/pdf");
  });

  it("soltar formato não suportado usa a mesma mensagem de colar", async () => {
    const { conversa } = await abrirConversa();
    soltar(conversa, transfer({ files: [file("a.gif", "image/gif", GIF)] }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent ?? "").toContain("image/gif");
  });
});

describe("estilo", () => {
  it("a moldura do arrasto e o recado têm regra própria, só com tokens que já existiam", () => {
    expect(stylesheet).toMatch(/\.chat-inbox \.inbox-history\.dropping:after\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.conversation-drop-hint\s*\{/);
    const rule = /\.chat-inbox \.composer-intake-message\s*\{([^}]*)\}/.exec(stylesheet);
    expect(rule, "regra .chat-inbox .composer-intake-message ausente").toBeTruthy();
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-intake-message\.failed\s*\{/);

    const usados = new Set([...`${rule![1]}`.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]));
    expect(usados.size).toBeGreaterThan(0);
    for (const token of usados)
      expect(stylesheet.split(token).length - 1, `${token} é uma cor nova`).toBeGreaterThan(1);
  });
});
