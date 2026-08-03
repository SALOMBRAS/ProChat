import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { InboxApi, InboxConversation, InboxMessage, Page } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";
import { deviceLabel, isSilent, microphoneErrorMessage, microphoneState, signalLevel, silentFor, SILENCE_WARNING, MICROPHONE_RECOVERY } from "./microphone.js";

/**
 * O navegador pede microfone num balão discreto da barra de endereço. Quem ignora
 * ou nega descobre pelo cliente reclamando de uma nota de voz muda — e, depois de
 * negar uma vez, o navegador NÃO pergunta de novo, então o operador fica preso
 * sem saber onde fica o botão que reverte.
 *
 * O que existia antes: `getUserMedia` rejeitava, o `catch` chamava `setError`
 * com o `message` CRU do navegador ("Permission denied", em inglês, no banner de
 * erro do topo da tela), e era só. A gravação não começava — nisso o
 * comportamento era honesto —, mas não havia como saber o que fazer a seguir.
 *
 * E negar é só UMA das três causas de áudio mudo. As outras duas não falham em
 * lugar nenhum: com o dispositivo errado selecionado, ou com o certo mudo no
 * sistema, o MediaRecorder grava silêncio com o mesmo tamanho e o mesmo formato
 * de uma nota de voz de verdade, e o arquivo é anexado e enviado.
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
const page = <T,>(items: T[]): Page<T> => ({ items, page: 1, pageSize: 50, total: items.length });
const api = () => ({
  conversations: vi.fn().mockResolvedValue(page([conversation()])),
  messages: vi.fn().mockResolvedValue(page<InboxMessage>([])),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: null, lastInteractionAt: null }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendAttachment: vi.fn().mockResolvedValue({ id: "job-1", status: "pending" }),
}) as unknown as InboxApi;

const define = (target: object, key: string, value: unknown) =>
  Object.defineProperty(target, key, { value, configurable: true, writable: true });

/** Estado que a API de Permissions devolve antes de qualquer pedido. */
const permissions = (state?: PermissionState) =>
  define(navigator, "permissions", state ? { query: vi.fn().mockResolvedValue({ state }) } : undefined);

const microphones = (labels: string[]) => labels.map((label, index) => ({
  deviceId: `mic-${index}`, kind: "audioinput" as const, label, groupId: "g", toJSON: () => ({}),
}));

const media = (over: Partial<MediaDevices> = {}) =>
  define(navigator, "mediaDevices", {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
    enumerateDevices: vi.fn().mockResolvedValue(microphones(["Microfone interno"])),
    ...over,
  });

beforeEach(() => {
  define(window, "MediaRecorder", class {
    static isTypeSupported = () => true;
    state = "inactive"; mimeType = "audio/webm";
    start = vi.fn(() => { this.state = "recording"; });
    stop = vi.fn();
    ondataavailable: unknown; onstop: unknown;
  });
  permissions("prompt");
  media();
});
afterEach(() => { vi.restoreAllMocks(); });

