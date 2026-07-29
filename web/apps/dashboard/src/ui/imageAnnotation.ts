/** Marcação a caneta sobre a imagem, antes do envio.
 *
 *  Fica fora do componente porque é a parte que pede teste próprio: o canvas do
 *  jsdom não desenha nada, mas as decisões — teto de resolução, formato de saída,
 *  interpolação entre pontos — são aritmética pura e ficam presas aqui.
 *
 *  A saída é um `File` que entra no mesmo `api.sendAttachment` de sempre. Não há
 *  endpoint novo: o editor troca o arquivo pendente por outro arquivo pendente.
 */

export type Point = { x: number; y: number };
export type Stroke = { color: string; width: number; points: Point[] };
export type Size = { width: number; height: number };

/** Espelho da allowlist de imagem do servidor (`policy` em
 *  attachment-outbox.service.ts). Reexportar para fora dela devolve 415 no envio,
 *  e o servidor ainda confere os magic bytes — declarar `image/png` e entregar
 *  bytes de JPEG é recusado com 400. */
export const EDITABLE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** Mesmo teto de `policy.image.max`. O que importa aqui é o tamanho *depois* da
 *  edição: reexportar não devolve necessariamente um arquivo menor que o
 *  original, e quem passa pelo 413 é o blob novo. */
export const IMAGE_UPLOAD_LIMIT = 15 * 1024 * 1024;
/** Teto de resolução da edição: 2560 px no lado maior.
 *
 *  Um canvas guarda 4 bytes por pixel e o navegador ainda faz uma cópia para
 *  exportar. A 2560 px o pior caso (2560×2560) são ~26 MB de backing store; a foto
 *  crua de um celular de 108 MP (12000×9000) pediria 432 MB, e o Safari do iPhone
 *  simplesmente devolve canvas em branco acima de ~16,7 MP. O corte também é
 *  generoso para o destino: o próprio WhatsApp reentrega foto em torno de 1600 px,
 *  então 2560 px não tira nada que o contato fosse ver. */
export const EDITOR_MAX_DIMENSION = 2560;
/** JPEG não tem canal alfa: sem base pintada, área transparente vira preta no
 *  reencode e, na bolha escura da conversa, parece um buraco. Branco é o que o
 *  operador espera de uma foto. */
export const ANNOTATION_BACKDROP = "#fff";
/** Mesma qualidade que a captura da câmera já usa. Acima de 0.92 o arquivo cresce
 *  sem ganho visível; abaixo, o traço fino da caneta ganha franja. */
export const JPEG_QUALITY = 0.92;

/** Só cores que já existem em styles.css — o editor não inventa paleta. As seis
 *  cobrem foto clara e escura: nenhuma some sobre céu branco nem sobre sombra. */
export const PEN_COLORS: readonly { value: string; label: string }[] = [
  { value: "#fb7185", label: "Rosa" },
  { value: "#fbbf24", label: "Âmbar" },
  { value: "#25d366", label: "Verde" },
  { value: "#59adff", label: "Azul" },
  { value: "#c084fc", label: "Roxo" },
  { value: "#fff", label: "Branco" },
];
export const PEN_LEVELS = { min: 1, max: 6, default: 3 } as const;

export const isEditableImage = (mime?: string | null): boolean =>
  (EDITABLE_IMAGE_TYPES as readonly string[]).includes(mime ?? "");

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** A espessura é proporcional ao lado maior da imagem, não um valor fixo em pixels
 *  de canvas: fixo, o mesmo nível sairia grosso numa imagem de 600 px e um fio de
 *  cabelo numa foto de 12 MP. O divisor põe o nível 3 em ~1,2% do lado maior, que
 *  é o peso de caneta que o WhatsApp usa. */
export const penWidth = (level: number, longestSide: number): number =>
  Math.max(2, Math.round((Math.max(longestSide, 1) * clamp(level, PEN_LEVELS.min, PEN_LEVELS.max)) / 260));

/** Reduz proporcionalmente até caber no teto. `reduced` existe para o painel poder
 *  dizer ao operador que a imagem foi reduzida, e para quanto. */
export const fitWithin = (width: number, height: number, cap = EDITOR_MAX_DIMENSION): Size & { reduced: boolean } => {
  const source = { width: Math.max(1, Math.round(width || 0)), height: Math.max(1, Math.round(height || 0)) };
  const longest = Math.max(source.width, source.height);
  if (longest <= cap) return { ...source, reduced: false };
  const ratio = cap / longest;
  return { width: Math.max(1, Math.round(source.width * ratio)), height: Math.max(1, Math.round(source.height * ratio)), reduced: true };
};

/** O ponteiro dá coordenadas de viewport; o canvas desenha nas suas próprias, que
 *  são as da imagem reduzida. Sem a conversão o traço sai deslocado e com a
 *  espessura errada em qualquer tela que não seja 1:1. */
export const canvasPoint = (canvas: HTMLCanvasElement, clientX: number, clientY: number): Point => {
  const rect = canvas.getBoundingClientRect();
  // Layout ainda não medido (e o jsdom, que devolve tudo zero) daria divisão por
  // zero: aí o ponto vira NaN e o traço inteiro some.
  const scaleX = rect.width ? canvas.width / rect.width : 1;
  const scaleY = rect.height ? canvas.height / rect.height : 1;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
};

/** Em movimento rápido o navegador entrega um `pointermove` por quadro e guarda o
 *  resto; `getCoalescedEvents` devolve os pontos que ficaram para trás. Sem eles o
 *  traço de um gesto rápido vira uma sequência de retas longas. */
