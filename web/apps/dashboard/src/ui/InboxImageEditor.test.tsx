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
    // O texto entra no registro com o próprio conteúdo, então a frase escrita acaba
    // nos bytes exportados: é assim que o teste prova que ela foi para o arquivo, e
    // não só para a tela.
    fillText: (text: string, x: number, y: number) => { drawn.push(`fillText:${text}(${x},${y})`); },
    strokeText: (text: string, x: number, y: number) => { drawn.push(`strokeText:${text}(${x},${y})`); },
    measureText: (text: string) => ({ width: text.length * 12 }),
    fillStyle: "", strokeStyle: "", lineWidth: 0, lineCap: "butt", lineJoin: "miter",
    font: "", textAlign: "start", textBaseline: "alphabetic",
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

const modoTexto = () => fireEvent.click(screen.getByLabelText("Texto"));
const campoTexto = () => screen.getByLabelText("Conteúdo do texto") as HTMLInputElement;
/** Toca a imagem para criar a caixa e digita. O ponteiro não precisa de `pointerup`:
 *  a caixa nasce no `pointerdown`, que é onde o operador vê o cursor aparecer. */
const escrever = (canvas: HTMLCanvasElement, [x, y]: [number, number], frase: string, pointerId = 3) => {
  fireEvent(canvas, pointer("pointerdown", { pointerId, button: 0, clientX: x, clientY: y }));
  fireEvent.change(campoTexto(), { target: { value: frase } });
};
/** A matriz aplicada logo antes de escrever a frase: é ela que diz onde o texto foi
 *  parar e em que orientação — as duas coisas que o giro e o recorte podem estragar. */
