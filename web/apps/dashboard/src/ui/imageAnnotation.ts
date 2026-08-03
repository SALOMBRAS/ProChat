/** Marcação sobre a imagem — caneta, recorte, giro e texto — antes do envio.
 *
 *  Fica fora do componente porque é a parte que pede teste próprio: o canvas do
 *  jsdom não desenha nada, mas as decisões — teto de resolução, formato de saída,
 *  interpolação entre pontos, onde a caixa de texto pousa — são aritmética pura e
 *  ficam presas aqui.
 *
 *  A saída é um `File` que entra no mesmo `api.sendAttachment` de sempre. Não há
 *  endpoint novo: o editor troca o arquivo pendente por outro arquivo pendente.
 */

export type Point = { x: number; y: number };
export type Stroke = { color: string; width: number; points: Point[] };
export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** Um texto posto sobre a foto.
 *
 *  `x`/`y` são a âncora e `size` é o corpo da fonte, os dois em pixels da **imagem
 *  base** — o mesmo sistema dos pontos do traço. É isso que faz o texto ser tinta
 *  sobre a foto: ele acompanha o giro e é cortado pelo recorte.
 *
 *  `turn` é o giro do quadro **no momento em que o texto foi escrito**, e existe
 *  porque rabisco não tem em pé e frase tem. Sem ele, endireitar uma foto deitada e
 *  então escrever produziria letras deitadas na mesma sessão: a base não gira, quem
 *  gira é a transformação do canvas, e o texto desenhado em coordenadas da base sairia
 *  correndo para o lado. Guardando o quadro de origem, o desenho desfaz esse giro e
 *  o texto nasce em pé — e um giro posterior o leva junto, como leva a tinta.
 *
 *  O `id` existe só para a seleção saber de quem está falando entre um passo do
 *  histórico e outro; nunca é mostrado ao operador. */
export type TextItem = { id: number; text: string; x: number; y: number; size: number; color: string; turn: Rotation };

/** O que a edição guarda, em ordem de criação.
 *
 *  Antes do texto, a edição era uma lista de traços — e traço é a única ferramenta
 *  cujo estado cabe numa lista imutável de pontos, porque nunca é ajustado depois
 *  de solto. Texto pede o contrário: é criado, selecionado, movido, reescrito e
 *  apagado. Daí a lista única de objetos com identidade.
 *
 *  A lista é **uma só**, e não `strokes[]` mais `texts[]`, porque a ordem de
 *  criação é a ordem de empilhamento: riscar por cima de um texto tem de deixar o
 *  risco por cima. Duas listas paralelas obrigariam a uma camada fixa, e a camada
 *  fixa é mentira em metade dos casos. */
export type StrokeItem = { kind: "stroke" } & Stroke;
export type TextEditItem = { kind: "text" } & TextItem;
export type EditItem = StrokeItem | TextEditItem;

/** Giro em quartos de volta, no sentido horário. Não é ângulo livre de propósito:
 *  múltiplo de 90° gira o canvas sem reamostrar um único pixel, então girar e
 *  desgirar devolve a imagem idêntica. */
export type Rotation = 0 | 90 | 180 | 270;
/** A geometria da imagem: giro primeiro, recorte depois.
 *
 *  O recorte está em coordenadas do **quadro girado** — o que o operador vê —
 *  porque é lá que ele arrasta as alças e que "16:9" quer dizer 16:9. Os traços,
 *  esses, ficam em coordenadas da imagem base (§`renderAnnotation`). */
export type Geometry = { rotation: Rotation; crop?: Rect };
/** Tudo o que a edição é: os objetos desenhados, o giro e o recorte. Guardar isto —
 *  e não o resultado — é o que deixa reabrir o editor partindo sempre do arquivo
 *  original. Nenhum dos três guarda pixel: por isso a garantia de recodificação
 *  única sobrevive ao texto pelo mesmo motivo que sobreviveu ao recorte. */
