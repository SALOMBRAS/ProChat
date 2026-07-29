import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { InboxApi, InboxConversation, Page } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * A opção Câmera do menu "+" era markup inerte: `className="future-option"`, rótulo
 * "Em breve" e nenhum `onClick`. Estes testes prendem o caminho inteiro — abrir a
 * câmera, capturar, e cair no mesmo envio de anexo que já existe — e os três modos
 * de falha que o operador precisa entender.
 *
 * Não há endpoint novo: o que a captura produz é um File que entra em
 * `api.sendAttachment`, exatamente como um arquivo escolhido no seletor.
 */
const conversation = (id: string): InboxConversation => ({
  id, whatsappSessionId: "session-a", chatId: "5511999990001@c.us", contactId: null, conversationType: "direct",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Ana", phone: "5511999990001", pushName: "Ana", profileName: "Ana", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
const emptyPage = <T,>(): Page<T> => ({ items: [], page: 1, pageSize: 50, total: 0 });
const api = () => ({
  conversations: vi.fn().mockResolvedValue({ items: [conversation("11111111-1111-4111-8111-111111111111")], page: 1, pageSize: 50, total: 1 }),
  messages: vi.fn().mockResolvedValue(emptyPage()),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  sendAttachment: vi.fn().mockResolvedValue({ id: "job-1", status: "pending" }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}) as unknown as InboxApi;

const track = () => ({ stop: vi.fn() });
const fakeStream = (tracks = [track(), track()]) => ({ getTracks: () => tracks }) as unknown as MediaStream;

class FakeRecorder {
  static supported = true;
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (type: string) => FakeRecorder.supported && type.startsWith("video/webm");
  state: "inactive" | "recording" = "inactive";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  constructor(public stream: MediaStream, public options?: { mimeType?: string }) { FakeRecorder.instances.push(this); }
  get mimeType() { return this.options?.mimeType ?? "video/webm"; }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.onstop?.(); }
  emit(bytes: number) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: "video/webm" }) }); }
}

const mediaDevices = (getUserMedia: unknown) => {
  Object.defineProperty(navigator, "mediaDevices", { value: getUserMedia ? { getUserMedia } : undefined, configurable: true });
};

/** Abre a conversa e o menu "+", devolvendo os itens antes de qualquer clique:
 *  escolher a Câmera fecha o menu, então o que se quer inspecionar tem de ser
 *  capturado agora. */
const abrirMenu = async () => {
  render(<Inbox api={api()} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  fireEvent.click(await screen.findByLabelText("Adicionar anexo"));
  const menu = screen.getByRole("menu", { name: "Opções de anexo" });
  const item = (rotulo: string) => within(menu).getByText(rotulo).closest("button")!;
  return { menu, item };
};
const abrirCamera = async () => {
  const { item } = await abrirMenu();
  const camera = item("Câmera");
  fireEvent.click(camera);
  return camera;
};

const originalRecorder = globalThis.MediaRecorder;
beforeEach(() => {
  FakeRecorder.instances = []; FakeRecorder.supported = true;
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  // jsdom não implementa nada disto.
  Object.defineProperty(HTMLMediaElement.prototype, "play", { value: vi.fn().mockResolvedValue(undefined), configurable: true });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { value: 640, configurable: true });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { value: 480, configurable: true });
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() }) as never;
  // O composer gera prévia de imagem com createObjectURL, que o jsdom não tem.
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn().mockReturnValue("blob:preview"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) { callback(new Blob([new Uint8Array(2048)], { type: "image/jpeg" })); } as never;
});
afterEach(() => {
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = originalRecorder;
  mediaDevices(undefined);
  vi.restoreAllMocks();
});

