import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { InboxApi, InboxConversation, Page } from "../api/inbox.js";
import { IMAGE_UPLOAD_LIMIT } from "./imageAnnotation.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * Marcação a caneta entre a escolha do anexo e o envio.
 *
 * O caminho inteiro está preso aqui: imagem entra pelo seletor de arquivos, o
 * operador desenha por cima, e o `File` que sai por `api.sendAttachment` é outro
 * arquivo — com os bytes do traço, com o mime da allowlist e com os magic bytes
 * que o servidor confere (`magicMatches` em attachment-outbox.service.ts).
 *
 * Não há endpoint novo: o editor troca o arquivo pendente por outro arquivo
 * pendente, e o envio segue igual.
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

const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
/** O original: um JPEG mínimo com um corpo que não é o desenho. Se a reexportação
 *  não acontecer, os bytes que chegam ao envio são exatamente estes. */
const originalImage = (name = "foto.jpg", type = "image/jpeg") =>
  new File([new Uint8Array([...(type === "image/png" ? PNG_MAGIC : JPEG_MAGIC), ...new TextEncoder().encode("original-sem-marcacao")])], name, { type });

/** Canvas de mentira. Registra as operações de desenho e devolve, em `toBlob`, os
 *  magic bytes do formato pedido seguidos das operações registradas: assim os
 *  bytes exportados são função do que foi desenhado, e um traço a mais muda o
 *  arquivo. `save()` reinicia o registro porque toda repintura começa por ele. */
let drawn: string[] = [];
let exportedTypes: string[] = [];
let forcedBlobSize: number | undefined;
const fakeContext = () => {
  const push = (name: string) => (...args: unknown[]) => { drawn.push(`${name}(${args.filter((value) => typeof value === "number").join(",")})`); };
  return {
    save: () => { drawn = []; }, restore: push("restore"),
    beginPath: push("beginPath"), moveTo: push("moveTo"), lineTo: push("lineTo"),
    quadraticCurveTo: push("quadraticCurveTo"), stroke: push("stroke"),
    fillRect: push("fillRect"), drawImage: () => drawn.push("drawImage"),
    fillStyle: "", strokeStyle: "", lineWidth: 0, lineCap: "butt", lineJoin: "miter",
  };
};

class FakeImage {
  static natural = { width: 1200, height: 900 };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = FakeImage.natural.width;
  naturalHeight = FakeImage.natural.height;
  width = 0;
  height = 0;
  set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}

const originalImageCtor = globalThis.Image;
beforeEach(() => {
  drawn = [];
  exportedTypes = [];
  forcedBlobSize = undefined;
  FakeImage.natural = { width: 1200, height: 900 };
  (globalThis as { Image?: unknown }).Image = FakeImage;
  HTMLCanvasElement.prototype.getContext = vi.fn(fakeContext) as never;
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type = "image/png") {
    exportedTypes.push(type);
    const magic = type === "image/png" ? PNG_MAGIC : JPEG_MAGIC;
    const blob = new Blob([new Uint8Array(magic), new TextEncoder().encode(drawn.join(";"))], { type });
    if (forcedBlobSize !== undefined) Object.defineProperty(blob, "size", { value: forcedBlobSize });
    callback(blob);
  } as never;
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn().mockReturnValue("blob:preview"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
});
afterEach(() => {
  (globalThis as { Image?: unknown }).Image = originalImageCtor;
  vi.restoreAllMocks();
});

/** jsdom não implementa `PointerEvent`, então o evento é montado à mão. O React
 *  despacha por tipo, e lê `clientX`/`pointerId` do evento nativo. */
const pointer = (type: string, init: Record<string, unknown>) =>
  Object.assign(new Event(type, { bubbles: true, cancelable: true }), init);

