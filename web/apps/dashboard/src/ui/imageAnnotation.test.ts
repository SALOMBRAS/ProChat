import { describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import {
  ANNOTATION_BACKDROP,
  EDITABLE_IMAGE_TYPES,
  EDITOR_MAX_DIMENSION,
  IMAGE_UPLOAD_LIMIT,
  PEN_COLORS,
  PEN_LEVELS,
  annotatedName,
  canvasPoint,
  exportAnnotated,
  exportPlan,
  fitWithin,
  isEditableImage,
  penWidth,
  pointerSamples,
  renderAnnotation,
  tracePath,
  type AnnotationContext,
  type Stroke,
} from "./imageAnnotation.js";

/**
 * A aritmética do editor de imagem. O canvas do jsdom não desenha, então o que dá
 * para prender aqui é a decisão: quanto a imagem encolhe, que curva o traço
 * descreve entre dois pontos e que arquivo sai da reexportação.
 */
type Op = { name: string; args: number[] };
const spyContext = () => {
  const ops: Op[] = [];
  const record = (name: string) => (...args: unknown[]) => { ops.push({ name, args: args.filter((value): value is number => typeof value === "number") }); };
  const context = {
    ops,
    save: record("save"), restore: record("restore"),
    beginPath: record("beginPath"), moveTo: record("moveTo"), lineTo: record("lineTo"),
    quadraticCurveTo: record("quadraticCurveTo"), stroke: record("stroke"),
    fillRect: record("fillRect"), drawImage: record("drawImage"),
    fillStyle: "", strokeStyle: "", lineWidth: 0, lineCap: "butt" as CanvasLineCap, lineJoin: "miter" as CanvasLineJoin,
  };
  return context as typeof context & AnnotationContext;
};
const line = (points: [number, number][]): Stroke => ({ color: "#fb7185", width: 8, points: points.map(([x, y]) => ({ x, y })) });
const names = (context: { ops: Op[] }) => context.ops.map((op) => op.name);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** Canvas de mentira que devolve o blob combinado por tipo pedido — é assim que dá
 *  para exercitar a escolha de formato sem um encoder de verdade. */
const canvasReturning = (blobs: Record<string, Blob | null>) => ({
  toBlob: vi.fn((callback: (blob: Blob | null) => void, type = "image/png") => callback(blobs[type] ?? null)),
});
const sourceFile = (name: string, type: string) => new File([JPEG], name, { type });

describe("teto de resolução", () => {
  it("não mexe em imagem que já cabe", () => {
    expect(fitWithin(1200, 900)).toEqual({ width: 1200, height: 900, reduced: false });
  });

  it("reduz pelo lado maior e mantém a proporção", () => {
    // 12000×9000 é a foto crua de um celular de 108 MP: 432 MB de backing store.
    const fitted = fitWithin(12_000, 9_000);
    expect(fitted.reduced).toBe(true);
    expect(Math.max(fitted.width, fitted.height)).toBe(EDITOR_MAX_DIMENSION);
    expect(fitted.width / fitted.height).toBeCloseTo(12_000 / 9_000, 2);
  });

  it("reduz também quando o lado maior é a altura", () => {
    const fitted = fitWithin(2_000, 8_000);
    expect(fitted.height).toBe(EDITOR_MAX_DIMENSION);
    expect(fitted.width).toBe(640);
  });

  it("nunca devolve dimensão zero", () => {
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1, reduced: false });
    expect(fitWithin(20_000, 1).height).toBe(1);
  });
});

describe("espessura da caneta", () => {
  it("é proporcional ao lado maior, então o mesmo nível pesa igual na tela", () => {
    // O painel mostra a imagem sempre na mesma largura: proporcional à imagem quer
    // dizer constante para quem olha.
    expect(penWidth(3, 2560) / 2560).toBeCloseTo(penWidth(3, 640) / 640, 2);
    expect(penWidth(6, 2560)).toBeGreaterThan(penWidth(1, 2560));
  });

  it("não deixa o traço sumir em imagem pequena", () => {
    expect(penWidth(1, 60)).toBeGreaterThanOrEqual(2);
  });

  it("prende o nível na faixa oferecida", () => {
    expect(penWidth(99, 2560)).toBe(penWidth(PEN_LEVELS.max, 2560));
    expect(penWidth(-4, 2560)).toBe(penWidth(PEN_LEVELS.min, 2560));
  });
});