export type ImageEdit = { items: readonly EditItem[]; rotation: Rotation; crop?: Rect };
export const PRISTINE_EDIT: ImageEdit = { items: [], rotation: 0 };

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

/** O texto usa a mesma paleta da caneta: são as cores que já existem no tema, e um
 *  editor que inventasse cor nova por ferramenta teria duas paletas para manter. */
export const TEXT_LEVELS = { min: 1, max: 6, default: 3 } as const;
/** Divisor da escala do corpo da fonte, na mesma ideia do divisor 260 da caneta: o
 *  tamanho é fração do lado maior do que está à vista, não um número fixo de pixels.
 *  O nível 3 cai em 5% do lado maior, que é o corpo de legenda que se lê numa foto
 *  de conversa. **É calibração a olho**, como a da caneta — se ficar grande ou
 *  pequeno demais, mexa no divisor sem cerimônia. */
export const TEXT_SIZE_DIVISOR = 60;
/** Piso em pixels da base. Abaixo disso o texto não sobrevive à redução que o
 *  WhatsApp faz na entrega. */
export const TEXT_MIN_SIZE = 12;
/** Altura da caixa do texto como múltiplo do corpo da fonte: o suficiente para
 *  cobrir ascendente e descendente. Serve à alça de seleção e ao limite que impede o
 *  texto de sair da imagem — o canvas não devolve altura de linha de graça. */
export const TEXT_LINE_RATIO = 1.28;
/** Teto de caracteres. É legenda sobre foto, não parágrafo: acima disto o texto não
 *  cabe em nenhum corpo legível. Arbitrário. */
export const TEXT_MAX_LENGTH = 120;
/** A mesma pilha de fontes do `:root` em styles.css, para o texto na foto sair com a
 *  letra do produto. O peso 700 não é enfeite: texto fino sobre foto some. */
export const TEXT_FONT_STACK = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
/** Contorno escuro por baixo do preenchimento. Sem ele, o texto branco sobre céu
 *  branco desaparece — e a paleta tem branco. É o mesmo preto translúcido com que a
 *  moldura do recorte já escurece o lado de fora. */
export const TEXT_HALO = "#000000b8";

/** Lado mínimo do recorte, em pixels do quadro. Existe para o arrasto não conseguir
 *  fechar a seleção em nada: um recorte de 2 px exporta uma imagem que o operador
 *  não consegue mais reabrir para consertar. */
export const MIN_CROP_SIDE = 24;
/** As proporções de atalho. `undefined` é a proporção livre, que é o padrão — o
 *  travamento é conforto de arrasto, não estado da edição. */
export const CROP_ASPECTS: readonly { label: string; value?: number }[] = [
  { label: "Livre" },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "16:9", value: 16 / 9 },
];

export const isEditableImage = (mime?: string | null): boolean =>
  (EDITABLE_IMAGE_TYPES as readonly string[]).includes(mime ?? "");

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** A espessura é proporcional ao lado maior da imagem, não um valor fixo em pixels
 *  de canvas: fixo, o mesmo nível sairia grosso numa imagem de 600 px e um fio de
 *  cabelo numa foto de 12 MP. O divisor põe o nível 3 em ~1,2% do lado maior, que
 *  é o peso de caneta que o WhatsApp usa. */
export const penWidth = (level: number, longestSide: number): number =>
  Math.max(2, Math.round((Math.max(longestSide, 1) * clamp(level, PEN_LEVELS.min, PEN_LEVELS.max)) / 260));

/** O corpo da fonte pela mesma regra da espessura da caneta: fração do lado maior do
 *  que está à vista, e não pixel fixo. Fixo, o nível 3 daria uma legenda enorme numa
 *  imagem de 600 px e ilegível numa foto de 12 MP. Como o lado maior é o da saída — e
 *  a saída é sempre mostrada na mesma largura —, proporcional à imagem quer dizer
 *  constante para quem olha. O valor é congelado no texto quando ele é criado. */