const matrizDoTexto = (frase: string) => {
  const indice = drawn.findIndex((op) => op.startsWith(`fillText:${frase}(`));
  return indice < 0 ? undefined : drawn.slice(0, indice).filter((op) => op.startsWith("setTransform")).at(-1);
};
const numeros = (op?: string) => (op ?? "").replace(/^[^(]*\(/, "").replace(/\)$/, "").split(",").map(Number);
const alcaDoTexto = (frase: string) => screen.getByLabelText(`Texto “${frase}”`);

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

describe("texto", () => {
  /** A base é 1200×900 aqui também, e o `getBoundingClientRect` do jsdom devolve tudo
   *  zero — a guarda de `canvasPoint` faz a coordenada da tela valer a da imagem, que
   *  é o que torna estes números legíveis. O medidor de mentira dá 12 px por
   *  caractere, então "aqui" mede 48 px. */
  it("o caminho inteiro: a frase escrita vai para os bytes do arquivo enviado", async () => {
    const client = await abrirConversa();
    const original = originalImage();
    const canvas = await abrirEditor(original);
    modoTexto();
    escrever(canvas, [300, 400], "URGENTE");
    fireEvent.click(screen.getByText("Concluir"));

    await screen.findByText("foto-editada.jpg");
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());

    const arquivo = enviado(client);
    expect(arquivo.type).toBe("image/jpeg");
    const saida = new TextDecoder().decode(await bytes(arquivo));
    // A frase está no arquivo, não só na tela — e o original ficou para trás.
    expect(saida).toContain("fillText:URGENTE");
    expect(saida).not.toContain("original-sem-marcacao");
  });

  it("caixa criada e deixada vazia devolve o próprio original, sem recodificar", async () => {
    const client = await abrirConversa();
    const original = originalImage();
    const canvas = await abrirEditor(original);
    modoTexto();
    // Tocar a imagem e desistir de digitar não põe pixel nenhum: reexportar aqui
    // perderia qualidade e EXIF por nada.
    fireEvent(canvas, pointer("pointerdown", { pointerId: 3, button: 0, clientX: 300, clientY: 400 }));
    fireEvent.click(screen.getByText("Concluir"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull());

    expect(exportedTypes).toHaveLength(0);
    fireEvent.click(await screen.findByLabelText("Enviar"));
    await waitFor(() => expect(client.sendAttachment).toHaveBeenCalled());
    expect(enviado(client)).toBe(original);
  });

  it("desfazer apaga a palavra inteira, não uma letra por tecla", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    fireEvent(canvas, pointer("pointerdown", { pointerId: 3, button: 0, clientX: 300, clientY: 400 }));
    for (const parcial of ["u", "ur", "urg", "urgente"]) fireEvent.change(campoTexto(), { target: { value: parcial } });
    expect(matrizDoTexto("urgente")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Desfazer"));
    expect(matrizDoTexto("urgente")).toBeUndefined();
    // Nem sobrou o passo intermediário, nem a caixa vazia da criação: escrever é um
    // gesto só, e o histórico guarda gestos.
    expect(matrizDoTexto("urg")).toBeUndefined();
    expect(screen.getByLabelText("Desfazer")).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Refazer"));
    expect(matrizDoTexto("urgente")).toBeTruthy();
  });

  it("texto e traço saem da mesma pilha de desfazer, na ordem em que foram feitos", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    desenhar(canvas, [[10, 10], [60, 40], [120, 90]]);
    modoTexto();
    escrever(canvas, [300, 400], "junto");
    expect(tracos()).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("Desfazer"));
    expect(matrizDoTexto("junto")).toBeUndefined();
    expect(tracos()).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Desfazer"));
    expect(tracos()).toHaveLength(0);
  });

  it("arrastar a caixa move o texto pelo mesmo tanto que o ponteiro andou", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "aqui");
    const antes = numeros(matrizDoTexto("aqui"));

    fireEvent(alcaDoTexto("aqui"), pointer("pointerdown", { pointerId: 5, button: 0, clientX: 300, clientY: 400 }));
    fireEvent(window, pointer("pointermove", { pointerId: 5, clientX: 500, clientY: 430 }));
    // O texto já acompanha o dedo antes de soltar: sem isso o arrasto seria às cegas,
    // e só ao largar é que o operador descobriria onde a frase caiu.
    expect(numeros(matrizDoTexto("aqui"))[4]).toBeCloseTo(antes[4] + 200);
    fireEvent(window, pointer("pointerup", { pointerId: 5, clientX: 500, clientY: 430 }));

    const depois = numeros(matrizDoTexto("aqui"));
    expect(depois[4]).toBeCloseTo(antes[4] + 200);
    expect(depois[5]).toBeCloseTo(antes[5] + 30);
  });

  it("a caixa também anda pelo teclado, que é como o texto fica alcançável sem mouse", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "seta");
    const antes = numeros(matrizDoTexto("seta"));

    fireEvent.keyDown(alcaDoTexto("seta"), { key: "ArrowRight" });
    expect(numeros(matrizDoTexto("seta"))[4]).toBeCloseTo(antes[4] + 1);
    fireEvent.keyDown(alcaDoTexto("seta"), { key: "ArrowDown", shiftKey: true });
    expect(numeros(matrizDoTexto("seta"))[5]).toBeCloseTo(antes[5] + 10);
    // Segurar a seta dispara uma tecla por quadro: os dois passos são um gesto só de
    // reposicionar, como o arrasto do ponteiro é um gesto só.
    fireEvent.click(screen.getByLabelText("Desfazer"));
    expect(numeros(matrizDoTexto("seta"))).toEqual(antes);
  });

  it("criar texto sem ponteiro nenhum: o botão põe a caixa no meio e o foco vai para o campo", async () => {
    await abrirConversa();
    await abrirEditor(originalImage());
    modoTexto();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar texto" }));
    // Sem o foco automático, o operador de teclado teria de sair procurando o campo
    // depois de cada inserção.
    await waitFor(() => expect(document.activeElement).toBe(campoTexto()));

    fireEvent.change(campoTexto(), { target: { value: "sem mouse" } });
    // Base 1200×900, corpo 60: a caixa vazia mede meio corpo (30 px) e a linha 76,8.
    // O meio é (600, 450), então a caixa nasce em (585, 411,6) — centrada, e não num
    // quarto da largura. É a única inserção que o teclado alcança; largá-la fora do
    // meio deixa quem não tem mouse escrevendo num canto.
    const posto = numeros(matrizDoTexto("sem mouse"));
    expect(posto[4]).toBeCloseTo(585);
    expect(posto[5]).toBeCloseTo(411.6);
  });

  it("o botão não empilha uma caixa em cima da outra", async () => {
    await abrirConversa();
    await abrirEditor(originalImage());
    modoTexto();
    // Com a foto girada, "uma linha abaixo" na tela é outra direção na base: medir o
    // passo na base faria a segunda caixa andar para o lado em vez de descer.
    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    modoTexto();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar texto" }));
    await waitFor(() => expect(document.activeElement).toBe(campoTexto()));
    fireEvent.change(campoTexto(), { target: { value: "primeira" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar texto" }));
    fireEvent.change(campoTexto(), { target: { value: "segunda" } });

    // Sem descer uma linha, as duas caixas nasceriam no mesmo pixel: a segunda frase
    // sairia escrita por cima da primeira e as alças se sobreporiam.
    const primeira = numeros(matrizDoTexto("primeira"));
    const segunda = numeros(matrizDoTexto("segunda"));
    expect(segunda[5]).toBeCloseTo(primeira[5] + 76.8);
    expect(segunda[4]).toBeCloseTo(primeira[4]);
  });

  it("descartar varre as caixas vazias que sobraram na tela", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    fireEvent(canvas, pointer("pointerdown", { pointerId: 3, button: 0, clientX: 300, clientY: 400 }));
    fireEvent(canvas, pointer("pointerdown", { pointerId: 4, button: 0, clientX: 600, clientY: 700 }));
    expect(screen.getAllByLabelText("Texto sem conteúdo")).toHaveLength(2);

    // Caixa vazia não é marcação (§3.6) e o arquivo continua o original — mas ela está
    // na tela, e com o botão desabilitado não haveria como varrê-las de uma vez.
    fireEvent.click(screen.getByText("Descartar edição"));
    expect(screen.queryByLabelText("Texto sem conteúdo")).toBeNull();
  });

  it("texto que o recorte jogou fora não deixa alça invisível no caminho do Tab", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [1000, 800], "no canto");
    expect(alcaDoTexto("no canto")).toBeTruthy();

    recortar();
    arrastarAlca("Canto inferior direito do recorte", [1200, 900], [600, 450]);
    caneta();
    modoTexto();
    // O recorte corta a marcação como corta tinta, e o texto sai do arquivo junto —
    // mas a alça não pode ficar para trás: a camada tem `overflow: hidden`, então ela
    // seria um alvo de Tab que ninguém vê, e um Delete ali apagaria às cegas.
    expect(matrizDoTexto("no canto")).toBeTruthy();
    expect(screen.queryByLabelText("Texto “no canto”")).toBeNull();
  });

  it("clicar numa alça dá foco a ela, senão a seta continuaria movendo o texto anterior", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [200, 200], "antes");
    escrever(canvas, [200, 600], "depois", 4);

    fireEvent(alcaDoTexto("antes"), pointer("pointerdown", { pointerId: 9, button: 0, clientX: 200, clientY: 200 }));
    fireEvent(window, pointer("pointerup", { pointerId: 9, clientX: 200, clientY: 200 }));
    // `preventDefault` num ponteiro impede o navegador de dar o foco, e sem foco a
    // barra falaria de um texto e o teclado de outro.
    expect(document.activeElement).toBe(alcaDoTexto("antes"));
  });

  it("Esc solta a seleção e fecha o passo: o que for digitado depois não engole o anterior", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "aa");

    fireEvent.keyDown(campoTexto(), { key: "Escape" });
    fireEvent.click(alcaDoTexto("aa"));
    fireEvent.change(campoTexto(), { target: { value: "bbb" } });
    // Sem fechar o agrupamento no Esc, esta digitação substituiria o passo do "aa" e
    // um Desfazer pularia direto para antes do texto existir.
    fireEvent.click(screen.getByLabelText("Desfazer"));
    expect(matrizDoTexto("aa")).toBeTruthy();
  });

  it("escrever depois de endireitar a foto sai em pé, e não deitado junto com ela", async () => {
    // O caso que decide o modelo: quem gira para endireitar e SÓ ENTÃO escreve tem de
    // ver letra em pé. Desenhar em coordenadas da base com a matriz do giro ativa
    // faria a frase correr para baixo, na mesma sessão, sem nenhum passo intermediário.
    await abrirConversa();
    await abrirEditor(originalImage());
    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    modoTexto();
    escrever(canvasDoEditor(), [200, 300], "reto");
    // Matriz de translação pura: nenhum giro sobrou para deitar a letra. E a
    // translação prova as outras duas contas do toque — a caixa nasce na coluna do
    // dedo (200) e meia linha acima dele (300 − 76,8/2), com a meia linha medida na
    // TELA: em coordenadas da base ela apontaria para o lado numa foto girada.
    expect(numeros(matrizDoTexto("reto"))).toEqual([1, 0, 0, 1, 200, 261.6]);
  });

  it("girar depois de escrever leva o texto junto, como leva a tinta", async () => {
    // A outra metade da mesma decisão: o texto é tinta sobre a foto. Quem marcou e
    // depois virou a foto vira a marca junto, como aconteceria no papel.
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "vira");
    expect(numeros(matrizDoTexto("vira")).slice(0, 4)).toEqual([1, 0, 0, 1]);

    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    expect(numeros(matrizDoTexto("vira")).slice(0, 4)).toEqual([0, 1, -1, 0]);
  });

  it("o recorte desloca o texto pelo mesmo tanto que desloca a imagem", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "corte");
    const antes = numeros(matrizDoTexto("corte"));

    recortar();
    arrastarAlca("Canto superior esquerdo do recorte", [0, 0], [100, 200]);
    caneta();

    const depois = numeros(matrizDoTexto("corte"));
    expect(depois[4]).toBeCloseTo(antes[4] - 100);
    expect(depois[5]).toBeCloseTo(antes[5] - 200);
  });

  it("uma frase longa perto da borda encosta na margem em vez de vazar da imagem", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    // 22 caracteres a 12 px medem 264: começando em 1190 numa base de 1200, o texto
    // sairia quase inteiro para fora e o envio levaria a frase cortada.
    escrever(canvas, [1190, 400], "uma frase bem comprida");
    // Exatamente encostado: a medida vem do contexto que desenhou, e não de um palpite
    // por número de caracteres — palpite erraria a margem para os dois lados.
    expect(numeros(matrizDoTexto("uma frase bem comprida"))[4]).toBeCloseTo(1200 - 264);
  });

  it("selecionar um texto já criado traz o conteúdo dele de volta ao campo", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [200, 300], "um");
    escrever(canvas, [400, 500], "dois", 4);
    expect(campoTexto().value).toBe("dois");

    fireEvent.click(alcaDoTexto("um"));
    expect(campoTexto().value).toBe("um");
    fireEvent.change(campoTexto(), { target: { value: "primeiro" } });
    expect(matrizDoTexto("primeiro")).toBeTruthy();
    expect(matrizDoTexto("dois")).toBeTruthy();
  });

  it("selecionar traz também o tamanho daquele texto para a régua", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [200, 300], "grande");
    fireEvent.change(screen.getByLabelText("Tamanho do texto"), { target: { value: "6" } });
    escrever(canvas, [200, 600], "outro", 4);
    fireEvent.change(screen.getByLabelText("Tamanho do texto"), { target: { value: "2" } });

    // Sem sincronizar, a régua ficaria no último valor e o primeiro arrasto dela
    // redimensionaria o texto para um tamanho que ninguém pediu.
    fireEvent.click(alcaDoTexto("grande"));
    expect((screen.getByLabelText("Tamanho do texto") as HTMLInputElement).value).toBe("6");
  });

  it("Enter na caixa leva ao campo mesmo com o texto ainda não selecionado", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "curto");
    // O foco que a criação agendou ainda está na fila de microtasks; sem drená-lo
    // aqui, ele chegaria durante o `waitFor` lá embaixo e daria o foco ao campo por
    // conta própria — mascarando exatamente o que este teste quer prender.
    await Promise.resolve();
    // Sair do texto e voltar solta a seleção — é o mesmo estado de quem reabriu o
    // editor. O campo está desabilitado, e elemento desabilitado não recebe foco:
    // mandar o foco no mesmo tique deixaria quem só tem teclado digitando no vazio.
    caneta();
    modoTexto();
    expect(campoTexto()).toBeDisabled();
    expect(document.activeElement).not.toBe(campoTexto());

    fireEvent.keyDown(alcaDoTexto("curto"), { key: "Enter" });
    await waitFor(() => expect(document.activeElement).toBe(campoTexto()));

    fireEvent.change(campoTexto(), { target: { value: "x".repeat(400) } });
    expect(campoTexto().value).toHaveLength(120);
  });

  it("a caixa do texto só existe no modo texto", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "oculta");
    caneta();
    // No modo caneta a alça sairia na frente do traço: quem quer riscar por cima do
    // texto acertaria a caixa em vez da imagem.
    expect(screen.queryByLabelText("Texto “oculta”")).toBeNull();
    expect(matrizDoTexto("oculta")).toBeTruthy();
  });

  it("desfazer solta a seleção, para ela não cair num id reaproveitado", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    // O id novo é o maior da lista mais um, então apagar o segundo devolve o crachá 2
    // para o terceiro. Sem soltar a seleção, desfazer até o passo em que o crachá 2
    // era do "b" faria o campo — e o Apagar — passarem a falar de outro texto.
    escrever(canvas, [200, 200], "a");
    escrever(canvas, [200, 400], "b", 4);
    fireEvent.click(screen.getByLabelText("Apagar texto"));
    escrever(canvas, [200, 600], "c", 5);

    fireEvent.click(screen.getByLabelText("Desfazer"));
    fireEvent.click(screen.getByLabelText("Desfazer"));
    expect(matrizDoTexto("b")).toBeTruthy();
    expect(campoTexto()).toBeDisabled();
  });

  it("desfazer fecha o agrupamento, senão o passo seguinte engole o que foi restaurado", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "chave");
    const antes = numeros(matrizDoTexto("chave"));

    fireEvent.keyDown(alcaDoTexto("chave"), { key: "ArrowRight" });
    fireEvent.click(screen.getByLabelText("Desfazer"));
    // A chave do passo desfeito ainda era `move`. Se ela sobreviver ao desfazer, esta
    // seta substitui o passo restaurado em vez de empilhar sobre ele — e o desfazer
    // seguinte pula direto para antes do texto existir.
    fireEvent.keyDown(alcaDoTexto("chave"), { key: "ArrowRight" });
    fireEvent.click(screen.getByLabelText("Desfazer"));
    expect(numeros(matrizDoTexto("chave"))).toEqual(antes);
  });

  it("sair da caixa fecha o passo: dois grupos de setas são dois desfazeres", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "duas");
    const antes = numeros(matrizDoTexto("duas"));

    fireEvent.keyDown(alcaDoTexto("duas"), { key: "ArrowRight" });
    fireEvent.blur(alcaDoTexto("duas"));
    fireEvent.keyDown(alcaDoTexto("duas"), { key: "ArrowRight" });
    expect(numeros(matrizDoTexto("duas"))[4]).toBeCloseTo(antes[4] + 2);

    fireEvent.click(screen.getByLabelText("Desfazer"));
    expect(numeros(matrizDoTexto("duas"))[4]).toBeCloseTo(antes[4] + 1);
  });

  it("reabrir não traz de volta a caixa vazia que ficou para trás", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    // Criar a caixa e desistir: não é trabalho, e não tem por que virar um passo de
    // desfazer que não muda nada na tela quando o editor reabrir.
    fireEvent(canvas, pointer("pointerdown", { pointerId: 3, button: 0, clientX: 300, clientY: 400 }));
    fireEvent.click(screen.getByText("Concluir"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull());

    fireEvent.click(screen.getByLabelText("Editar com a caneta"));
    await screen.findByRole("dialog", { name: "Editar imagem" });
    modoTexto();
    expect(screen.queryByLabelText("Texto sem conteúdo")).toBeNull();
    expect(screen.getByLabelText("Desfazer")).toBeDisabled();
  });

  it("apagar tira o texto selecionado, pelo botão e pela tecla", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "some");
    fireEvent.click(screen.getByLabelText("Apagar texto"));
    expect(matrizDoTexto("some")).toBeUndefined();
    expect(screen.queryByLabelText("Texto “some”")).toBeNull();

    escrever(canvas, [300, 400], "tambem", 6);
    fireEvent.keyDown(alcaDoTexto("tambem"), { key: "Delete" });
    expect(matrizDoTexto("tambem")).toBeUndefined();
  });

  it("a cor e o tamanho escolhidos chegam ao texto", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    fireEvent.click(screen.getByLabelText("Verde"));
    escrever(canvas, [300, 400], "verde");
    expect(ultimoContexto().fillStyle).toBe("#25d366");

    // E a cor escolhida com o texto já criado recolore o que está selecionado, em vez
    // de valer só para o próximo.
    fireEvent.click(screen.getByLabelText("Azul"));
    expect(ultimoContexto().fillStyle).toBe("#59adff");

    const corpo = () => Number(/(\d+)px/.exec(String(ultimoContexto().font))?.[1]);
    const antes = corpo();
    fireEvent.change(screen.getByLabelText("Tamanho do texto"), { target: { value: "6" } });
    expect(corpo()).toBeGreaterThan(antes!);
  });

  it("a alça do texto pousa sobre as letras, em porcentagem da moldura", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "alça");
    // Base 1200×900: 300 px é um quarto da largura, e "alça" mede 4×12 = 48 px, que é
    // 4% dela. Sem a moldura com a proporção da saída, a porcentagem cairia noutro
    // pixel — é o caso de §3.11.
    expect((alcaDoTexto("alça") as HTMLElement).style.left).toBe("25%");
    expect((alcaDoTexto("alça") as HTMLElement).style.width).toBe("4%");

    // Girada a foto, a alça acompanha pela mesma matriz do desenho: a largura de 48 px
    // vira altura, agora sobre um canvas de 900×1200.
    fireEvent.click(screen.getByLabelText("Girar 90° à direita"));
    expect((alcaDoTexto("alça") as HTMLElement).style.height).toBe("4%");
  });

  it("sair do modo texto solta a seleção, para a régua não mexer no que ninguém vê", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "solta");
    expect(campoTexto()).not.toBeDisabled();

    caneta();
    modoTexto();
    expect(campoTexto()).toBeDisabled();
    expect(screen.getByLabelText("Apagar texto")).toBeDisabled();
  });

  it("Esc no campo de texto solta a seleção antes de fechar o editor", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "fica");
    // Um Esc por passo: fechar o painel na primeira tecla perderia a edição inteira de
    // quem só queria sair do campo.
    fireEvent.keyDown(campoTexto(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Editar imagem" })).not.toBeNull();
    expect(matrizDoTexto("fica")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Editar imagem" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar imagem" })).toBeNull());
  });

  it("descartar a edição leva o texto junto, e desfazer traz tudo de volta", async () => {
    await abrirConversa();
    const canvas = await abrirEditor(originalImage());
    modoTexto();
    escrever(canvas, [300, 400], "vai e volta");
    fireEvent.click(screen.getByText("Descartar edição"));
    expect(matrizDoTexto("vai e volta")).toBeUndefined();

    fireEvent.click(screen.getByLabelText("Desfazer"));
    expect(matrizDoTexto("vai e volta")).toBeTruthy();
  });

  it("reabrir traz o texto de volta, ainda partindo do arquivo original", async () => {
    await abrirConversa();
    const original = originalImage();
    const canvas = await abrirEditor(original);
    modoTexto();
    escrever(canvas, [300, 400], "de novo");
    fireEvent.click(screen.getByText("Concluir"));
    await screen.findByText("foto-editada.jpg");

    fireEvent.click(screen.getByLabelText("Editar com a caneta"));
    await screen.findByRole("dialog", { name: "Editar imagem" });
    await waitFor(() => expect(canvasDoEditor().width).toBeGreaterThan(0));
    modoTexto();
    expect(alcaDoTexto("de novo")).toBeTruthy();
    expect(screen.getByLabelText("Desfazer")).not.toBeDisabled();

    fireEvent.click(screen.getByText("Concluir"));
    // O nome prova a origem: reeditar a exportação anterior devolveria
    // "foto-editada-editada.jpg", e cada passagem teria custado uma recompressão.
    await screen.findByText("foto-editada.jpg");
    expect(exportedTypes).toHaveLength(2);
  });

  it("a camada e a alça do texto têm estilo próprio, com os tokens que já existiam", () => {
    // A camada recorta a alça que escapa da imagem e não intercepta ponteiro: quem
    // desenha é o canvas por baixo.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-text-layer\s*\{[^}]*overflow:\s*hidden/);
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-text-layer\s*\{[^}]*pointer-events:\s*none/);
    // A alça é posicionada contra a moldura; no fluxo normal cairia enfileirada.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-text-item\s*\{[^}]*position:\s*absolute/);
    // E, como o canvas, não pode deixar o dedo rolar a conversa durante o arrasto.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-text-item\s*\{[^}]*touch-action:\s*none/);
    // Sem foco visível, quem chega de Tab não sabe em qual texto está.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-editor-text-item:focus-visible\s*\{[^}]*outline/);

    const regra = /\.chat-inbox \.composer-editor-text-item\s*\{([^}]*)\}/.exec(stylesheet)!;
    for (const token of new Set([...regra[1].matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0])))
      expect(stylesheet.split(token).length - 1, `${token} é uma cor nova`).toBeGreaterThan(1);
  });
});
