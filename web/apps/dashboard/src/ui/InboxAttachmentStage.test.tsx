import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { InboxApi, InboxConversation, InboxMessage, Page } from "../api/inbox.js";

/** O realtime precisa ser dirigido de fora para provar que a tela não o suspende. */
const realtime = vi.hoisted(() => ({ notify: undefined as ((event: Record<string, unknown>) => void) | undefined }));
vi.mock("../api/realtime.js", () => ({ connectRealtime: (handler: (event: Record<string, unknown>) => void) => { realtime.notify = handler; return () => {}; } }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * Tela de composição de anexo.
 *
 * O cartão de 40px ao lado do campo de texto mostrava nome e tamanho — tudo menos
 * a imagem. Aqui o preview toma o lugar da conversa, a legenda fica encostada nele
 * e o traço sai da barra. O que estes testes prendem é isso, mais o que a tela não
 * pode quebrar: o caminho de envio, o realtime por baixo e a saída sem perder o que
 * foi escrito por acidente.
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
const message = (id: string, content: string): InboxMessage => ({
  id, direction: "inbound", content, timestamp: "2026-07-28T12:30:00.000Z", status: "received",
  messageType: "text", chatId: "5511999990001@c.us", senderWhatsappId: "5511999990001@c.us", metadata: {},
});
const page = <T,>(items: T[]): Page<T> => ({ items, page: 1, pageSize: 50, total: items.length });
const api = () => ({
  conversations: vi.fn().mockResolvedValue(page([conversation()])),
  messages: vi.fn().mockResolvedValue(page<InboxMessage>([])),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  sendAttachment: vi.fn().mockResolvedValue({ id: "job-1", status: "pending" }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}) as unknown as InboxApi;

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const arquivo = (name: string, type: string, content: number[] = PNG) => new File([new Uint8Array(content)], name, { type });

beforeEach(() => {
  realtime.notify = undefined;
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn().mockReturnValue("blob:preview"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null) as never;
});
afterEach(() => { vi.restoreAllMocks(); });

const abrirConversa = async (client = api()) => {
  render(<Inbox api={client} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  await screen.findByLabelText("Adicionar anexo");
  return client;
};
const escolher = (file: File) => fireEvent.change(document.querySelector<HTMLInputElement>(".attachment-input")!, { target: { files: [file] } });
const abrirTela = async (file = arquivo("foto.png", "image/png")) => {
  escolher(file);
  return screen.findByRole("region", { name: "Compor anexo" });
};
const tela = () => screen.queryByRole("region", { name: "Compor anexo" });
const conversaVisivel = () => Boolean(document.querySelector(".message-list"));
const legenda = () => screen.getByLabelText("Legenda do anexo");

describe("abrir a tela", () => {
  it("escolher imagem troca a conversa pelo preview grande", async () => {
    await abrirConversa();
    expect(conversaVisivel()).toBe(true);
    await abrirTela();

    // A lista de mensagens e o compositor saem; o cabeçalho da conversa fica, para
    // não se perder de vista para quem se está mandando.
    expect(conversaVisivel()).toBe(false);
    expect(screen.queryByLabelText("Mensagem")).toBeNull();
    expect(document.querySelector(".inbox-history-head")).toBeTruthy();
    const preview = screen.getByAltText("Prévia de foto.png");
    expect(preview.className).toContain("attachment-stage-media");
    expect(screen.getByText("foto.png")).toBeTruthy();
  });

  it("vídeo abre a mesma tela, com player em vez de imagem", async () => {
    await abrirConversa();
    await abrirTela(arquivo("clipe.webm", "video/webm", [0x1a, 0x45, 0xdf, 0xa3]));
    expect(screen.getByLabelText("Prévia de clipe.webm").tagName).toBe("VIDEO");
  });

  it("documento e áudio continuam no cartão do compositor", async () => {
    // A prévia possível de um PDF aqui seria ícone, nome e tamanho — o que o cartão
    // já mostra, em dez vezes a área. Renderizar a primeira página pede biblioteca.
    await abrirConversa();
    escolher(arquivo("contrato.pdf", "application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]));
    await screen.findByText("contrato.pdf");
    expect(tela()).toBeNull();
    expect(conversaVisivel()).toBe(true);
    expect(document.querySelector(".composer-pending-attachment")).toBeTruthy();
  });

  it("a foto da câmera cai na mesma tela", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) }, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, "play", { value: vi.fn().mockResolvedValue(undefined), configurable: true });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { value: 480, configurable: true });
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() }) as never;
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) { callback(new Blob([new Uint8Array(2048)], { type: "image/jpeg" })); } as never;

    await abrirConversa();
    fireEvent.click(screen.getByLabelText("Adicionar anexo"));
    fireEvent.click(screen.getByText("Câmera"));
    fireEvent.click(await screen.findByText("Tirar foto"));
    await screen.findByRole("region", { name: "Compor anexo" });
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  });
});