describe("suavização do traço", () => {
  it("interpola entre os pontos em vez de ligá-los com reta", () => {
    const context = spyContext();
    tracePath(context, line([[0, 0], [10, 40], [50, 45], [90, 10]]));
    // Quatro pontos: um moveTo, duas quadráticas pelos pontos do meio e o lineTo
    // final. Nenhum lineTo entre pontos intermediários — é aí que o traço quebrava.
    expect(names(context).filter((name) => name === "quadraticCurveTo")).toHaveLength(2);
    expect(names(context).filter((name) => name === "lineTo")).toHaveLength(1);
  });

  it("o destino de cada curva é o meio do segmento seguinte", () => {
    const context = spyContext();
    tracePath(context, line([[0, 0], [10, 40], [50, 60]]));
    const curve = context.ops.find((op) => op.name === "quadraticCurveTo")!;
    // controle = ponto captado; destino = meio entre ele e o próximo.
    expect(curve.args).toEqual([10, 40, 30, 50]);
  });

  it("um gesto rápido com poucos pontos distantes ainda sai contínuo", () => {
    const context = spyContext();
    tracePath(context, line([[0, 0], [400, 20], [800, 0], [1200, 30], [1600, 0]]));
    expect(names(context).filter((name) => name === "quadraticCurveTo")).toHaveLength(3);
    expect(names(context)).toContain("stroke");
  });

  it("toque sem arrastar deixa marca", () => {
    const context = spyContext();
    tracePath(context, line([[12, 12]]));
    expect(context.ops.filter((op) => op.name === "lineTo")).toHaveLength(1);
    expect(names(context)).toContain("stroke");
    expect(context.lineCap).toBe("round");
  });

  it("aplica cor e espessura do próprio traço", () => {
    const context = spyContext();
    tracePath(context, { color: "#25d366", width: 17, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
    expect(context.strokeStyle).toBe("#25d366");
    expect(context.lineWidth).toBe(17);
    expect(context.lineJoin).toBe("round");
  });

  it("traço vazio não desenha nada", () => {
    const context = spyContext();
    tracePath(context, line([]));
    expect(context.ops).toHaveLength(0);
  });
});

describe("repintura", () => {
  it("pinta a base opaca antes da imagem", () => {
    const context = spyContext();
    renderAnnotation(context, undefined, [], { width: 100, height: 80 });
    // JPEG não tem alfa: sem esta base, área transparente sairia preta no reencode.
    expect(names(context).indexOf("fillRect")).toBeLessThan(names(context).indexOf("restore"));
    expect(context.fillStyle).toBe(ANNOTATION_BACKDROP);
    expect(context.ops.find((op) => op.name === "fillRect")!.args).toEqual([0, 0, 100, 80]);
  });

  it("desenha a imagem e depois os traços, na ordem", () => {
    const context = spyContext();
    const image = {} as CanvasImageSource;
    renderAnnotation(context, image, [line([[0, 0], [5, 5]]), line([[9, 9], [1, 1]])], { width: 10, height: 10 });
    const ordem = names(context);
    expect(ordem.indexOf("drawImage")).toBeLessThan(ordem.indexOf("moveTo"));
    expect(ordem.filter((name) => name === "stroke")).toHaveLength(2);
  });
});

describe("ponto do ponteiro", () => {
  const canvasWith = (rect: Partial<DOMRect>, width: number, height: number) => ({
    width, height,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, ...rect }) as DOMRect,
  }) as HTMLCanvasElement;

  it("converte da tela para a resolução da imagem", () => {
    // Canvas de 2560 px mostrado em 400 px: cada pixel de tela vale 6,4 do canvas.
    expect(canvasPoint(canvasWith({ left: 100, top: 50, width: 400, height: 300 }, 2560, 1920), 300, 200)).toEqual({ x: 1280, y: 960 });
  });

  it("não vira NaN quando o layout ainda não foi medido", () => {
    expect(canvasPoint(canvasWith({}, 800, 600), 40, 30)).toEqual({ x: 40, y: 30 });
  });
});

describe("pontos engolidos pelo navegador", () => {
  it("usa os pontos coalescidos quando o navegador os expõe", () => {
    const samples = pointerSamples({ clientX: 90, clientY: 90, nativeEvent: { getCoalescedEvents: () => [{ clientX: 10, clientY: 10 }, { clientX: 50, clientY: 40 }, { clientX: 90, clientY: 90 }] } });
    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual({ clientX: 10, clientY: 10 });
  });

  it("cai no ponto do próprio evento onde não há coalescidos", () => {
    expect(pointerSamples({ clientX: 7, clientY: 8, nativeEvent: {} })).toEqual([{ clientX: 7, clientY: 8 }]);
    expect(pointerSamples({ clientX: 7, clientY: 8, nativeEvent: { getCoalescedEvents: () => [] } })).toEqual([{ clientX: 7, clientY: 8 }]);
  });
});