export const textSize = (level: number, longestSide: number): number =>
  Math.max(TEXT_MIN_SIZE, Math.round((Math.max(longestSide, 1) * clamp(level, TEXT_LEVELS.min, TEXT_LEVELS.max)) / TEXT_SIZE_DIVISOR));

/** O caminho de volta: que nível produziu este corpo. Serve para a régua mostrar o
 *  tamanho do texto que o operador acabou de selecionar, em vez de mentir o último
 *  valor que ela tinha. */
export const textLevelOf = (size: number, longestSide: number): number =>
  clamp(Math.round((size * TEXT_SIZE_DIVISOR) / Math.max(longestSide, 1)), TEXT_LEVELS.min, TEXT_LEVELS.max);

export const textFont = (size: number): string => `700 ${Math.max(1, Math.round(size))}px ${TEXT_FONT_STACK}`;

/** Reduz proporcionalmente até caber no teto. `reduced` existe para o painel poder
 *  dizer ao operador que a imagem foi reduzida, e para quanto. */
export const fitWithin = (width: number, height: number, cap = EDITOR_MAX_DIMENSION): Size & { reduced: boolean } => {
  const source = { width: Math.max(1, Math.round(width || 0)), height: Math.max(1, Math.round(height || 0)) };
  const longest = Math.max(source.width, source.height);
  if (longest <= cap) return { ...source, reduced: false };
  const ratio = cap / longest;
  return { width: Math.max(1, Math.round(source.width * ratio)), height: Math.max(1, Math.round(source.height * ratio)), reduced: true };
};

/** O quadro que o operador vê antes de recortar: a base com largura e altura
 *  trocadas quando o giro é de um quarto de volta. */
export const frameSize = (base: Size, rotation: Rotation): Size =>
  rotation === 90 || rotation === 270 ? { width: base.height, height: base.width } : { width: base.width, height: base.height };

/** O quadro inteiro como retângulo. É a seleção que o modo recorte mostra antes de
 *  o operador arrastar qualquer alça: "nada recortado" e "recortado no tamanho de
 *  tudo" são a mesma imagem. */
export const fullRect = (frame: Size): Rect => ({ x: 0, y: 0, width: frame.width, height: frame.height });

/** Prende o retângulo dentro do quadro e arredonda para pixel inteiro. O
 *  arredondamento não é cosmético: `canvas.width` trunca, então guardar um recorte
 *  fracionário faria a reabertura reconstruir uma imagem de outro tamanho. */
export const clampCrop = (crop: Rect, frame: Size): Rect => {
  const width = clamp(Math.round(crop.width || 0), 1, Math.max(1, Math.round(frame.width)));
  const height = clamp(Math.round(crop.height || 0), 1, Math.max(1, Math.round(frame.height)));
  return { x: clamp(Math.round(crop.x || 0), 0, frame.width - width), y: clamp(Math.round(crop.y || 0), 0, frame.height - height), width, height };
};

/** O mesmo que `clampCrop`, mas devolve `undefined` quando o recorte cobre o quadro
 *  inteiro: recortar tudo é não recortar, e guardar isso como recorte faria o
 *  editor reexportar uma imagem idêntica à original só para nada. */
export const normalizeCrop = (crop: Rect | undefined, frame: Size): Rect | undefined => {
  if (!crop) return undefined;
  const rect = clampCrop(crop, frame);
  return rect.x === 0 && rect.y === 0 && rect.width === frame.width && rect.height === frame.height ? undefined : rect;
};

/** O tamanho do arquivo que sai: o recorte, ou o quadro girado quando não há
 *  recorte. Recorte só encolhe e giro só troca os lados, então nunca passa da área
 *  da base — é por isso que o teto de `fitWithin` continua valendo depois dos dois. */
export const outputSize = (base: Size, geometry: Geometry): Size => {
  const frame = frameSize(base, geometry.rotation);
  const crop = normalizeCrop(geometry.crop, frame);
  return crop ? { width: crop.width, height: crop.height } : frame;
};

