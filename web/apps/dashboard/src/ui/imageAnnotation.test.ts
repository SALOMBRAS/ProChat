import { describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import {
  ANNOTATION_BACKDROP,
  CROP_ASPECTS,
  EDITABLE_IMAGE_TYPES,
  EDITOR_MAX_DIMENSION,
  IMAGE_UPLOAD_LIMIT,
  MIN_CROP_SIDE,
  PEN_COLORS,
  PEN_LEVELS,
  annotatedName,
  applyMatrix,
  canvasPoint,
  cropHandlePoint,
  dragCrop,
  exportAnnotated,
  exportPlan,
  fitAspect,
  fitWithin,
  frameSize,
  geometryMatrix,
  isEditableImage,
  isPristineEdit,
  normalizeCrop,
  outputSize,
  penWidth,
  pointerSamples,
  renderAnnotation,
  toBasePoint,
  tracePath,
  turnRect,
  turnRotation,
  type AnnotationContext,
  type Rect,
  type Rotation,
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
    setTransform: record("setTransform"),
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

describe("quadro, giro e tamanho de saída", () => {
  const base = { width: 1200, height: 900 };

  it("um quarto de volta troca os lados do quadro; meia volta, não", () => {
    expect(frameSize(base, 90)).toEqual({ width: 900, height: 1200 });
    expect(frameSize(base, 270)).toEqual({ width: 900, height: 1200 });
    expect(frameSize(base, 180)).toEqual({ width: 1200, height: 900 });
    expect(frameSize(base, 0)).toEqual(base);
  });

  it("sem recorte a saída é o quadro; com recorte, é o recorte", () => {
    expect(outputSize(base, { rotation: 0 })).toEqual(base);
    expect(outputSize(base, { rotation: 90 })).toEqual({ width: 900, height: 1200 });
    expect(outputSize(base, { rotation: 0, crop: { x: 10, y: 20, width: 400, height: 300 } })).toEqual({ width: 400, height: 300 });
  });

  it("recortar o quadro inteiro é não recortar", () => {
    // Sem isto, arrastar a alça até a borda e soltar guardaria um recorte que
    // obriga a reexportar uma imagem idêntica à original.
    expect(normalizeCrop({ x: 0, y: 0, width: 1200, height: 900 }, base)).toBeUndefined();
    expect(normalizeCrop({ x: 0, y: 0, width: 1199, height: 900 }, base)).toEqual({ x: 0, y: 0, width: 1199, height: 900 });
  });

  it("prende o recorte dentro do quadro e em pixel inteiro", () => {
    // `canvas.width` trunca: recorte fracionário faria a reabertura reconstruir
    // uma imagem de outro tamanho e o traço cair meio pixel ao lado.
    expect(normalizeCrop({ x: -80, y: -50, width: 400.6, height: 300.4 }, base)).toEqual({ x: 0, y: 0, width: 401, height: 300 });
    expect(normalizeCrop({ x: 5_000, y: 5_000, width: 400, height: 300 }, base)).toEqual({ x: 800, y: 600, width: 400, height: 300 });
    expect(normalizeCrop({ x: 0, y: 0, width: 9_999, height: 9_999 }, base)).toBeUndefined();
  });

  it("recorte e giro não conseguem furar o teto de resolução", () => {
    // O teto de §3.3 é aplicado uma vez, na base. Recorte só encolhe e giro só
    // troca os lados: nenhum dos dois cria pixel, então o cálculo dos 26 MB de
    // backing store continua valendo depois dos dois.
    const fitted = fitWithin(12_000, 9_000);
    expect(fitted).toEqual({ width: 2560, height: 1920, reduced: true });
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const frame = frameSize(fitted, rotation);
      const crops = [undefined, { x: 0, y: 0, ...frame }, { x: 7, y: 3, width: frame.width - 7, height: frame.height - 3 }, { x: 0, y: 0, width: 24, height: 24 }];
      for (const crop of crops) {
        const output = outputSize(fitted, { rotation, crop });
        expect(Math.max(output.width, output.height)).toBeLessThanOrEqual(EDITOR_MAX_DIMENSION);
        expect(output.width * output.height).toBeLessThanOrEqual(fitted.width * fitted.height);
      }
    }
  });
});

describe("matriz da geometria", () => {
  const base = { width: 1200, height: 900 };
  const corners = (rotation: Rotation, crop?: Rect) => {
    const matrix = geometryMatrix(base, { rotation, crop });
    return [[0, 0], [base.width, 0], [base.width, base.height], [0, base.height]].map(([x, y]) => applyMatrix(matrix, { x, y }));
  };

  it("sem giro nem recorte não transforma nada", () => {
    expect(geometryMatrix(base, { rotation: 0 })).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("um quarto de volta à direita leva o canto de cima à esquerda para o de cima à direita", () => {
    // Canvas de 900×1200 depois do giro: o canto (0,0) da base vai parar em (900,0).
    expect(corners(90)).toEqual([{ x: 900, y: 0 }, { x: 900, y: 1200 }, { x: 0, y: 1200 }, { x: 0, y: 0 }]);
    expect(corners(180)).toEqual([{ x: 1200, y: 900 }, { x: 0, y: 900 }, { x: 0, y: 0 }, { x: 1200, y: 0 }]);
    expect(corners(270)).toEqual([{ x: 0, y: 1200 }, { x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 1200 }]);
  });

  it("o recorte entra como translação, no quadro que o operador vê", () => {
    // Recorte de {100,200} no quadro girado: o ponto do quadro (100,200) tem de
    // cair na origem do canvas.
    const matrix = geometryMatrix(base, { rotation: 90, crop: { x: 100, y: 200, width: 400, height: 600 } });
    expect(applyMatrix(matrix, { x: 200, y: 800 })).toEqual({ x: 0, y: 0 });
    expect(applyMatrix(geometryMatrix(base, { rotation: 0, crop: { x: 100, y: 200, width: 400, height: 300 } }), { x: 100, y: 200 })).toEqual({ x: 0, y: 0 });
  });

  it("é rígida: gira e desloca, mas nunca escala", () => {
    // Determinante 1 é o que garante que recortar não engrossa o traço e que girar
    // não reamostra um pixel sequer.
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const [a, b, c, d] = geometryMatrix(base, { rotation, crop: { x: 30, y: 40, width: 200, height: 150 } });
      expect(Math.abs(a * d - b * c)).toBeCloseTo(1, 10);
    }
  });

  it("o ponteiro volta à base pela inversa, em qualquer giro e recorte", () => {
    // É isto que faz o traço cair no lugar certo depois de girar: o operador
    // desenha no canvas girado, e o ponto é gravado em coordenadas da base.
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const frame = frameSize(base, rotation);
      const geometry = { rotation, crop: { x: 20, y: 30, width: frame.width - 40, height: frame.height - 60 } };
      for (const point of [{ x: 0, y: 0 }, { x: 17, y: 41 }, { x: 200, y: 300 }]) {
        const backToBase = toBasePoint(point, base, geometry);
        expect(applyMatrix(geometryMatrix(base, geometry), backToBase).x).toBeCloseTo(point.x, 10);
        expect(applyMatrix(geometryMatrix(base, geometry), backToBase).y).toBeCloseTo(point.y, 10);
      }
    }
  });

  it("girado 90°, o ponto do canto do canvas é o outro canto da imagem", () => {
    expect(toBasePoint({ x: 10, y: 20 }, base, { rotation: 90 })).toEqual({ x: 20, y: 890 });
  });
});

describe("o recorte acompanha o giro", () => {
  it("gira em quartos de volta para os dois lados, e dá a volta", () => {
    expect(turnRotation(0, 1)).toBe(90);
    expect(turnRotation(270, 1)).toBe(0);
    expect(turnRotation(0, -1)).toBe(270);
    expect(turnRotation(90, -1)).toBe(0);
  });

  it("um recorte no canto de cima à esquerda vai para o de cima à direita", () => {
    // Sem isto o operador enquadra um rosto, gira, e o enquadramento cai no ombro.
    const frame = { width: 1200, height: 900 };
    expect(turnRect({ x: 0, y: 0, width: 300, height: 200 }, frame, 1)).toEqual({ x: 700, y: 0, width: 200, height: 300 });
  });

  it("girar e desgirar devolve o mesmo pedaço da foto", () => {
    const frame = { width: 1200, height: 900 };
    const rect = { x: 120, y: 60, width: 300, height: 200 };
    const turned = turnRect(rect, frame, 1);
    expect(turnRect(turned, { width: frame.height, height: frame.width }, -1)).toEqual(rect);
  });
});

describe("arrasto do recorte", () => {
  const frame = { width: 1000, height: 800 };
  const rect = { x: 100, y: 100, width: 400, height: 300 };
  const drag = (handle: Parameters<typeof cropHandlePoint>[1], to: { x: number; y: number }, aspect?: number) =>
    dragCrop({ rect, point: cropHandlePoint(rect, handle), handle }, to, frame, aspect);

  it("a alça arrasta o canto e ancora o oposto", () => {
    expect(drag("se", { x: 900, y: 700 })).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    expect(drag("nw", { x: 0, y: 0 })).toEqual({ x: 0, y: 0, width: 500, height: 400 });
    expect(drag("e", { x: 900, y: 0 })).toEqual({ x: 100, y: 100, width: 800, height: 300 });
  });

  it("não deixa fechar a seleção em nada", () => {
    // Um recorte de 2 px exporta uma imagem que ninguém consegue mais reabrir para
    // consertar.
    expect(drag("se", { x: 0, y: 0 })).toEqual({ x: 100, y: 100, width: MIN_CROP_SIDE, height: MIN_CROP_SIDE });
  });

  it("não deixa passar da borda do quadro", () => {
    expect(drag("se", { x: 5_000, y: 5_000 })).toEqual({ x: 100, y: 100, width: 900, height: 700 });
    expect(drag("nw", { x: -900, y: -900 })).toEqual({ x: 0, y: 0, width: 500, height: 400 });
  });

  it("mover mantém o tamanho e para na borda", () => {
    expect(dragCrop({ rect, point: { x: 200, y: 200 }, handle: "move" }, { x: 260, y: 150 }, frame)).toEqual({ x: 160, y: 50, width: 400, height: 300 });
    expect(dragCrop({ rect, point: { x: 200, y: 200 }, handle: "move" }, { x: 5_000, y: 5_000 }, frame)).toEqual({ x: 600, y: 500, width: 400, height: 300 });
  });

  it("a proporção travada segue a quina pelo eixo que puxou mais", () => {
    expect(drag("se", { x: 600, y: 800 }, 1)).toEqual({ x: 100, y: 100, width: 700, height: 700 });
  });

  it("a proporção travada não deixa o retângulo sair do quadro", () => {
    const cropped = drag("se", { x: 5_000, y: 5_000 }, 16 / 9);
    expect(cropped.width / cropped.height).toBeCloseTo(16 / 9, 6);
    expect(cropped.x + cropped.width).toBeLessThanOrEqual(frame.width);
    expect(cropped.y + cropped.height).toBeLessThanOrEqual(frame.height);
  });

  it("na alça de borda, o lado perpendicular segue a proporção e fica centrado", () => {
    expect(drag("e", { x: 900, y: 0 }, 2)).toEqual({ x: 100, y: 50, width: 800, height: 400 });
    expect(drag("s", { x: 0, y: 600 }, 2)).toEqual({ x: 0, y: 100, width: 1000, height: 500 });
  });

  it("a proporção de atalho encolhe a seleção em vez de pular para a imagem inteira", () => {
    expect(fitAspect({ x: 0, y: 0, width: 1000, height: 800 }, 1)).toEqual({ x: 100, y: 0, width: 800, height: 800 });
    const wide = fitAspect(rect, 16 / 9);
    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 6);
    expect(wide.width).toBeLessThanOrEqual(rect.width);
    expect(wide.height).toBeLessThanOrEqual(rect.height);
    // Mesmo centro: escolher uma proporção não muda o que está enquadrado.
    expect(wide.x + wide.width / 2).toBeCloseTo(rect.x + rect.width / 2, 6);
  });

  it("as proporções oferecidas são as três comuns, mais a livre", () => {
    expect(CROP_ASPECTS.map((option) => option.label)).toEqual(["Livre", "1:1", "4:3", "16:9"]);
    expect(CROP_ASPECTS[0].value).toBeUndefined();
    expect(CROP_ASPECTS.slice(1).map((option) => option.value)).toEqual([1, 4 / 3, 16 / 9]);
  });

  it("cada alça sabe onde está, que é de onde a seta do teclado parte", () => {
    expect(cropHandlePoint(rect, "nw")).toEqual({ x: 100, y: 100 });
    expect(cropHandlePoint(rect, "ne")).toEqual({ x: 500, y: 100 });
    expect(cropHandlePoint(rect, "e")).toEqual({ x: 500, y: 250 });
    expect(cropHandlePoint(rect, "s")).toEqual({ x: 300, y: 400 });
    expect(cropHandlePoint(rect, "move")).toEqual({ x: 300, y: 250 });
  });
});