describe("formato de saída", () => {
  it("PNG tenta continuar PNG, com JPEG como saída de emergência", () => {
    expect(exportPlan("image/png")).toEqual([{ type: "image/png" }, { type: "image/jpeg", quality: 0.92 }]);
  });

  it("JPEG e WebP saem como JPEG", () => {
    // WebP não vira WebP porque o encoder do canvas só chegou ao Safari 16.4, e o
    // fallback do spec é PNG — um PNG de foto passaria dos 15 MB.
    expect(exportPlan("image/jpeg")).toEqual([{ type: "image/jpeg", quality: 0.92 }]);
    expect(exportPlan("image/webp")).toEqual([{ type: "image/jpeg", quality: 0.92 }]);
  });

  it("a extensão acompanha o mime real", () => {
    expect(annotatedName("print.png", "image/jpeg")).toBe("print-editada.jpg");
    expect(annotatedName("print.png", "image/png")).toBe("print-editada.png");
    expect(annotatedName("sem-extensao", "image/jpeg")).toBe("sem-extensao-editada.jpg");
  });

  it("só reconhece os mimes da allowlist do servidor", () => {
    expect(EDITABLE_IMAGE_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(isEditableImage("image/heic")).toBe(false);
    expect(isEditableImage("image/gif")).toBe(false);
    expect(isEditableImage(undefined)).toBe(false);
    expect(isEditableImage("image/webp")).toBe(true);
  });
});

describe("reexportação", () => {
  it("devolve um File na allowlist, com nome de editada", async () => {
    const outcome = await exportAnnotated(canvasReturning({ "image/jpeg": new Blob([JPEG], { type: "image/jpeg" }) }), sourceFile("foto-1.jpg", "image/jpeg"));
    expect(outcome.ok).toBe(true);
    const file = (outcome as { file: File }).file;
    expect(file.type).toBe("image/jpeg");
    expect(EDITABLE_IMAGE_TYPES).toContain(file.type);
    expect(file.name).toBe("foto-1-editada.jpg");
  });

  it("obedece ao tipo do blob, não ao que foi pedido", async () => {
    // O spec deixa o navegador ignorar o formato e devolver PNG. Quem vai no upload
    // — e quem o servidor confere contra os magic bytes — é o tipo do blob.
    const outcome = await exportAnnotated(canvasReturning({ "image/jpeg": new Blob([PNG], { type: "image/png" }) }), sourceFile("foto.jpg", "image/jpeg"));
    const file = (outcome as { file: File }).file;
    expect(file.type).toBe("image/png");
    expect(file.name.endsWith(".png")).toBe(true);
  });

  it("cai para JPEG quando o PNG reexportado estoura o limite de envio", async () => {
    const gordo = new Blob([new Uint8Array(64)], { type: "image/png" });
    Object.defineProperty(gordo, "size", { value: IMAGE_UPLOAD_LIMIT + 1 });
    const outcome = await exportAnnotated(canvasReturning({ "image/png": gordo, "image/jpeg": new Blob([JPEG], { type: "image/jpeg" }) }), sourceFile("print.png", "image/png"));
    const file = (outcome as { file: File }).file;
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBeLessThanOrEqual(IMAGE_UPLOAD_LIMIT);
  });

  it("recusa quando nem a saída de emergência cabe, e diz o tamanho", async () => {
    const gordo = (type: string) => { const blob = new Blob([new Uint8Array(8)], { type }); Object.defineProperty(blob, "size", { value: IMAGE_UPLOAD_LIMIT + 4096 }); return blob; };
    const outcome = await exportAnnotated(canvasReturning({ "image/png": gordo("image/png"), "image/jpeg": gordo("image/jpeg") }), sourceFile("print.png", "image/png"));
    expect(outcome).toEqual({ ok: false, reason: "size", size: IMAGE_UPLOAD_LIMIT + 4096 });
  });

  it("recusa formato fora da allowlist em vez de deixar o envio devolver 415", async () => {
    const outcome = await exportAnnotated(canvasReturning({ "image/jpeg": new Blob([new Uint8Array(4)], { type: "image/gif" }) }), sourceFile("foto.jpg", "image/jpeg"));
    expect(outcome).toMatchObject({ ok: false, reason: "format" });
  });

  it("sobrevive a um canvas que não exporta", async () => {
    expect(await exportAnnotated({ toBlob: () => { throw new Error("tainted"); } }, sourceFile("foto.jpg", "image/jpeg"))).toMatchObject({ ok: false });
    expect(await exportAnnotated(canvasReturning({}), sourceFile("foto.jpg", "image/jpeg"))).toMatchObject({ ok: false });
  });
});

describe("paleta", () => {
  it("só usa cores que já existiam em styles.css", () => {
    expect(PEN_COLORS.length).toBeGreaterThanOrEqual(4);
    for (const pen of PEN_COLORS)
      expect(new RegExp(`${pen.value}\\b`).test(stylesheet), `${pen.value} é uma cor nova`).toBe(true);
  });

  it("não repete cor nem rótulo", () => {
    expect(new Set(PEN_COLORS.map((pen) => pen.value)).size).toBe(PEN_COLORS.length);
    expect(new Set(PEN_COLORS.map((pen) => pen.label)).size).toBe(PEN_COLORS.length);
  });
});
