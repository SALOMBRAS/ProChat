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
    setTransform: push("setTransform"),
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
  // Escolher a imagem abre a tela de composição; o traço sai da barra dela, não
  // mais de um ✎ no cartão do compositor.
  fireEvent.click(await screen.findByLabelText("Editar com a caneta"));
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
const tracos = () => drawn.filter((op) => op.startsWith("stroke("));
const curvas = () => drawn.filter((op) => op.startsWith("quadraticCurveTo"));
const ultimoContexto = () => (HTMLCanvasElement.prototype.getContext as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value;
/** A geometria chega ao desenho como transformação do canvas: é este `setTransform`
 *  — o segundo, porque o primeiro devolve a identidade para o fundo — que diz qual
 *  giro e qual recorte foram aplicados. */
const geometria = () => drawn.filter((op) => op.startsWith("setTransform")).at(-1);
const canvasDoEditor = () => screen.getByLabelText("Área de marcação da imagem") as HTMLCanvasElement;
const recortar = () => fireEvent.click(screen.getByLabelText("Recortar"));
const caneta = () => fireEvent.click(screen.getByLabelText("Caneta"));
/** O arrasto da alça corre na janela, não na alça: o ponteiro sai dos 15 px dela
 *  no primeiro milímetro. O `getBoundingClientRect` do jsdom devolve tudo zero, e a
 *  guarda de `canvasPoint` faz a coordenada da tela valer a do quadro — que é o que
 *  torna estes números legíveis. */
const arrastarAlca = (alca: string, de: [number, number], para: [number, number], pointerId = 7) => {
  fireEvent(screen.getByLabelText(alca), pointer("pointerdown", { pointerId, button: 0, clientX: de[0], clientY: de[1] }));
  fireEvent(window, pointer("pointermove", { pointerId, clientX: para[0], clientY: para[1] }));
  fireEvent(window, pointer("pointerup", { pointerId, clientX: para[0], clientY: para[1] }));
};

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
    fireEvent.click(screen.getByLabelText("Editar com a caneta"));
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

  it("vídeo abre a tela mas não oferece o traço; documento nem abre a tela", async () => {
    await abrirConversa();
    escolherArquivo(new File([new Uint8Array(8)], "clipe.webm", { type: "video/webm" }));
    await screen.findByText("clipe.webm");
    // Vídeo tem o que olhar, então ganha a tela; marcar quadro a quadro é outro
    // trabalho.
    expect(screen.getByRole("region", { name: "Compor anexo" })).toBeTruthy();
    expect(screen.queryByLabelText("Editar com a caneta")).toBeNull();

    fireEvent.click(screen.getByLabelText("Fechar"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Compor anexo" })).toBeNull());
    escolherArquivo(new File([new Uint8Array(8)], "contrato.pdf", { type: "application/pdf" }));
    await screen.findByText("contrato.pdf");
    // Documento continua no cartão: a prévia possível seria ícone, nome e tamanho,
    // que é o que o cartão já mostra.
    expect(screen.queryByRole("region", { name: "Compor anexo" })).toBeNull();
    expect(screen.queryByLabelText("Editar com a caneta")).toBeNull();
  });

  it("trocar o anexo descarta a marcação do anterior", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    fireEvent.click(screen.getByText("Concluir"));
    await screen.findByText("foto-editada.jpg");

    fireEvent.click(screen.getByLabelText("Remover anexo"));
    fireEvent.click(await screen.findByText("Descartar tudo"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Compor anexo" })).toBeNull());
    escolherArquivo(originalImage("outra.jpg"));
    fireEvent.click(await screen.findByLabelText("Editar com a caneta"));
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

describe("recorte e giro", () => {
  /** A base é 1200×900 em todo este bloco, e o canvas do modo recorte mostra o
   *  quadro inteiro — é por isso que arrastar até (1200,900) é arrastar até o canto
   *  de baixo à direita da imagem. */
  it("girar 90° gira o arquivo que sai, e o traço já feito continua onde estava", async () => {
    const client = await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    desenhar(canvas, [[10, 10], [60, 40], [120, 90]]);

    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    // Um quarto de volta troca os lados: o canvas de saída passa a ser 900×1200.
    await waitFor(() => expect(canvas.width).toBe(900));
    expect(canvas.height).toBe(1200);
    // O traço não foi refeito nem transformado: continua nas coordenadas da base, e
    // é a matriz do canvas que gira. Guardar o traço na base é o que torna o giro
    // uma operação de custo zero sobre o desenho.
    expect(drawn).toContain("moveTo(10,10)");
    expect(geometria()).toBe("setTransform(0,1,-1,0,900,0)");

    fireEvent.click(screen.getByText("Concluir"));
    await screen.findByText("foto-editada.jpg");
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    const saida = new TextDecoder().decode(await bytes(enviado(client)));
    expect(saida).toContain("setTransform(0,1,-1,0,900,0)");
    expect(saida).toContain("fillRect(0,0,900,1200)");
  });

  it("girar para os dois lados e voltar devolve a imagem como estava", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    fireEvent.click(screen.getByLabelText("Girar 90° à esquerda"));
    await waitFor(() => expect(canvas.width).toBe(900));
    expect(geometria()).toBe("setTransform(0,-1,1,0,0,1200)");

    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    await waitFor(() => expect(canvas.width).toBe(1200));
    // Giro é rígido: quatro quartos de volta não reamostram um pixel sequer, então
    // desgirar tem de deixar a matriz na identidade.
    expect(geometria()).toBe("setTransform(1,0,0,1,0,0)");
  });

  it("o traço feito depois de girar cai onde o operador tocou", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    await waitFor(() => expect(canvas.width).toBe(900));

    desenhar(canvas, [[10, 20], [40, 60], [80, 90]]);
    // O ponteiro deu (10,20) no canvas girado; na foto isso é (20,890). Sem a volta
    // pela inversa da geometria o traço seria gravado em (10,20) e apareceria no
    // canto errado assim que o giro fosse desfeito.
    await waitFor(() => expect(drawn).toContain("moveTo(20,890)"));
    expect(drawn).not.toContain("moveTo(10,20)");
  });

  it("o traço feito depois de recortar cai onde o operador tocou", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    recortar();
    arrastarAlca("Canto superior esquerdo do recorte", [0, 0], [500, 300]);
    await screen.findByText("700×600 px");
    caneta();
    await waitFor(() => expect(canvas.width).toBe(700));

    desenhar(canvas, [[10, 20], [40, 60], [80, 90]]);
    // Dentro do recorte, (10,20) do canvas é (510,320) da foto.
    await waitFor(() => expect(drawn).toContain("moveTo(510,320)"));
  });

  it("o recorte corta o traço que ficou de fora e mantém o que ficou dentro", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    desenhar(canvas, [[600, 400], [640, 430], [700, 470]]);
    recortar();
    // Arrastar o canto de cima à esquerda até (500,300) deixa a seleção em
    // 700×600 a partir dali.
    arrastarAlca("Canto superior esquerdo do recorte", [0, 0], [500, 300]);
    await screen.findByText("700×600 px");
    caneta();

    await waitFor(() => expect(canvas.width).toBe(700));
    expect(canvas.height).toBe(600);
    // O traço continua em (600,400) na foto: quem se moveu foi a moldura. É esta a
    // ordem — traço na imagem, recorte por cima dela — e é o que faz o risco
    // continuar em cima do que ele marcou.
    expect(drawn).toContain("moveTo(600,400)");
    expect(geometria()).toBe("setTransform(1,0,0,1,-500,-300)");
  });

  it("recortar sozinho já muda o arquivo, mesmo sem nenhum traço", async () => {
    const client = await abrirConversa();
    await abrirEditor(originalImage());
    recortar();
    arrastarAlca("Canto inferior direito do recorte", [1200, 900], [700, 600]);
    await screen.findByText("700×600 px");
    fireEvent.click(screen.getByText("Concluir"));

    await screen.findByText("foto-editada.jpg");
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    // A regra de "sem traço, devolve o original" passa a valer para a edição
    // inteira: recorte e giro mudam os pixels tanto quanto um traço.
    expect(enviado(client)).not.toBe(originalImage());
    expect(exportedTypes).toHaveLength(1);
    expect(new TextDecoder().decode(await bytes(enviado(client)))).toContain("fillRect(0,0,700,600)");
  });

  it("concluir dentro do recorte exporta o resultado, não o quadro inteiro", async () => {
    const client = await abrirConversa();
    await abrirEditor(originalImage());
    recortar();
    arrastarAlca("Canto inferior direito do recorte", [1200, 900], [700, 600]);
    await screen.findByText("700×600 px");
    // Sem sair do modo recorte: o canvas ainda mostra o quadro inteiro com a
    // seleção por cima, e é o recorte que tem de ir para o arquivo.
    expect(canvasDoEditor().width).toBe(1200);
    fireEvent.click(screen.getByText("Concluir"));

    await screen.findByText("foto-editada.jpg");
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    expect(new TextDecoder().decode(await bytes(enviado(client)))).toContain("fillRect(0,0,700,600)");
  });

  it("girar leva o recorte junto, em vez de largá-lo noutro pedaço da foto", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    recortar();
    arrastarAlca("Canto inferior direito do recorte", [1200, 900], [700, 600]);
    await screen.findByText("700×600 px");
    caneta();

    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    // O recorte estava no canto de cima à esquerda; girando à direita ele tem de
    // ficar no canto de cima à direita, com os lados trocados.
    await waitFor(() => expect(canvas.width).toBe(600));
    expect(canvas.height).toBe(700);
    expect(geometria()).toBe("setTransform(0,1,-1,0,600,0)");
  });

  it("desfazer e refazer cobrem o traço, o recorte e o giro na mesma pilha", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    desenhar(canvas, [[10, 10], [60, 40], [120, 90]]);
    recortar();
    arrastarAlca("Canto inferior direito do recorte", [1200, 900], [700, 600]);
    await screen.findByText("700×600 px");
    caneta();
    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    await waitFor(() => expect(canvas.width).toBe(600));

    fireEvent.click(screen.getByLabelText("Desfazer"));
    await waitFor(() => expect(canvas.width).toBe(700));
    expect(canvas.height).toBe(600);
    fireEvent.click(screen.getByLabelText("Desfazer"));
    await waitFor(() => expect(canvas.width).toBe(1200));
    expect(tracos()).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Desfazer"));
    await waitFor(() => expect(tracos()).toHaveLength(0));
    expect(screen.getByLabelText("Desfazer")).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Refazer"));
    await waitFor(() => expect(tracos()).toHaveLength(1));
    fireEvent.click(screen.getByLabelText("Refazer"));
    await waitFor(() => expect(canvas.width).toBe(700));
  });

  it("descartar volta à imagem original mesmo depois de girar e recortar", async () => {
    const client = await abrirConversa();
    const original = originalImage();
    const canvas = await abrirEditor(original);
    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    recortar();
    arrastarAlca("Canto inferior direito do recorte", [900, 1200], [500, 700]);
    await screen.findByText("500×700 px");

    fireEvent.click(screen.getByText("Descartar edição"));
    await waitFor(() => expect(canvas.width).toBe(1200));
    expect(canvas.height).toBe(900);
    fireEvent.click(screen.getByText("Concluir"));
    fireEvent.click(await screen.findByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    // Voltou à original de verdade: nem sequer houve reexportação.
    expect(enviado(client)).toBe(original);
    expect(exportedTypes).toHaveLength(0);
  });

  it("as proporções de atalho enquadram a seleção sem sair da imagem", async () => {
    await abrirConversa();
    await abrirEditor(originalImage());
    recortar();

    fireEvent.click(screen.getByRole("radio", { name: "16:9" }));
    // Numa base 1200×900, o maior 16:9 centrado é 1200×675.
    await screen.findByText("1200×675 px");
    fireEvent.click(screen.getByRole("radio", { name: "1:1" }));
    // E o maior quadrado dentro de um 16:9 de 1200×675 é 675×675 — a proporção
    // encolhe a seleção, não pula de volta para a imagem inteira.
    await screen.findByText("675×675 px");
    expect(screen.getByRole("radio", { name: "1:1" })).toHaveAttribute("aria-checked", "true");
  });

  it("a seleção acompanha o arrasto antes de soltar", async () => {
    await abrirConversa();
    await abrirEditor(originalImage());
    recortar();

    fireEvent(screen.getByLabelText("Canto inferior direito do recorte"), pointer("pointerdown", { pointerId: 9, button: 0, clientX: 1200, clientY: 900 }));
    fireEvent(window, pointer("pointermove", { pointerId: 9, clientX: 800, clientY: 600 }));
    // Ainda com o dedo na tela. Sem o recorte vivo entrar na seleção, o operador
    // arrastaria às cegas e o enquadramento só apareceria ao soltar.
    await screen.findByText("800×600 px");

    fireEvent(window, pointer("pointerup", { pointerId: 9, clientX: 800, clientY: 600 }));
    await screen.findByText("800×600 px");
  });

  it("arrastar a alça de volta à borda deixa de ser recorte, e o arquivo volta a ser o original", async () => {
    const client = await abrirConversa();
    const original = originalImage();
    await abrirEditor(original);
    recortar();
    arrastarAlca("Canto inferior direito do recorte", [1200, 900], [700, 600]);
    await screen.findByText("700×600 px");

    arrastarAlca("Canto inferior direito do recorte", [700, 600], [1200, 900], 8);
    await screen.findByText("1200×900 px");
    fireEvent.click(screen.getByText("Concluir"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull());

    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    // Recortar o quadro inteiro é não recortar: guardar isso como recorte faria
    // uma imagem intocada ser recodificada por nada.
    expect(enviado(client)).toBe(original);
    expect(exportedTypes).toHaveLength(0);
  });

  it("a moldura carrega a proporção da saída, que é o que põe a alça sobre o pixel certo", async () => {
    await abrirConversa();
    await abrirEditor(originalImage());
    const moldura = () => document.querySelector<HTMLElement>(".composer-editor-frame")!;
    // 1200×900 deitada. A moldura mede a área desenhada, e é sobre ela que a
    // seleção do recorte é posicionada em porcentagem.
    await waitFor(() => expect(moldura().style.getPropertyValue("--editor-ratio")).toBe(`${1200 / 900}`));

    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    await waitFor(() => expect(moldura().style.getPropertyValue("--editor-ratio")).toBe("0.75"));

    recortar();
    arrastarAlca("Canto inferior direito do recorte", [900, 1200], [600, 600]);
    await screen.findByText("600×600 px");
    caneta();
    await waitFor(() => expect(moldura().style.getPropertyValue("--editor-ratio")).toBe("1"));
  });

  it("a alça também anda pelo teclado, que é como o recorte fica alcançável sem mouse", async () => {
    await abrirConversa();
    await abrirEditor(originalImage());
    recortar();

    fireEvent.keyDown(screen.getByLabelText("Borda direita do recorte"), { key: "ArrowLeft" });
    await screen.findByText("1199×900 px");
    fireEvent.keyDown(screen.getByLabelText("Borda direita do recorte"), { key: "ArrowLeft", shiftKey: true });
    await screen.findByText("1189×900 px");
  });

  it("depois de recortar, a caneta continua do mesmo tamanho para quem olha", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    desenhar(canvas, [[10, 10], [40, 40], [80, 20]]);
    // Nível 3 numa imagem de 1200 px de lado maior.
    expect(ultimoContexto().lineWidth).toBe(14);

    recortar();
    arrastarAlca("Canto inferior direito do recorte", [1200, 900], [600, 450]);
    await screen.findByText("600×450 px");
    caneta();
    await waitFor(() => expect(canvas.width).toBe(600));
    desenhar(canvas, [[100, 100], [140, 140], [180, 120]], 4);
    // Metade da imagem à vista, metade da espessura em pixels da base: na tela, o
    // traço sai com o mesmo peso do anterior. É tinta sobre a foto vista de perto.
    await waitFor(() => expect(ultimoContexto().lineWidth).toBe(7));
  });

  it("recusa a exportação grande também quando só houve recorte", async () => {
    const client = await abrirConversa();
    await abrirEditor(originalImage());
    recortar();
    arrastarAlca("Canto inferior direito do recorte", [1200, 900], [700, 600]);
    await screen.findByText("700×600 px");
    forcedBlobSize = IMAGE_UPLOAD_LIMIT + 1;
    fireEvent.click(screen.getByText("Concluir"));

    // A conferência de tamanho é na saída, e a saída da geometria passa pelo mesmo
    // caminho da saída do traço.
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent ?? "").toMatch(/limite de envio é 15 MB/i);
    expect(client.sendAttachment).not.toHaveBeenCalled();
  });

  it("reabrir traz o giro e o recorte de volta, ainda partindo do original", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    recortar();
    arrastarAlca("Canto inferior direito do recorte", [900, 1200], [500, 700]);
    await screen.findByText("500×700 px");
    fireEvent.click(screen.getByText("Concluir"));
    await screen.findByText("foto-editada.jpg");

    fireEvent.click(screen.getByLabelText("Editar com a caneta"));
    await screen.findByRole("dialog", { name: "Editar imagem" });
    const reaberto = canvasDoEditor();
    // A base é sempre o arquivo escolhido — 1200×900 —, e a geometria volta por
    // cima dele: uma recodificação, não duas.
    await waitFor(() => expect(reaberto.width).toBe(500));
    expect(reaberto.height).toBe(700);
    expect(geometria()).toBe("setTransform(0,1,-1,0,900,0)");
    expect(screen.getByLabelText("Desfazer")).not.toBeDisabled();
    expect(canvas.isConnected).toBe(false);
  });

  it("a moldura e as alças têm estilo próprio, com a proporção da imagem", () => {
    // A moldura mede exatamente a área desenhada. Sem ela, `object-fit: contain`
    // deixaria faixa vazia dentro da caixa do canvas e a alça — posicionada em
    // porcentagem — pousaria fora da imagem.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-frame\s*\{[^}]*aspect-ratio:\s*var\(--editor-ratio/);
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-frame\s*\{[^}]*position:\s*relative/);
    // A camada do recorte precisa recortar a sombra que escurece o lado de fora.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-crop\s*\{[^}]*overflow:\s*hidden/);
    // E a alça, como o canvas, não pode deixar o dedo rolar a conversa.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-crop-handle\s*\{[^}]*touch-action:\s*none/);
    // A alça é posicionada contra a caixa da seleção; no fluxo normal ela cairia
    // enfileirada num canto e nenhuma quina teria a sua.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-crop-handle\s*\{[^}]*position:\s*absolute/);
  });
});