const abrirConversa = async (client = api()) => {
  render(<Inbox api={client} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  await screen.findByLabelText("Adicionar anexo");
  return client;
};
const escolherArquivo = (file: File) => {
  const input = document.querySelector<HTMLInputElement>(".attachment-input")!;
  fireEvent.change(input, { target: { files: [file] } });
};
const abrirEditor = async (file: File) => {
  escolherArquivo(file);
  fireEvent.click(await screen.findByLabelText(`Editar ${file.name}`));
  await screen.findByRole("dialog", { name: "Editar imagem" });
  const canvas = screen.getByLabelText("Área de marcação da imagem") as HTMLCanvasElement;
  // A imagem carrega num microtask; sem esperar, o canvas ainda não tem tamanho e
  // o ponteiro é ignorado.
  await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
  return canvas;
};
const desenhar = (canvas: HTMLCanvasElement, pontos: [number, number][], pointerId = 1) => {
  fireEvent(canvas, pointer("pointerdown", { pointerId, button: 0, clientX: pontos[0][0], clientY: pontos[0][1] }));
  for (const [x, y] of pontos.slice(1)) fireEvent(canvas, pointer("pointermove", { pointerId, clientX: x, clientY: y }));
  const [x, y] = pontos[pontos.length - 1];
  fireEvent(canvas, pointer("pointerup", { pointerId, clientX: x, clientY: y }));
};
/** O `Blob` do jsdom não tem `arrayBuffer()`; `FileReader` ele implementa. */
const bytes = (file: Blob) => new Promise<Uint8Array>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(file);
});
const enviado = (client: InboxApi) => (client.sendAttachment as ReturnType<typeof vi.fn>).mock.calls[0][1] as File;
/** As operações são gravadas como `nome(args)`; contar traços é contar `stroke(`. */
const tracos = () => drawn.filter((op) => op.startsWith("stroke"));
const curvas = () => drawn.filter((op) => op.startsWith("quadraticCurveTo"));
const ultimoContexto = () => (HTMLCanvasElement.prototype.getContext as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value;

describe("editor de imagem no composer", () => {
  it("o caminho inteiro: imagem entra, traço é aplicado, e o arquivo enviado difere do original e passa na allowlist", async () => {
    const client = await abrirConversa();
    const original = originalImage();
    const canvas = await abrirEditor(original);
    desenhar(canvas, [[10, 10], [60, 40], [120, 90], [180, 60]]);
    fireEvent.click(screen.getByText("Concluir"));

    await screen.findByText("foto-editada.jpg");
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());

    const [enviadoConversationId, arquivo] = (client.sendAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(enviadoConversationId).toBe(conversationId);
    expect(arquivo).toBeInstanceOf(File);
    // Passa na allowlist do servidor: mime aceito, magic bytes de JPEG e dentro do
    // teto de 15 MB.
    expect((arquivo as File).type).toBe("image/jpeg");
    const saida = await bytes(arquivo as File);
    expect([saida[0], saida[1], saida[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect((arquivo as File).size).toBeLessThanOrEqual(IMAGE_UPLOAD_LIMIT);
    // E difere do original: o traço está nos bytes, não só na tela.
    expect(saida).not.toEqual(await bytes(original));
    expect(new TextDecoder().decode(saida)).toContain("quadraticCurveTo");
    expect(new TextDecoder().decode(saida)).not.toContain("original-sem-marcacao");
  });

  it("sem traço nenhum, devolve o próprio original em vez de recodificar à toa", async () => {
    const client = await abrirConversa();
    const original = originalImage();
    await abrirEditor(original);
    fireEvent.click(screen.getByText("Concluir"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull());

    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    // Reexportar sem motivo só perderia qualidade e o EXIF de brinde.
    expect(enviado(client)).toBe(original);
    expect(exportedTypes).toHaveLength(0);
  });

  it("desfazer tira o último traço e refazer devolve", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    expect(screen.getByLabelText("Desfazer")).toBeDisabled();

    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    desenhar(canvas, [[90, 90], [140, 120], [180, 100]], 2);
    const comDois = tracos().length;
    expect(comDois).toBe(2);

    fireEvent.click(screen.getByLabelText("Desfazer"));
    await waitFor(() => expect(tracos()).toHaveLength(1));
    fireEvent.click(screen.getByLabelText("Refazer"));
    await waitFor(() => expect(tracos()).toHaveLength(2));
    expect(screen.getByLabelText("Refazer")).toBeDisabled();
  });

  it("descartar a edição volta à imagem original", async () => {
    const client = await abrirConversa();
    const original = originalImage();
    const canvas = await abrirEditor(original);
    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    fireEvent.click(screen.getByText("Descartar edição"));
    await waitFor(() => expect(tracos()).toHaveLength(0));

    fireEvent.click(screen.getByText("Concluir"));
    fireEvent.click(await screen.findByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    expect(enviado(client)).toBe(original);
  });

  it("reabrir o editor parte do original, não da exportação anterior", async () => {
    await abrirConversa();
    const original = originalImage();
    const canvas = await abrirEditor(original);
    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    fireEvent.click(screen.getByText("Concluir"));
    await screen.findByText("foto-editada.jpg");

    // Reabrir mostra o traço de volta — mas a base ainda é o arquivo escolhido, de
    // modo que confirmar de novo recodifica uma vez só, sem empilhar perda.
    fireEvent.click(screen.getByLabelText("Editar foto-editada.jpg"));
    await screen.findByRole("dialog", { name: "Editar imagem" });
    await waitFor(() => expect(tracos()).toHaveLength(1));
    expect(screen.getByLabelText("Desfazer")).not.toBeDisabled();
  });

  it("a cor escolhida e a espessura chegam ao traço", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    const paleta = screen.getByRole("radiogroup", { name: "Cor da caneta" });
    const verde = within(paleta).getByLabelText("Verde");
    fireEvent.click(verde);
    expect(verde).toHaveAttribute("aria-checked", "true");

    const espessura = screen.getByLabelText("Espessura do traço");
    fireEvent.change(espessura, { target: { value: "6" } });
    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    const context = ultimoContexto();
    expect(context.strokeStyle).toBe("#25d366");
    // Nível 6 numa imagem de 1200 px: proporcional ao lado maior, não fixo.
    expect(context.lineWidth).toBe(28);
  });

  it("avisa quando reduz a resolução, e diz para quanto", async () => {
    FakeImage.natural = { width: 12_000, height: 9_000 };
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    // Um canvas de 12000×9000 seriam 432 MB de backing store; o Safari do iPhone
    // devolve canvas em branco bem antes disso.
    expect(canvas.width).toBe(2560);
    expect(canvas.height).toBe(1920);
    await screen.findByText(/reduzida para 2560×1920 px/i);
  });

  it("recusa a exportação que passa dos 15 MB em vez de deixar o envio devolver 413", async () => {
    const client = await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    forcedBlobSize = IMAGE_UPLOAD_LIMIT + 1;
    fireEvent.click(screen.getByText("Concluir"));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent ?? "").toMatch(/limite de envio é 15 MB/i);
    expect(screen.getByRole("dialog", { name: "Editar imagem" })).toBeTruthy();
    expect(client.sendAttachment).not.toHaveBeenCalled();
  });

  it("PNG continua PNG, e o nome acompanha", async () => {
    const client = await abrirConversa();
    const canvas = await abrirEditor(originalImage("print.png", "image/png"));
    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    fireEvent.click(screen.getByText("Concluir"));

    await screen.findByText("print-editada.png");
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    const arquivo = enviado(client);
    expect(arquivo.type).toBe("image/png");
    expect((await bytes(arquivo)).slice(0, 8)).toEqual(new Uint8Array(PNG_MAGIC));
    expect(exportedTypes[0]).toBe("image/png");
  });

  it("um movimento rápido com pontos coalescidos vira uma curva, não uma reta", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    fireEvent(canvas, pointer("pointerdown", { pointerId: 3, button: 0, clientX: 0, clientY: 0 }));
    // Um único `pointermove` por quadro, com os pontos intermediários guardados
    // pelo navegador: sem lê-los, o traço seria uma reta de 0,0 até 400,300.
    fireEvent(canvas, pointer("pointermove", {
      pointerId: 3, clientX: 400, clientY: 300,
      getCoalescedEvents: () => [{ clientX: 100, clientY: 20 }, { clientX: 220, clientY: 160 }, { clientX: 400, clientY: 300 }],
    }));
    fireEvent(canvas, pointer("pointerup", { pointerId: 3, clientX: 400, clientY: 300 }));
    await waitFor(() => expect(tracos()).toHaveLength(1));
    expect(curvas()).toHaveLength(2);
  });

  it("vídeo e documento não ganham botão de editar", async () => {
    await abrirConversa();
    escolherArquivo(new File([new Uint8Array(8)], "clipe.webm", { type: "video/webm" }));
    await screen.findByText("clipe.webm");
    expect(screen.queryByLabelText("Editar clipe.webm")).toBeNull();

    escolherArquivo(new File([new Uint8Array(8)], "contrato.pdf", { type: "application/pdf" }));
    await screen.findByText("contrato.pdf");
    expect(screen.queryByLabelText("Editar contrato.pdf")).toBeNull();
  });

  it("trocar o anexo descarta a marcação do anterior", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    fireEvent.click(screen.getByText("Concluir"));
    await screen.findByText("foto-editada.jpg");

    escolherArquivo(originalImage("outra.jpg"));
    fireEvent.click(await screen.findByLabelText("Editar outra.jpg"));
    await screen.findByRole("dialog", { name: "Editar imagem" });
    // Os traços da foto anterior não podem reaparecer sobre a nova.
    expect(screen.getByLabelText("Desfazer")).toBeDisabled();
    await waitFor(() => expect(tracos()).toHaveLength(0));
  });

  it("fechar sem concluir mantém o anexo como estava", async () => {
    const client = await abrirConversa();
    const original = originalImage();
    const canvas = await abrirEditor(original);
    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    fireEvent.click(screen.getByLabelText("Fechar edição"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull());

    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    expect(enviado(client)).toBe(original);
  });

  it("o painel tem estilo próprio, só com tokens que já existiam", () => {
    // Sem regra, o painel herda o layout do composer e o canvas sai sem tamanho.
    const rule = /\.chat-inbox \.composer-editor\s*\{([^}]*)\}/.exec(stylesheet);
    expect(rule, "regra .chat-inbox .composer-editor ausente").toBeTruthy();
    expect(rule![1]).toMatch(/background/);
    // Sem `touch-action: none` o dedo rola a conversa em vez de desenhar.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-canvas\s*\{[^}]*touch-action:\s*none/);
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-pending-edit\s*\{/);

    const usados = new Set([...`${rule![1]}`.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]));
    expect(usados.size).toBeGreaterThan(0);
    for (const token of usados)
      expect(stylesheet.split(token).length - 1, `${token} é uma cor nova`).toBeGreaterThan(1);
  });
});