export const pointerSamples = (event: { clientX: number; clientY: number; nativeEvent?: unknown }): { clientX: number; clientY: number }[] => {
  const native = event.nativeEvent as { getCoalescedEvents?: () => { clientX: number; clientY: number }[] } | undefined;
  const coalesced = native?.getCoalescedEvents?.();
  return coalesced?.length ? coalesced : [{ clientX: event.clientX, clientY: event.clientY }];
};

/** O subconjunto do contexto 2D que a marcação usa. Um
 *  `CanvasRenderingContext2D` satisfaz este tipo; o teste satisfaz com um espião,
 *  que é o único jeito de conferir a interpolação sem um canvas de verdade. */
export type AnnotationContext = {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(controlX: number, controlY: number, x: number, y: number): void;
  stroke(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: CanvasImageSource, x: number, y: number, width: number, height: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
};

/** Desenha um traço passando *suave* pelos pontos captados.
 *
 *  Ligar ponto a ponto com reta deixa o traço quebrado justamente onde o operador
 *  move a mão rápido, que é quando os pontos ficam distantes. A saída é uma
 *  sequência de quadráticas em que o ponto captado é o controle e o destino é o
 *  meio do segmento seguinte: a curva passa por dentro da quina em vez de virar
 *  em bico, e dois pontos distantes viram um arco contínuo. */
export const tracePath = (context: AnnotationContext, stroke: Stroke): void => {
  const points = stroke.points;
  if (!points.length) return;
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  const first = points[0];
  context.moveTo(first.x, first.y);
  if (points.length === 1) {
    // Toque sem arrastar: sem este segmento de comprimento zero o `lineCap`
    // redondo não tem o que arredondar e o ponto não marca nada.
    context.lineTo(first.x, first.y);
    context.stroke();
    return;
  }
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }
  const last = points[points.length - 1];
  context.lineTo(last.x, last.y);
  context.stroke();
};

/** Repinta tudo: base branca, imagem, traços na ordem. Desfazer e refazer são
 *  fatias desta lista — nada de guardar `ImageData` por passo, que num canvas de
 *  5 MP custaria 20 MB por nível de histórico. */
export const renderAnnotation = (context: AnnotationContext, image: CanvasImageSource | undefined, strokes: readonly Stroke[], size: Size): void => {
  context.save();
  context.fillStyle = ANNOTATION_BACKDROP;
  context.fillRect(0, 0, size.width, size.height);
  if (image) context.drawImage(image, 0, 0, size.width, size.height);
  for (const stroke of strokes) tracePath(context, stroke);
  context.restore();
};

/** Formato de saída, em ordem de tentativa.
 *
 *  PNG entra e PNG sai: PNG costuma ser print de tela, onde o JPEG põe franja em
 *  volta de cada letra. JPEG e WebP saem como JPEG — o JPEG já é o formato de
 *  origem no primeiro caso, e no segundo evita depender do encoder WebP do canvas,
 *  que o Safari só ganhou na versão 16.4 e que o spec manda cair em PNG quando
 *  falta (um PNG de foto passaria fácil dos 15 MB).
 *
 *  A segunda tentativa do PNG é a saída para quando o PNG reexportado estoura o
 *  limite de envio, o que acontece com PNG de foto. */
export const exportPlan = (sourceType: string): { type: string; quality?: number }[] =>
  sourceType === "image/png"
    ? [{ type: "image/png" }, { type: "image/jpeg", quality: JPEG_QUALITY }]
    : [{ type: "image/jpeg", quality: JPEG_QUALITY }];

const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
/** Extensão coerente com o mime real: PNG que virou JPEG tem de deixar de se
 *  chamar `.png`. O servidor valida pelo mime e pelos magic bytes, mas o nome é o
 *  que o contato vê ao baixar. */
export const annotatedName = (name: string, mime: string): string => {
  const base = name.replace(/\.[^./\\]+$/, "").trim() || "imagem";
  return `${base.slice(0, 120)}-editada.${EXTENSION[mime] ?? "jpg"}`;
};

export type ExportOutcome =
  | { ok: true; file: File }
  | { ok: false; reason: "size" | "format" | "empty"; size: number };

export type BlobCanvas = { toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void };

const toBlob = (canvas: BlobCanvas, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => {
    try { canvas.toBlob(resolve, type, quality); } catch { resolve(null); }
  });

/** Converte o canvas marcado em `File`, conferindo o que o servidor vai conferir.
 *
 *  O EXIF do original se perde aqui, e isso é desejável: junto com ele vão as
 *  coordenadas de GPS e o número de série do aparelho, que ninguém quer mandar
 *  para um contato. A orientação não se perde — o canvas recebe a imagem por
 *  `HTMLImageElement`, que já aplica a orientação do EXIF ao decodificar, então
 *  ela sai gravada nos pixels. */
export const exportAnnotated = async (canvas: BlobCanvas, source: File): Promise<ExportOutcome> => {
  let last: ExportOutcome = { ok: false, reason: "empty", size: 0 };
  for (const attempt of exportPlan(source.type)) {
    const blob = await toBlob(canvas, attempt.type, attempt.quality);
    if (!blob || !blob.size) continue;
    // Quem manda é o tipo do blob, não o que foi pedido: o spec deixa o navegador
    // ignorar o formato e devolver PNG, e é o tipo do blob que sobe no upload.
    const type = blob.type || attempt.type;
    if (!isEditableImage(type)) { last = { ok: false, reason: "format", size: blob.size }; continue; }
    if (blob.size > IMAGE_UPLOAD_LIMIT) { last = { ok: false, reason: "size", size: blob.size }; continue; }
    return { ok: true, file: new File([blob], annotatedName(source.name, type), { type }) };
  }
  return last;
};