const abrir = async (client = api()) => {
  render(<Inbox api={client} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  await screen.findByLabelText("Gravar áudio");
  return client;
};
const gravar = async () => { fireEvent.click(screen.getByLabelText("Gravar áudio")); };
const portao = () => screen.queryByRole("alertdialog");

describe("o portão antes de o navegador perguntar", () => {
  it("mostra o diálogo quando a permissão ainda não foi decidida, em vez de deixar o balão aparecer sozinho", async () => {
    await abrir();
    await gravar();
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText("Ativar o microfone?")).toBeTruthy();
    expect(within(dialogo).getByText("Permitir microfone")).toBeTruthy();
    // O navegador só é chamado depois que o operador decide.
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("não atrapalha quem já concedeu: grava direto, sem diálogo", async () => {
    permissions("granted");
    await abrir();
    await gravar();
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
    expect(portao()).toBeNull();
  });

  /** Depois de negar, `getUserMedia` rejeita na hora e sem diálogo: dizer só
   *  "permissão negada" deixa o operador preso. */
  it("com a permissão já negada, explica COMO reverter", async () => {
    permissions("denied");
    await abrir();
    await gravar();
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText(/O microfone está bloqueado/i)).toBeTruthy();
    expect(dialogo.textContent).toContain("cadeado na barra de endereço");
    expect(within(dialogo).getByText("Tentar de novo")).toBeTruthy();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("o botão de permitir é que chama o navegador", async () => {
    await abrir();
    await gravar();
    fireEvent.click(await screen.findByText("Permitir microfone"));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
  });

  it("negar no diálogo do navegador vira o texto de recuperação, não a mensagem crua", async () => {
    const erro = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    media({ getUserMedia: vi.fn().mockRejectedValue(erro) } as never);
    await abrir();
    await gravar();
    fireEvent.click(await screen.findByText("Permitir microfone"));
    const dialogo = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialogo.textContent).toContain("cadeado na barra de endereço"));
    // A mensagem crua do navegador não chega à tela.
    expect(dialogo.textContent).not.toContain("Permission denied");
  });

  it("'Agora não' fecha sem gravar e sem erro no topo da tela", async () => {
    await abrir();
    await gravar();
    fireEvent.click(await screen.findByText("Agora não"));
    await waitFor(() => expect(portao()).toBeNull());
    expect(document.querySelector(".alert")).toBeNull();
  });

  it("sem a API de Permissions o diálogo não aparece: o desconhecido não vira suspeita", async () => {
    // Firefox e Safari não respondem a query({name:'microphone'}).
    permissions(undefined);
    await abrir();
    await gravar();
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
    expect(portao()).toBeNull();
  });
});

describe("causa 2: o dispositivo errado", () => {
  it("com mais de um microfone, deixa escolher antes de gravar", async () => {
    media({ enumerateDevices: vi.fn().mockResolvedValue(microphones(["Interno", "Headset USB"])) } as never);
    await abrir();
    await gravar();
    fireEvent.click(await screen.findByText("Permitir microfone"));
    const seletor = await screen.findByLabelText("Escolher microfone");
    expect(within(seletor as HTMLElement).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["Interno", "Headset USB"]);
  });

  it("com um microfone só, não pergunta nada e grava", async () => {
    await abrir();
    await gravar();
    fireEvent.click(await screen.findByText("Permitir microfone"));
    await waitFor(() => expect(portao()).toBeNull());
  });

  it("o microfone escolhido é o que vai ao navegador", async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    media({ getUserMedia, enumerateDevices: vi.fn().mockResolvedValue(microphones(["Interno", "Headset USB"])) } as never);
    await abrir();
    await gravar();
    fireEvent.click(await screen.findByText("Permitir microfone"));
    fireEvent.change(await screen.findByLabelText("Escolher microfone"), { target: { value: "mic-1" } });
    fireEvent.click(screen.getByText("Permitir microfone"));
    await waitFor(() => expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: "mic-1" } } }));
  });
});

describe("causa 3: o dispositivo mudo — a lógica do medidor", () => {
  it("mede o nível de um bloco de amostras", () => {
    expect(signalLevel(new Float32Array(64))).toBe(0);
    expect(signalLevel([1, -1, 1, -1])).toBe(1);
    expect(signalLevel([])).toBe(0);
  });

  it("conta o silêncio do fim para trás, para um pico no meio não zerar o aviso", () => {
    expect(silentFor([0, 0, 0])).toBe(3);
    // Falou no fim: não está mudo agora.
    expect(silentFor([0, 0, 0.5])).toBe(0);
    // Falou no meio e parou: o que vale é o agora.
    expect(silentFor([0.5, 0, 0, 0])).toBe(3);
  });

  it("só avisa depois de alguns segundos, não na respiração antes da primeira palavra", () => {
    expect(isSilent([0, 0])).toBe(false);
    expect(isSilent([0, 0, 0])).toBe(true);
    expect(isSilent([0, 0, 0, 0, 0.4])).toBe(false);
  });

  it("ruído de sala não conta como som", () => {
    expect(isSilent([0.001, 0.002, 0.0005])).toBe(true);
    expect(isSilent([0.001, 0.002, 0.4])).toBe(false);
  });
});