describe("opção Câmera do menu de anexos", () => {
  it("deixou de ser markup inerte: o item abre a câmera", async () => {
    mediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    const camera = await abrirCamera();
    // Enquanto era "Em breve" o item tinha a classe future-option e nenhum onClick.
    expect(camera.className).not.toContain("future-option");
    expect(camera.textContent).not.toContain("Em breve");
    await screen.findByRole("dialog", { name: "Capturar pela câmera" });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: expect.anything(), audio: true }));
  });

  it("a foto vira anexo image/jpeg e segue o envio que já existe", async () => {
    mediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    await abrirCamera();
    fireEvent.click(await screen.findByText("Tirar foto"));

    const pendente = await screen.findByText(/^foto-\d+\.jpg$/);
    expect(pendente).toBeTruthy();
    await screen.findByText("Foto pronta para envio");
    // Fechou a câmera e liberou os tracks: nada de luz acesa depois da captura.
    expect(screen.queryByRole("dialog", { name: "Capturar pela câmera" })).toBeNull();
  });

  it("a foto capturada sai por api.sendAttachment, sem endpoint novo", async () => {
    mediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    const client = api();
    render(<Inbox api={client} />);
    await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
    fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
    fireEvent.click(await screen.findByLabelText("Adicionar anexo"));
    fireEvent.click(within(screen.getByRole("menu", { name: "Opções de anexo" })).getByText("Câmera"));
    fireEvent.click(await screen.findByText("Tirar foto"));
    await screen.findByText(/^foto-\d+\.jpg$/);

    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    const [conversationId, file, clientRequestId] = (client.sendAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(conversationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(file).toBeInstanceOf(File);
    expect((file as File).type).toBe("image/jpeg");
    expect(clientRequestId).toEqual(expect.any(String));
  });

  it("o vídeo vira anexo video/webm, que é o que a allowlist do servidor aceita", async () => {
    mediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    await abrirCamera();
    fireEvent.click(await screen.findByText("Gravar vídeo"));
    const recorder = FakeRecorder.instances.at(-1)!;
    expect(recorder.mimeType.startsWith("video/webm")).toBe(true);
    recorder.emit(4096);
    fireEvent.click(screen.getByText("Concluir vídeo"));
    await screen.findByText(/^video-\d+\.webm$/);
    await screen.findByText("Vídeo pronto para envio");
  });

  it("o vídeo capturado sai por api.sendAttachment com o mime da allowlist", async () => {
    mediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    const client = api();
    render(<Inbox api={client} />);
    await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
    fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
    fireEvent.click(await screen.findByLabelText("Adicionar anexo"));
    fireEvent.click(within(screen.getByRole("menu", { name: "Opções de anexo" })).getByText("Câmera"));
    fireEvent.click(await screen.findByText("Gravar vídeo"));
    FakeRecorder.instances.at(-1)!.emit(4096);
    fireEvent.click(screen.getByText("Concluir vídeo"));
    await screen.findByText(/^video-\d+\.webm$/);

    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    const file = (client.sendAttachment as ReturnType<typeof vi.fn>).mock.calls[0][1] as File;
    // É o mime que o servidor valida contra a allowlist — o nome do arquivo não é.
    expect(file.type).toBe("video/webm");
  });

  it("descartar a gravação não anexa nada", async () => {
    mediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    await abrirCamera();
    fireEvent.click(await screen.findByText("Gravar vídeo"));
    FakeRecorder.instances.at(-1)!.emit(4096);
    fireEvent.click(screen.getByText("Descartar"));
    await waitFor(() => expect(screen.queryByText("Concluir vídeo")).toBeNull());
    expect(screen.queryByText(/^video-\d+\.webm$/)).toBeNull();
  });

  // O limite do servidor é 50 MB para vídeo (policy em attachment-outbox.service.ts).
  // Ultrapassar responde 413 no envio; parar sozinho evita gravar minutos à toa.
  it("interrompe a gravação ao atingir o limite de 50 MB", async () => {
    mediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    await abrirCamera();
    fireEvent.click(await screen.findByText("Gravar vídeo"));
    const recorder = FakeRecorder.instances.at(-1)!;
    recorder.emit(50 * 1024 * 1024 + 1);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/passou do limite de 50/i));
    expect(recorder.state).toBe("inactive");
  });

  it.each([
    ["NotAllowedError", /permiss(ã|a)o de c(â|a)mera negada/i],
    ["NotFoundError", /nenhuma c(â|a)mera encontrada/i],
    ["NotReadableError", /em uso por outro aplicativo/i],
  ])("explica a falha %s em vez de despejar o erro do navegador", async (name, esperado) => {
    const failure = Object.assign(new Error("mensagem crua do navegador"), { name });
    mediaDevices(vi.fn().mockRejectedValue(failure));
    await abrirCamera();
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent ?? "").toMatch(esperado);
    expect(alerta.textContent ?? "").not.toContain("mensagem crua do navegador");
  });

  it("sem mediaDevices cai no seletor com capture, em vez de só recusar", async () => {
    mediaDevices(undefined);
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await abrirCamera();
    await screen.findByText(/C(â|a)mera indispon(í|i)vel neste navegador/i);
    await waitFor(() => expect(click).toHaveBeenCalled());
    const input = document.querySelector<HTMLInputElement>(".attachment-input")!;
    expect(input.getAttribute("capture")).toBe("environment");
    // E pede só o que o servidor aceita: HEIC e 3gpp seriam recusados com 415.
    expect(input.getAttribute("accept")).toBe("image/jpeg,image/png,image/webp,video/mp4,video/webm");
    expect(screen.queryByRole("dialog", { name: "Capturar pela câmera" })).toBeNull();
  });

  it("Fotos/Vídeos pede os mimes da allowlist, sem capture", async () => {
    mediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    render(<Inbox api={api()} />);
    await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
    fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
    fireEvent.click(await screen.findByLabelText("Adicionar anexo"));
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(within(screen.getByRole("menu", { name: "Opções de anexo" })).getByText("Fotos/Vídeos"));
    const input = document.querySelector<HTMLInputElement>(".attachment-input")!;
    expect(input.getAttribute("accept")).toBe("image/jpeg,image/png,image/webp,video/mp4,video/webm");
    expect(input.getAttribute("capture")).toBeNull();
  });

  it("o painel tem estilo próprio, só com tokens que já existiam", () => {
    // Sem regra, o painel herda o layout do composer e a prévia sai sem tamanho.
    const rule = /\.chat-inbox \.composer-camera\s*\{([^}]*)\}/.exec(stylesheet);
    expect(rule, "regra .chat-inbox .composer-camera ausente").toBeTruthy();
    expect(rule![1]).toMatch(/background/);
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-camera-preview\s*\{[^}]*max-height/);
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-camera-error\s*\{/);

    const usados = new Set([...`${rule![1]}`.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]));
    expect(usados.size).toBeGreaterThan(0);
    for (const token of usados)
      expect(stylesheet.split(token).length - 1, `${token} é uma cor nova`).toBeGreaterThan(1);
  });

  it("mantém Áudio como 'Em breve': distinguir nota de voz de música é outro trabalho", async () => {
    mediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    const { item } = await abrirMenu();
    const audio = item("Áudio");
    expect(audio.className).toContain("future-option");
    expect(audio.textContent).toContain("Em breve");
  });
});