describe("edição intocada", () => {
  it("só é intocada sem traço, sem giro e sem recorte", () => {
    // É a condição de §3.6: confirmar assim devolve o `File` que entrou. Giro e
    // recorte entram na conta porque mudam os pixels tanto quanto um traço.
    expect(isPristineEdit({ strokes: [], rotation: 0 })).toBe(true);
    expect(isPristineEdit({ strokes: [line([[1, 1]])], rotation: 0 })).toBe(false);
    expect(isPristineEdit({ strokes: [], rotation: 90 })).toBe(false);
    expect(isPristineEdit({ strokes: [], rotation: 0, crop: { x: 0, y: 0, width: 10, height: 10 } })).toBe(false);
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

  it("o fundo cobre a saída, e a geometria só entra depois dele", () => {
    const context = spyContext();
    // Girado 90°, o canvas é 900×1200 — o fundo tem de cobrir esse, não a base.
    renderAnnotation(context, {} as CanvasImageSource, [], { width: 1200, height: 900 }, { rotation: 90 });
    const transforms = context.ops.filter((op) => op.name === "setTransform");
    expect(transforms[0].args).toEqual([1, 0, 0, 1, 0, 0]);
    expect(context.ops.find((op) => op.name === "fillRect")!.args).toEqual([0, 0, 900, 1200]);
    expect(transforms[1].args).toEqual([0, 1, -1, 0, 900, 0]);
  });

  it("a imagem e os traços vão nas coordenadas da base, por dentro da geometria", () => {
    const context = spyContext();
    const base = { width: 1200, height: 900 };
    renderAnnotation(context, {} as CanvasImageSource, [line([[40, 60], [80, 90]])], base, { rotation: 0, crop: { x: 100, y: 200, width: 400, height: 300 } });
    // Recorte é translação da moldura: o traço continua onde foi feito na foto, e
    // é o canvas que passou a olhar para outro pedaço. É por isso que riscar e
    // depois recortar mantém o risco em cima do que ele marcou.
    expect(context.ops.find((op) => op.name === "setTransform" && op.args[4] !== 0)!.args).toEqual([1, 0, 0, 1, -100, -200]);
    expect(context.ops.find((op) => op.name === "drawImage")!.args).toEqual([0, 0, 1200, 900]);
    expect(context.ops.find((op) => op.name === "moveTo")!.args).toEqual([40, 60]);
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