describe("as mensagens, no lugar do texto cru do navegador", () => {
  it.each([
    ["NotAllowedError", "Permissão de microfone negada."],
    ["SecurityError", "Permissão de microfone negada."],
    ["NotFoundError", "Nenhum microfone encontrado neste dispositivo."],
    ["NotReadableError", "O microfone está em uso por outro aplicativo. Feche o outro programa e tente de novo."],
    ["OverconstrainedError", "O microfone escolhido não está mais disponível. Escolha outro."],
  ])("traduz %s", (name, esperado) => {
    expect(microphoneErrorMessage(Object.assign(new Error("cru"), { name }))).toBe(esperado);
  });

  it("cai numa frase própria para o que não conhece, sem repetir o navegador", () => {
    expect(microphoneErrorMessage(new Error("qualquer coisa"))).toBe("Não foi possível acessar o microfone.");
    expect(microphoneErrorMessage(undefined)).toBe("Não foi possível acessar o microfone.");
  });

  it("o texto de recuperação diz onde fica o botão, não só que foi negada", () => {
    expect(MICROPHONE_RECOVERY).toContain("cadeado");
    expect(SILENCE_WARNING).toMatch(/microfone certo|mudo no sistema/);
  });

  it("nomeia o dispositivo sem rótulo pela posição, nunca pelo deviceId", () => {
    expect(deviceLabel({ label: "Headset", deviceId: "abc123" } as MediaDeviceInfo, 0)).toBe("Headset");
    // Regra 6: identificador técnico não vai para a tela.
    expect(deviceLabel({ label: "", deviceId: "abc123" } as MediaDeviceInfo, 1)).toBe("Microfone 2");
  });
});

describe("microphoneState", () => {
  it.each([["granted"], ["denied"], ["prompt"]])("repassa %s", async (state) => {
    permissions(state as PermissionState);
    await expect(microphoneState()).resolves.toBe(state);
  });

  it("devolve unknown quando a API não existe ou não conhece o nome", async () => {
    permissions(undefined);
    await expect(microphoneState()).resolves.toBe("unknown");
    define(navigator, "permissions", { query: vi.fn().mockRejectedValue(new TypeError("microphone")) });
    await expect(microphoneState()).resolves.toBe("unknown");
  });
});

describe("estilo", () => {
  it("reaproveita a moldura do tema e a escala da #47, sem hex novo", () => {
    expect(stylesheet).toMatch(/\.chat-inbox \.mic-gate\s*\{/);
    // Título 17, corpo 13, apoio 11 — a escala da #47.
    expect(stylesheet).toMatch(/\.chat-inbox \.mic-gate h2\s*\{[^}]*font-size:\s*17px/);
    expect(stylesheet).toMatch(/\.chat-inbox \.mic-gate-copy\s*\{[^}]*font-size:\s*13px/);
    // O primário ocupa a largura; negar é discreto. É a hierarquia do Meet.
    expect(stylesheet).toMatch(/\.mic-gate-allow\s*\{[^}]*width:\s*100%/);
    expect(stylesheet).toMatch(/\.mic-gate-dismiss\s*\{[^}]*background:\s*transparent/);

    const bloco = stylesheet.slice(stylesheet.indexOf("/* Portão de permissão do microfone."));
    const antes = stylesheet.slice(0, stylesheet.indexOf("/* Portão de permissão do microfone."));
    for (const cor of new Set(bloco.match(/#[0-9a-f]{3,8}\b/gi) ?? []))
      expect(antes, `${cor} é uma cor nova`).toContain(cor);
  });
});