describe("sair da tela", () => {
  it("fechar sem legenda nem traço volta à conversa em um clique", async () => {
    await abrirConversa();
    await abrirTela();
    fireEvent.click(screen.getByLabelText("Fechar"));
    await waitFor(() => expect(tela()).toBeNull());
    expect(conversaVisivel()).toBe(true);
    expect(document.querySelector(".composer-pending-attachment")).toBeNull();
  });

  it("com legenda escrita, fechar pergunta antes de descartar", async () => {
    await abrirConversa();
    await abrirTela();
    fireEvent.change(legenda(), { target: { value: "olha isto" } });
    fireEvent.click(screen.getByLabelText("Fechar"));

    const confirmacao = await screen.findByRole("alertdialog", { name: "Confirmar descarte" });
    expect(confirmacao.textContent ?? "").toMatch(/legenda volta para o campo de mensagem/i);
    expect(tela()).toBeTruthy();

    fireEvent.click(screen.getByText("Cancelar"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(tela()).toBeTruthy();
  });

  it("fechar devolve a legenda ao compositor; remover joga fora as duas coisas", async () => {
    await abrirConversa();
    await abrirTela();
    fireEvent.change(legenda(), { target: { value: "texto que ainda serve" } });
    fireEvent.click(screen.getByLabelText("Fechar"));
    fireEvent.click(await screen.findByText("Descartar anexo"));
    await waitFor(() => expect(tela()).toBeNull());
    // Quem escreveu a frase ainda pode mandá-la como texto.
    expect((screen.getByLabelText("Mensagem") as HTMLTextAreaElement).value).toBe("texto que ainda serve");

    await abrirTela();
    fireEvent.click(screen.getByLabelText("Remover anexo"));
    fireEvent.click(await screen.findByText("Descartar tudo"));
    await waitFor(() => expect(tela()).toBeNull());
    expect((screen.getByLabelText("Mensagem") as HTMLTextAreaElement).value).toBe("");
  });

  it("Esc fecha a tela, e antes disso fecha a confirmação", async () => {
    await abrirConversa();
    await abrirTela();
    fireEvent.change(legenda(), { target: { value: "quase mandei" } });

    fireEvent.keyDown(window, { key: "Escape" });
    await screen.findByRole("alertdialog", { name: "Confirmar descarte" });
    // Um Esc desfaz um passo: primeiro a pergunta, e a tela continua.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(tela()).toBeTruthy();
  });

  it("Esc com o editor aberto fecha o editor, não a tela", async () => {
    await abrirConversa();
    await abrirTela();
    fireEvent.click(screen.getByLabelText("Editar com a caneta"));
    await screen.findByRole("dialog", { name: "Editar imagem" });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull());
    // Fechar tudo de uma vez descartaria a mídia junto com o painel.
    expect(tela()).toBeTruthy();
  });
});

describe("legenda e envio", () => {
  it("a legenda escrita na tela chega ao envio do anexo", async () => {
    const client = await abrirConversa();
    await abrirTela();
    fireEvent.change(legenda(), { target: { value: "segue a foto do contrato" } });
    fireEvent.click(screen.getByLabelText("Enviar"));

    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    const [id, file, clientRequestId, caption] = (client.sendAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toBe(conversationId);
    expect((file as File).name).toBe("foto.png");
    expect(clientRequestId).toEqual(expect.any(String));
    expect(caption).toBe("segue a foto do contrato");
  });

  it("Enter envia e Shift+Enter não", async () => {
    const client = await abrirConversa();
    await abrirTela();
    fireEvent.change(legenda(), { target: { value: "vai" } });

    fireEvent.keyDown(legenda(), { key: "Enter", shiftKey: true });
    expect(client.sendAttachment).not.toHaveBeenCalled();
    fireEvent.keyDown(legenda(), { key: "Enter" });
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    expect((client.sendAttachment as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBe("vai");
  });

  it("enviar fecha a tela e volta à conversa", async () => {
    const client = await abrirConversa();
    await abrirTela();
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    await waitFor(() => expect(tela()).toBeNull());
    expect(conversaVisivel()).toBe(true);
  });

  it("enquanto envia, a tela trava as ferramentas em vez de sumir", async () => {
    let liberar: (value: unknown) => void = () => {};
    const client = api();
    (client.sendAttachment as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((resolve) => { liberar = resolve; }));
    await abrirConversa(client);
    await abrirTela();
    fireEvent.click(screen.getByLabelText("Enviar"));

    await waitFor(() => expect(screen.getByLabelText("Remover anexo")).toBeDisabled());
    expect(screen.getByLabelText("Fechar")).toBeDisabled();
    expect(legenda()).toBeDisabled();
    liberar({ id: "job-1", status: "pending" });
  });
});

describe("o editor de traço vem da barra", () => {
  it("Editar abre o mesmo painel da #56, sobre o preview", async () => {
    await abrirConversa();
    await abrirTela();
    expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull();

    fireEvent.click(screen.getByLabelText("Editar com a caneta"));
    const editor = await screen.findByRole("dialog", { name: "Editar imagem" });
    // É o componente da #56 reusado, não outra implementação: as mesmas
    // ferramentas, dentro da área de preview.
    expect(editor.querySelector(".composer-editor-canvas")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Cor da caneta" })).toBeTruthy();
    expect(screen.getByLabelText("Espessura do traço")).toBeTruthy();
    expect(editor.closest(".attachment-stage-preview")).toBeTruthy();
    // Com o editor no ar o preview sai de cena e Editar não reabre por cima.
    expect(screen.queryByAltText("Prévia de foto.png")).toBeNull();
    expect(screen.getByLabelText("Editar com a caneta")).toBeDisabled();
  });

  it("vídeo não oferece o traço", async () => {
    await abrirConversa();
    await abrirTela(arquivo("clipe.webm", "video/webm", [0x1a, 0x45, 0xdf, 0xa3]));
    expect(screen.queryByLabelText("Editar com a caneta")).toBeNull();
    expect(screen.getByLabelText("Remover anexo")).toBeTruthy();
  });
});

describe("a conversa por baixo", () => {
  it("o realtime continua atualizando enquanto a tela está aberta", async () => {
    const client = api();
    await abrirConversa(client);
    await abrirTela();
    expect(conversaVisivel()).toBe(false);

    const antes = (client.messages as ReturnType<typeof vi.fn>).mock.calls.length;
    (client.messages as ReturnType<typeof vi.fn>).mockResolvedValue(page([message("m-1", "chegou durante a composição")]));
    realtime.notify?.({ workspaceId: "default-workspace", eventType: "message.received", payload: {} });
    // Nada é suspenso: a lista some da tela, não do estado.
    await waitFor(() => expect((client.messages as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(antes));

    fireEvent.click(screen.getByLabelText("Fechar"));
    await screen.findByText("chegou durante a composição");
  });
});

describe("estilo", () => {
  it("a tela tem regra própria, na escala da #47 e sem hex novo", () => {
    const rule = /\.chat-inbox \.attachment-stage\s*\{([^}]*)\}/.exec(stylesheet);
    expect(rule, "regra .chat-inbox .attachment-stage ausente").toBeTruthy();
    // Sem ocupar a altura restante o preview não toma o lugar da conversa.
    expect(rule![1]).toMatch(/flex:\s*1 1 auto/);
    // Escala da #47: nome do arquivo 15/600, tamanho 13.
    expect(stylesheet).toMatch(/\.chat-inbox \.attachment-stage-file strong\s*\{[^}]*font-size:\s*15px[^}]*font-weight:\s*600/);
    expect(stylesheet).toMatch(/\.chat-inbox \.attachment-stage-file span\s*\{[^}]*font-size:\s*13px/);
    expect(stylesheet).toMatch(/\.chat-inbox \.attachment-stage-media\s*\{[^}]*object-fit:\s*contain/);
    // Sem célula de tamanho definido o `max-height: 100%` da mídia não tem contra o
    // que resolver: uma foto alta estoura a área e aparece barra de rolagem.
    // Medido no navegador antes da correção: 636px de conteúdo em 587px de área.
    expect(stylesheet).toMatch(/\.chat-inbox \.attachment-stage-preview\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/);
    expect(stylesheet).toMatch(/\.chat-inbox \.attachment-stage-composer\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.attachment-stage-confirm\s*\{/);

    const usados = new Set([...stylesheet.matchAll(/\.chat-inbox \.attachment-stage[^{]*\{([^}]*)\}/g)].flatMap((match) => [...match[1].matchAll(/#[0-9a-f]{3,8}\b/gi)].map((color) => color[0])));
    expect(usados.size).toBeGreaterThan(0);
    for (const token of usados)
      expect(stylesheet.split(token).length - 1, `${token} é uma cor nova`).toBeGreaterThan(1);
  });
});