/** Matriz de transformação do canvas, na ordem `[a, b, c, d, e, f]` de
 *  `setTransform`: leva um ponto da imagem base ao ponto correspondente no canvas
 *  de saída. */
export type Matrix = readonly [number, number, number, number, number, number];

export const applyMatrix = (matrix: Matrix, point: Point): Point => ({
  x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
  y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
});

export const invertMatrix = (matrix: Matrix): Matrix => {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  // Giro é rígido, então o determinante é sempre 1; a guarda só evita NaN se
  // alguém passar uma matriz degenerada.
  if (!determinant) return [1, 0, 0, 1, 0, 0];
  return [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
};

/** Base → canvas. Só giro e translação: nenhuma escala, e é por isso que o recorte
 *  não engrossa o traço nem reamostra a imagem. */
export const geometryMatrix = (base: Size, geometry: Geometry): Matrix => {
  const crop = normalizeCrop(geometry.crop, frameSize(base, geometry.rotation));
  // O recorte desloca a moldura; somar zero evita que a ausência de recorte deixe
  // um `-0` na matriz, que é inofensivo no canvas e confuso em toda comparação.
  const offsetX = -(crop?.x ?? 0) + 0;
  const offsetY = -(crop?.y ?? 0) + 0;
  if (geometry.rotation === 90) return [0, 1, -1, 0, base.height + offsetX, offsetY];
  if (geometry.rotation === 180) return [-1, 0, 0, -1, base.width + offsetX, base.height + offsetY];
  if (geometry.rotation === 270) return [0, -1, 1, 0, offsetX, base.width + offsetY];
  return [1, 0, 0, 1, offsetX, offsetY];
};

/** `a` depois de `b`: o ponto passa por `b` primeiro. Compor em TypeScript, e não
 *  empilhando `rotate`/`translate` no contexto, mantém o desenho com uma chamada de
 *  `setTransform` por objeto — e mantém a transformação inteira visível ao teste, que
 *  é como as três propriedades de §4.6 continuam confiráveis. */
export const composeMatrix = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/** O giro puro, sem translação. É a parte `[a b c d]` da matriz da geometria, isolada
 *  para o texto poder desfazer o giro do quadro em que foi escrito. */
export const spinMatrix = (rotation: Rotation): Matrix =>
  rotation === 90 ? [0, 1, -1, 0, 0, 0] : rotation === 180 ? [-1, 0, 0, -1, 0, 0] : rotation === 270 ? [0, -1, 1, 0, 0, 0] : [1, 0, 0, 1, 0, 0];

/** Leva um retângulo por uma matriz de quarto de volta. Como o giro é rígido e
 *  múltiplo de 90°, o retângulo continua alinhado aos eixos e dois cantos opostos
 *  bastam para descrevê-lo. */
export const mapRect = (matrix: Matrix, rect: Rect): Rect => {
  const start = applyMatrix(matrix, { x: rect.x, y: rect.y });
  const end = applyMatrix(matrix, { x: rect.x + rect.width, y: rect.y + rect.height });
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
};

/** Canvas → base. É o que transforma o ponteiro em ponto de traço: o operador
 *  desenha sobre a imagem girada e recortada, mas o traço é gravado na base, de
 *  onde acompanha qualquer geometria posterior. */
export const toBasePoint = (point: Point, base: Size, geometry: Geometry): Point =>
  applyMatrix(invertMatrix(geometryMatrix(base, geometry)), point);

export const turnRotation = (rotation: Rotation, quarter: 1 | -1): Rotation =>
  ((((rotation + quarter * 90) % 360) + 360) % 360) as Rotation;

/** O giro que desfaz este: 90° vira 270°, e zero continua zero. Sem o `% 360`, o
 *  inverso de 0 seria 360, que nenhum ramo da matriz reconhece. */
export const oppositeRotation = (rotation: Rotation): Rotation => ((360 - rotation) % 360) as Rotation;

/** Leva o recorte para o quadro que o giro acabou de criar. Sem isto, girar moveria
 *  o recorte para outro pedaço da foto — o operador enquadra um rosto, gira, e o
 *  enquadramento cai no ombro. */
export const turnRect = (rect: Rect, frame: Size, quarter: 1 | -1): Rect =>
  quarter === 1
    ? { x: frame.height - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width }
    : { x: rect.y, y: frame.width - rect.x - rect.width, width: rect.height, height: rect.width };

/** O maior retângulo da proporção pedida que cabe dentro do atual, no mesmo centro.
 *  Escolher "1:1" sempre encolhe a seleção — nunca pula de volta para a imagem
 *  inteira, que é o que assustaria quem já enquadrou. */
export const fitAspect = (rect: Rect, aspect: number): Rect => {
  const width = Math.min(rect.width, rect.height * aspect);
  const height = width / aspect;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
};

/* ---------- O texto na base, e a caixa dele na tela ---------- */

/** Medir texto é a única coisa do editor que depende do desenho de verdade: a
 *  largura de uma frase é a soma das larguras dos glifos, e só a fonte carregada
 *  sabe quais são. O medidor entra como argumento para a aritmética continuar pura e
 *  testável sem um canvas. */
export type TextMeasure = (text: string, size: number) => number;

/** Medidor de emergência, para antes de o contexto 2D existir. Erra a largura de
 *  qualquer fonte proporcional, e é por isso que só vale para posicionar uma caixa
 *  vazia — nunca para decidir se o texto cabe. */
export const approximateTextWidth: TextMeasure = (text, size) => Math.max(1, text.length) * size * 0.52;

export const measureWith = (context: Pick<AnnotationContext, "font" | "measureText">): TextMeasure => (text, size) => {
  context.font = textFont(size);
  return context.measureText(text).width;
};

/** A caixa do texto no quadro do próprio texto, com a âncora na origem: a frase corre
 *  para a direita e desce uma linha, sempre, porque neste quadro ela está em pé.
 *  O texto vazio ainda tem caixa, senão a alça de quem acabou de criar um texto
 *  nasceria com zero pixel e ninguém conseguiria pegá-la para digitar. */
export const textBox = (item: TextItem, measure: TextMeasure): Rect => ({
  x: 0,
  y: 0,
  width: Math.max(item.size / 2, measure(item.text || " ", item.size)),
  height: Math.max(1, item.size * TEXT_LINE_RATIO),
});

/** Quadro do texto → base: leva a âncora ao lugar e desfaz o giro em que o texto foi
 *  escrito, para ele nascer em pé sobre a foto que o operador estava vendo. */
export const textBaseMatrix = (item: TextItem): Matrix =>
  composeMatrix([1, 0, 0, 1, item.x, item.y], spinMatrix(oppositeRotation(item.turn)));

/** Quadro do texto → canvas: a geometria da imagem por cima do quadro do texto. Uma
 *  matriz só, ainda rígida, ainda sem escala — a letra não engorda nem afina. */
export const textMatrix = (item: TextItem, base: Size, geometry: Geometry): Matrix =>
  composeMatrix(geometryMatrix(base, geometry), textBaseMatrix(item));

/** A pegada do texto em coordenadas da base. É contra isto que se confere se o texto
 *  cabe na imagem: a caixa troca de lados quando o texto foi escrito num quarto de
 *  volta, e usar largura e altura cruas erraria o limite justamente aí. */
export const textBaseRect = (item: TextItem, measure: TextMeasure): Rect =>
  mapRect(textBaseMatrix(item), textBox(item, measure));

/** O pedaço da base que o operador está vendo agora — a imagem inteira sem recorte, o
 *  recorte quando há um. A matriz é rígida e de quarto de volta, então o retângulo
 *  continua alinhado aos eixos e dois cantos bastam. */
export const visibleBase = (base: Size, geometry: Geometry): Rect =>
  mapRect(invertMatrix(geometryMatrix(base, geometry)), fullRect(outputSize(base, geometry)));

/** Um deslocamento da tela vira deslocamento da base. É a parte linear da inversa da
 *  geometria: sem ela, a seta para a direita moveria o texto para baixo depois de um
 *  giro de 90°, porque os eixos da base já não são os da tela. */
export const canvasDeltaToBase = (delta: Point, base: Size, geometry: Geometry): Point => {
  const inverse = invertMatrix(geometryMatrix(base, geometry));
  const origin = applyMatrix(inverse, { x: 0, y: 0 });
  const moved = applyMatrix(inverse, delta);
  return { x: moved.x - origin.x, y: moved.y - origin.y };
};

/** Prende o texto dentro do que está à vista. Não dá para arrastar uma coisa para
 *  onde não se vê, e sem isto o texto sairia pela borda da foto ou sumiria dentro da
 *  parte que o recorte joga fora. Texto mais largo que a área encosta na borda em vez
 *  de ficar preso num limite negativo.
 *
 *  O que se prende é a **pegada**, não a âncora: a âncora anda junto pelo mesmo
 *  deslocamento, senão um texto escrito de lado seria empurrado pelo canto errado. */
export const clampTextPosition = (item: TextItem, measure: TextMeasure, bounds: Rect): Point => {
  const rect = textBaseRect(item, measure);
  const x = clamp(rect.x, bounds.x, Math.max(bounds.x, bounds.x + bounds.width - rect.width));
  const y = clamp(rect.y, bounds.y, Math.max(bounds.y, bounds.y + bounds.height - rect.height));
  return { x: item.x + (x - rect.x), y: item.y + (y - rect.y) };
};

/** A caixa do texto em coordenadas do canvas, que é onde a alça de seleção pousa. A
 *  alça não tem geometria própria: é a mesma matriz do desenho, então ela cai
 *  exatamente sobre as letras em qualquer giro e recorte. */
export const textOverlayRect = (item: TextItem, measure: TextMeasure, base: Size, geometry: Geometry): Rect =>
  mapRect(textMatrix(item, base, geometry), textBox(item, measure));

/** Os dois retângulos se tocam? Serve para a alça de um texto que o recorte jogou
 *  fora não ser desenhada: fora da moldura ela vira um alvo de Tab que ninguém vê,
 *  e um Delete ali apagaria um texto invisível. */
export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Identidade derivada da própria lista, em vez de contador global ou `randomUUID`:
 *  reabrir o editor com a mesma edição reconstrói os mesmos ids, e o histórico
 *  continua falando do mesmo texto depois de desfazer. */
export const nextTextId = (items: readonly EditItem[]): number =>
  items.reduce((highest, item) => (item.kind === "text" ? Math.max(highest, item.id) : highest), 0) + 1;

export const textsOf = (items: readonly EditItem[]): TextEditItem[] => items.filter((item): item is TextEditItem => item.kind === "text");
export const textById = (items: readonly EditItem[], id?: number): TextEditItem | undefined =>
  id === undefined ? undefined : textsOf(items).find((item) => item.id === id);

export const addItem = (edit: ImageEdit, item: EditItem): ImageEdit => ({ ...edit, items: [...edit.items, item] });
/** Mexer num texto é trocar um item da lista, nunca mutá-lo: os instantâneos do
 *  histórico compartilham os objetos, e mutar um deles reescreveria o passado. */
export const updateTextItem = (edit: ImageEdit, id: number, patch: Partial<TextItem>): ImageEdit => ({
  ...edit,
  items: edit.items.map((item) => (item.kind === "text" && item.id === id ? { ...item, ...patch } : item)),
});
export const removeTextItem = (edit: ImageEdit, id: number): ImageEdit => ({
  ...edit,
  items: edit.items.filter((item) => !(item.kind === "text" && item.id === id)),
});

export type CropHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const CROP_HANDLES: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Onde a alça está agora, em coordenadas do quadro. Serve ao arrasto e ao teclado:
 *  uma seta é um arrasto de um pixel a partir daqui. */
export const cropHandlePoint = (rect: Rect, handle: CropHandle): Point => ({
  x: handle === "move" || handle === "n" || handle === "s" ? rect.x + rect.width / 2 : handle.includes("w") ? rect.x : rect.x + rect.width,
  y: handle === "move" || handle === "e" || handle === "w" ? rect.y + rect.height / 2 : handle.includes("n") ? rect.y : rect.y + rect.height,
});

const lockAspect = (rect: Rect, west: boolean, east: boolean, north: boolean, south: boolean, frame: Size, aspect: number, min: number): Rect => {
  // A borda oposta à alça é a âncora: ela não se mexe, e o retângulo cresce a
  // partir dela até onde o quadro permite.
  const anchorX = west ? rect.x + rect.width : rect.x;
  const anchorY = north ? rect.y + rect.height : rect.y;
  const roomX = west || east ? (west ? anchorX : frame.width - anchorX) : frame.width;
  const roomY = north || south ? (north ? anchorY : frame.height - anchorY) : frame.height;
  const place = (width: number, height: number): Rect => ({
    x: west || east ? (west ? anchorX - width : anchorX) : clamp(rect.x + rect.width / 2 - width / 2, 0, frame.width - width),
    y: north || south ? (north ? anchorY - height : anchorY) : clamp(rect.y + rect.height / 2 - height / 2, 0, frame.height - height),
    width, height,
  });
  // Quina cresce pelo eixo que o ponteiro puxou mais — travar sempre na largura
  // faria o arrasto vertical de uma quina parecer que não responde. Alça de borda
  // é dirigida pelo lado que ela move, e o outro segue a proporção.
  const wanted = west || east ? (north || south ? Math.max(rect.width, rect.height * aspect) : rect.width) : rect.height * aspect;
  const widest = Math.min(roomX, roomY * aspect);
  const narrowest = Math.min(Math.max(min, min * aspect), widest);
  const width = Math.max(Math.min(wanted, widest), narrowest);
  return place(width, width / aspect);
};

/** Move ou redimensiona o recorte a partir de onde o arrasto começou. Puro de
 *  propósito: a alça é um `<button>` que só converte o ponteiro em coordenada do
 *  quadro e chama isto, então a aritmética inteira cabe num teste sem layout. */
export const dragCrop = (
  start: { rect: Rect; point: Point; handle: CropHandle },
  point: Point,
  frame: Size,
  aspect?: number,
): Rect => {
  const min = Math.min(MIN_CROP_SIDE, frame.width, frame.height);
  if (start.handle === "move")
    return {
      x: clamp(start.rect.x + (point.x - start.point.x), 0, frame.width - start.rect.width),
      y: clamp(start.rect.y + (point.y - start.point.y), 0, frame.height - start.rect.height),
      width: start.rect.width,
      height: start.rect.height,
    };
  const west = start.handle.includes("w");
  const east = start.handle.includes("e");
  const north = start.handle.includes("n");
  const south = start.handle.includes("s");
  let left = start.rect.x;
  let top = start.rect.y;
  let right = start.rect.x + start.rect.width;
  let bottom = start.rect.y + start.rect.height;
  if (west) left = clamp(point.x, 0, right - min);
  if (east) right = clamp(point.x, left + min, frame.width);
  if (north) top = clamp(point.y, 0, bottom - min);
  if (south) bottom = clamp(point.y, top + min, frame.height);
  const rect = { x: left, y: top, width: right - left, height: bottom - top };
  return aspect ? lockAspect(rect, west, east, north, south, frame, aspect, min) : rect;
};

/** O item marca a imagem? Traço sem ponto e texto sem conteúdo não desenham nada, e
 *  contá-los como marcação faria uma imagem intocada ser reexportada por nada. */
export const marksImage = (item: EditItem): boolean => (item.kind === "stroke" ? item.points.length > 0 : item.text.trim().length > 0);

/** A edição não mexeu em nada. Confirmar assim devolve o `File` que entrou, sem
 *  recodificar — a regra vale para o giro, o recorte e o texto pelo mesmo motivo que
 *  valia para o traço.
 *
 *  Um texto criado e deixado vazio não conta: a caixa existe na lista para o operador
 *  poder voltar e digitar, mas não põe um pixel na imagem. Fazer a exceção aqui, e não
 *  numa limpeza chamada em cinco lugares, é o que impede que um deles seja esquecido. */
export const isPristineEdit = (edit: ImageEdit): boolean => edit.rotation === 0 && !edit.crop && !edit.items.some(marksImage);

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
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: CanvasImageSource, x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
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

/** Escreve um texto nas coordenadas da base.
 *
 *  O contorno escuro vem antes do preenchimento, e não é enfeite: a paleta tem
 *  branco, e branco sobre céu branco não existe. Escrever o contorno depois cobriria
 *  o miolo da letra.
 *
 *  A âncora é o canto superior esquerdo (`textBaseline = "top"`) porque é o canto que
 *  a caixa de seleção usa; com a linha de base como âncora, mover a alça um pixel
 *  moveria o texto um pixel e a caixa outro.
 *
 *  Escreve na origem porque quem posiciona é a matriz: o contexto já chega no quadro
 *  do próprio texto. */
export const drawText = (context: AnnotationContext, item: TextItem): void => {
  if (!item.text) return;
  context.font = textFont(item.size);
  context.textAlign = "left";
  context.textBaseline = "top";
  context.lineJoin = "round";
  context.lineWidth = Math.max(2, Math.round(item.size / 8));
  context.strokeStyle = TEXT_HALO;
  context.strokeText(item.text, 0, 0);
  context.fillStyle = item.color;
  context.fillText(item.text, 0, 0);
};

/** Repinta tudo: base branca, imagem, e os objetos na ordem em que foram criados.
 *  Desfazer e refazer são fatias do histórico de edições — nada de guardar
 *  `ImageData` por passo, que num canvas de 5 MP custaria 20 MB por nível.
 *
 *  A ordem da lista é a ordem de empilhamento: um traço feito depois de um texto fica
 *  por cima dele, que é o que o operador vê acontecer enquanto desenha.
 *
 *  A imagem, os traços e os textos são desenhados nas coordenadas da **base**, e a
 *  geometria entra como transformação do canvas. É essa ordem que responde à pergunta
 *  "a marcação acompanha o recorte?": acompanha, porque a marcação é tinta sobre a
 *  foto e o recorte é a moldura por onde se olha para ela. Marcar e depois recortar
 *  corta o que ficou de fora, exatamente como cortaria a foto. */
export const renderAnnotation = (
  context: AnnotationContext,
  image: CanvasImageSource | undefined,
  items: readonly EditItem[],
  base: Size,
  geometry: Geometry = { rotation: 0 },
): void => {
  const output = outputSize(base, geometry);
  context.save();
  // O fundo é pintado antes da geometria entrar, em coordenadas do canvas: ele
  // cobre a saída inteira, não a base.
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = ANNOTATION_BACKDROP;
  context.fillRect(0, 0, output.width, output.height);
  const matrix = geometryMatrix(base, geometry);
  context.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
  if (image) context.drawImage(image, 0, 0, base.width, base.height);
  for (const item of items) {
    if (item.kind === "stroke") { tracePath(context, item); continue; }
    // O texto tem quadro próprio — a âncora e o giro em que foi escrito. Depois de
    // desenhá-lo, a matriz da geometria volta, senão o traço seguinte herdaria o
    // quadro do texto anterior.
    const own = textMatrix(item, base, geometry);
    context.setTransform(own[0], own[1], own[2], own[3], own[4], own[5]);
    drawText(context, item);
    context.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
  }
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
