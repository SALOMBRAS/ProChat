import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  CROP_ASPECTS,
  CROP_HANDLES,
  EDITOR_MAX_DIMENSION,
  IMAGE_UPLOAD_LIMIT,
  PEN_COLORS,
  PEN_LEVELS,
  PRISTINE_EDIT,
  TEXT_LEVELS,
  TEXT_MAX_LENGTH,
  addItem,
  approximateTextWidth,
  canvasDeltaToBase,
  canvasPoint,
  clampTextPosition,
  cropHandlePoint,
  dragCrop,
  exportAnnotated,
  fitAspect,
  fitWithin,
  frameSize,
  fullRect,
  isPristineEdit,
  marksImage,
  measureWith,
  nextTextId,
  normalizeCrop,
  outputSize,
  penWidth,
  pointerSamples,
  rectsOverlap,
  removeTextItem,
  renderAnnotation,
  textBox,
  textById,
  textLevelOf,
  textOverlayRect,
  textSize,
  textsOf,
  toBasePoint,
  turnRect,
  turnRotation,
  updateTextItem,
  visibleBase,
  type AnnotationContext,
  type CropHandle,
  type ExportOutcome,
  type Geometry,
  type ImageEdit,
  type Point,
  type Rect,
  type Size,
  type Stroke,
  type TextItem,
  type TextMeasure,
} from "./imageAnnotation.js";

/** Editor de imagem entre a escolha do anexo e o envio.
 *
 *  Serve os dois caminhos de entrada porque não conhece nenhum dos dois: recebe o
 *  `File` que já está pendente no composer — venha ele da câmera ou do seletor de
 *  arquivos — e devolve outro `File`, que segue pelo mesmo `api.sendAttachment`.
 *
 *  `file` é sempre o arquivo **como foi escolhido**, nunca uma exportação anterior:
 *  reeditar a partir do próprio resultado empilharia perda de qualidade a cada
 *  rodada. A edição já aplicada volta por `initialEdit` — traços, giro e recorte
 *  juntos —, então reabrir o editor continua de onde parou e ainda recodifica uma
 *  vez só.
 *
 *  Traço, giro, recorte e texto cabem no mesmo modelo porque nenhum dos quatro guarda
 *  pixels: o traço é uma lista de pontos na base, o giro é um número, o recorte é um
 *  retângulo e o texto é uma frase com posição e corpo, também na base. Repintar é
 *  aplicar a geometria como transformação do canvas e desenhar a base por dentro dela.
 */
type Mode = "pen" | "crop" | "text";

const HANDLE_LABEL: Record<CropHandle, string> = {
  move: "Mover o recorte",
  nw: "Canto superior esquerdo do recorte",
  n: "Borda de cima do recorte",
  ne: "Canto superior direito do recorte",
  e: "Borda direita do recorte",
  se: "Canto inferior direito do recorte",
  s: "Borda de baixo do recorte",
  sw: "Canto inferior esquerdo do recorte",
  w: "Borda esquerda do recorte",
};
const ARROW_STEP: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};
/** No modo recorte o canvas mostra o quadro inteiro: a seleção é uma moldura por
 *  cima, não um corte já aplicado. Só ao concluir — ou ao voltar para a caneta ou o
 *  texto — o recorte entra na imagem.
 *
 *  O texto vê a mesma geometria que a caneta porque escreve sobre o que vai ser
 *  enviado: colocar uma legenda no pedaço que o recorte joga fora seria trabalho
 *  perdido sem aviso. */
const geometryOf = (edit: ImageEdit, mode: Mode): Geometry =>
  mode === "crop" ? { rotation: edit.rotation } : { rotation: edit.rotation, crop: edit.crop };

/** O histórico de uma reabertura é reconstruído a partir da edição que voltou:
 *  primeiro a geometria, depois um passo por objeto — traço ou texto, na ordem em
 *  que foram criados.
 *
 *  A ordem real das ações da passagem anterior não foi guardada — e não precisa
 *  ser, porque qualquer caminho até esta edição termina na mesma imagem. O que
 *  importa é que desfazer continue descascando o trabalho anterior um passo por
 *  vez, como fazia quando o histórico era só a lista de traços. */
const seedHistory = (edit: ImageEdit): ImageEdit[] => {
  const geometry: ImageEdit = { items: [], rotation: edit.rotation, crop: edit.crop };
  const entries: ImageEdit[] = [PRISTINE_EDIT];
  if (edit.rotation !== 0 || edit.crop) entries.push(geometry);
  // Caixa de texto vazia não volta: ela não põe pixel nenhum na imagem, e dar um
  // passo a ela faria o desfazer da reabertura não mudar nada na tela. Trabalho é o
  // que se vê.
  const marks = edit.items.filter(marksImage);
  for (let index = 1; index <= marks.length; index += 1) entries.push({ ...geometry, items: marks.slice(0, index) });
  return entries;
};

export function ImageAnnotator({ file, initialEdit = PRISTINE_EDIT, onCancel, onConfirm }: {
  file: File;
  initialEdit?: ImageEdit;
  onCancel: () => void;
  onConfirm: (edited: File, edit: ImageEdit) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<CanvasImageSource>();
  /** O contexto que a última repintura usou. Guardado porque medir texto precisa
   *  dele fora do desenho — a alça de seleção tem de saber a largura da frase — e
   *  pedir um contexto novo a cada medida desperdiça o que o canvas já tem. */
  const contextRef = useRef<AnnotationContext>();
  /** A imagem já reduzida ao teto de `fitWithin`. Recorte e giro trabalham sobre
   *  ela, nunca sobre os pixels crus: o teto é aplicado uma vez só. */
  const baseRef = useRef<Size>({ width: 0, height: 0 });
  const liveRef = useRef<{ pointerId: number; stroke: Stroke }>();
  // Os manipuladores de ponteiro leem a edição durante o arrasto, quando o estado
  // do React ainda não repassou: a referência é a edição corrente.
  const seed = useRef(seedHistory(initialEdit));
  const editRef = useRef<ImageEdit>(seed.current[seed.current.length - 1]);
  const modeRef = useRef<Mode>("pen");
  const liveCropRef = useRef<Rect>();
  const liveTextRef = useRef<{ id: number; x: number; y: number }>();
  const textFieldRef = useRef<HTMLInputElement>(null);
  /** A chave do último passo empilhado. Digitar uma palavra são oito teclas e um
   *  passo de desfazer: passos com a mesma chave substituem o topo em vez de
   *  empilhar. */
  const groupRef = useRef<string>();
  /** A seleção corrente, lida durante o arrasto e o teclado, quando o estado do React
   *  ainda não repassou — e é ela que diz se a chave do agrupamento continua valendo. */
  const selectedRef = useRef<number>();

  /** Desfazer e refazer cobrem os três: o histórico guarda a edição inteira por
   *  passo, não uma pilha de traços. Cada instantâneo compartilha os objetos de
   *  traço dos anteriores, então o custo é de ponteiros — não dos 20 MB por nível
   *  que um `ImageData` custaria. */
  const [history, setHistory] = useState<{ entries: ImageEdit[]; index: number }>(() => ({ entries: seed.current, index: seed.current.length - 1 }));
  const [base, setBase] = useState<Size>({ width: 0, height: 0 });
  const [mode, setModeState] = useState<Mode>("pen");
  const [aspect, setAspect] = useState<number>();
  const [liveCrop, setLiveCropState] = useState<Rect>();
  const [drag, setDrag] = useState<{ handle: CropHandle; pointerId: number; rect: Rect; point: Point }>();
  const [liveText, setLiveTextState] = useState<{ id: number; x: number; y: number }>();
  const [textDrag, setTextDrag] = useState<{ id: number; pointerId: number; origin: Point; point: Point }>();
  const [selectedText, setSelectedText] = useState<number>();
  const [color, setColor] = useState(PEN_COLORS[0].value);
  const [level, setLevel] = useState<number>(PEN_LEVELS.default);
  const [textColor, setTextColor] = useState(PEN_COLORS[0].value);
  const [textLevel, setTextLevel] = useState<number>(TEXT_LEVELS.default);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const committed = history.entries[history.index];
  /** A edição como ela está na tela: o texto sendo arrastado ainda não entrou no
   *  histórico, mas já tem de aparecer sob o dedo. */
  const edit = liveText ? updateTextItem(committed, liveText.id, { x: liveText.x, y: liveText.y }) : committed;
  const frame = frameSize(base, committed.rotation);
  /** O que o operador vê como seleção: o arrasto em curso, o recorte já aplicado,
   *  ou o quadro inteiro quando ainda não recortou. */
  const selection = liveCrop ?? committed.crop ?? fullRect(frame);
  const output = outputSize(base, geometryOf(edit, mode));

  const paint = useCallback((next: ImageEdit, forMode: Mode, live?: Stroke) => {
    const canvas = canvasRef.current;
    const size = baseRef.current;
    if (!canvas || !size.width || !size.height) return;
    const geometry = geometryOf(next, forMode);
    const fitted = outputSize(size, geometry);
    // Girar e recortar mudam o tamanho do canvas, e mexer em `width`/`height`
    // zera o contexto: por isso a repintura vem logo atrás, sempre completa.
    if (canvas.width !== fitted.width) canvas.width = fitted.width;
    if (canvas.height !== fitted.height) canvas.height = fitted.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    contextRef.current = context;
    renderAnnotation(context, imageRef.current, live ? [...next.items, { kind: "stroke", ...live }] : next.items, size, geometry);
  }, []);
  /** Mede pelo contexto que já desenhou, e só cai na aproximação antes da primeira
   *  repintura — quando a única caixa que existe é a de um texto vazio. */
  const measure = useCallback<TextMeasure>((text, size) =>
    (contextRef.current ? measureWith(contextRef.current) : approximateTextWidth)(text, size), []);
  const setLive = useCallback((rect?: Rect) => { liveCropRef.current = rect; setLiveCropState(rect); }, []);
  const setLiveText = useCallback((moved?: { id: number; x: number; y: number }) => { liveTextRef.current = moved; setLiveTextState(moved); }, []);
  /** Empilha um passo — ou substitui o topo, quando `group` repete a chave do passo
   *  anterior. É o que faz uma palavra digitada ser um Desfazer e não oito, sem que o
   *  histórico precise saber o que é digitar. */
  const commit = useCallback((next: ImageEdit, group?: string) => {
    const merge = Boolean(group) && group === groupRef.current;
    groupRef.current = group;
    editRef.current = next;
    setHistory((current) => ({
      entries: [...current.entries.slice(0, merge ? current.index : current.index + 1), next],
      index: merge ? current.index : current.index + 1,
    }));
  }, []);
  const commitCrop = useCallback((rect: Rect) => {
    const bounds = frameSize(baseRef.current, editRef.current.rotation);
    commit({ ...editRef.current, crop: normalizeCrop(rect, bounds) });
  }, [commit]);

  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const fitted = fitWithin(image.naturalWidth || image.width, image.naturalHeight || image.height);
      imageRef.current = image;
      baseRef.current = { width: fitted.width, height: fitted.height };
      setNotice(fitted.reduced ? `Imagem reduzida para ${fitted.width}×${fitted.height} px na edição: o teto é ${EDITOR_MAX_DIMENSION} px no lado maior.` : "");
      setBase({ width: fitted.width, height: fitted.height });
      setReady(true);
    };
    image.onerror = () => { if (!cancelled) setError("Não foi possível abrir esta imagem para edição."); };
    image.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
      imageRef.current = undefined;
      // Zerar as dimensões devolve o backing store do canvas: numa foto grande são
      // dezenas de MB que o coletor demoraria a recolher sozinho.
      const canvas = canvasRef.current;
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    };
  }, [file]);
  // Desfazer, refazer, descartar, girar e recortar mudam a edição inteira:
  // repintar do zero é o que faz o resultado aparecer na tela junto.
  useEffect(() => { paint(edit, mode); }, [base, edit, mode, paint]);
  // O arrasto da alça corre na janela, não na alça: o ponteiro sai dos 16 px dela
  // no primeiro milímetro, e `setPointerCapture` é conforto que nem todo navegador
  // concede.
  useEffect(() => {
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = frameSize(baseRef.current, editRef.current.rotation);
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      setLive(dragCrop(drag, canvasPoint(canvas, event.clientX, event.clientY), bounds, aspect));
    };
    const finish = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const rect = liveCropRef.current;
      setDrag(undefined);
      setLive(undefined);
      if (rect) commitCrop(rect);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [drag, aspect, commitCrop, setLive]);

  /** O arrasto do texto corre na janela pelo mesmo motivo que o da alça do recorte: o
   *  ponteiro sai da caixa no primeiro milímetro. O deslocamento é medido em pixels do
   *  canvas e convertido para a base — sem isso, arrastar para a direita numa foto
   *  girada moveria o texto para baixo. */
  useEffect(() => {
    if (!textDrag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const geometry = geometryOf(editRef.current, "text");
    const bounds = visibleBase(baseRef.current, geometry);
    const item = textById(editRef.current.items, textDrag.id);
    if (!item) return;
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== textDrag.pointerId) return;
      const now = canvasPoint(canvas, event.clientX, event.clientY);
      const delta = canvasDeltaToBase({ x: now.x - textDrag.point.x, y: now.y - textDrag.point.y }, baseRef.current, geometry);
      const moved = clampTextPosition({ ...item, x: textDrag.origin.x + delta.x, y: textDrag.origin.y + delta.y }, measure, bounds);
      setLiveText({ id: textDrag.id, ...moved });
    };
    const finish = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== textDrag.pointerId) return;
      const moved = liveTextRef.current;
      setTextDrag(undefined);
      setLiveText(undefined);
      // Um arrasto é um passo, como o do recorte: chave nenhuma, para não se fundir
      // com o que veio antes.
      if (moved) commit(updateTextItem(editRef.current, moved.id, { x: moved.x, y: moved.y }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [textDrag, commit, measure, setLiveText]);

  const setMode = (next: Mode) => {
    modeRef.current = next;
    setLive(undefined);
    setLiveText(undefined);
    // Sair do texto solta a seleção: a alça só existe no modo texto, e uma seleção
    // invisível faria a régua de tamanho mexer num texto que ninguém está vendo.
    if (next !== "text") chooseText(undefined);
    setModeState(next);
  };

  /** Ponteiro → ponto de traço, nas coordenadas da base. Passar pela geometria é o
   *  que faz o traço cair no lugar certo depois de girar ou recortar. */
  const strokePoint = (canvas: HTMLCanvasElement, clientX: number, clientY: number): Point =>
    toBasePoint(canvasPoint(canvas, clientX, clientY), baseRef.current, geometryOf(editRef.current, "pen"));

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    // `button > 0` é botão do meio ou direito do mouse; toque e caneta chegam com 0.
    if (!canvas || !ready || busy || event.button > 0) return;
    // Tocar a imagem no modo texto põe uma caixa ali e abre o campo: é o gesto que o
    // operador já espera de qualquer editor de foto.
    if (modeRef.current === "text") { event.preventDefault(); insertText(canvasPoint(canvas, event.clientX, event.clientY), "left"); return; }
    if (modeRef.current !== "pen") return;
    event.preventDefault();
    capturePointer(canvas, event.pointerId, true);
    const fitted = outputSize(baseRef.current, geometryOf(editRef.current, "pen"));
    // A espessura é medida no que está à vista: com a imagem recortada, o operador
    // está enxergando de perto, e a caneta tem de continuar do mesmo tamanho para
    // ele. O traço fica mais fino em pixels da base — que é o que acontece com
    // tinta de verdade quando se aproxima a lupa.
    const longest = Math.max(fitted.width, fitted.height);
    liveRef.current = { pointerId: event.pointerId, stroke: { color, width: penWidth(level, longest), points: [strokePoint(canvas, event.clientX, event.clientY)] } };
    paint(editRef.current, "pen", liveRef.current.stroke);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    const canvas = canvasRef.current;
    if (!live || !canvas || live.pointerId !== event.pointerId) return;
    event.preventDefault();
    for (const sample of pointerSamples(event)) live.stroke.points.push(strokePoint(canvas, sample.clientX, sample.clientY));
    paint(editRef.current, "pen", live.stroke);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    if (!live || live.pointerId !== event.pointerId) return;
    liveRef.current = undefined;
    if (canvasRef.current) capturePointer(canvasRef.current, event.pointerId, false);
    // Um traço novo apaga o refazer: é o mesmo que qualquer editor faz, e manter a
    // pilha traria de volta um passo que já não pertence à edição atual.
    commit(addItem(editRef.current, { kind: "stroke", ...live.stroke }));
  };

  /** Põe uma caixa de texto e já abre o campo para digitar.
   *
   *  `at` é um ponto do **canvas**, e `align` diz que ponto da caixa cai ali: quem
   *  toca a imagem quer a borda esquerda na altura do dedo, e o botão "Adicionar
   *  texto" quer a caixa inteira centrada no que está à vista.
   *
   *  Como o texto nasce no quadro corrente, a matriz dele é translação pura — e por
   *  isso o canto da caixa em pixels do canvas vira a âncora na base com uma
   *  conversão só, sem aritmética de deslocamento para errar o sinal depois de girar.
   *
   *  O texto nasce vazio, e texto vazio não conta como marcação: concluir sem digitar
   *  nada ainda devolve o arquivo original. */
  const insertText = (at: Point, align: "left" | "center") => {
    const geometry = geometryOf(editRef.current, "text");
    const fitted = outputSize(baseRef.current, geometry);
    // O corpo é medido no que está à vista, como a espessura da caneta: o operador que
    // recortou está olhando de perto, e a letra tem de continuar do mesmo tamanho.
    const size = textSize(textLevel, Math.max(fitted.width, fitted.height));
    const id = nextTextId(editRef.current.items);
    const turn = editRef.current.rotation;
    const empty = { id, text: "", x: 0, y: 0, size, color: textColor, turn };
    const box = textBox(empty, measure);
    // Meia linha para cima, e meia caixa para a esquerda quando é para centrar: o
    // ponto dado é o meio da caixa, não o canto, senão a frase nasce pendurada
    // abaixo do dedo — ou fora do centro que o botão prometeu.
    const corner = { x: at.x - (align === "center" ? box.width / 2 : 0), y: at.y - box.height / 2 };
    const bounds = visibleBase(baseRef.current, geometry);
    const step = canvasDeltaToBase({ x: 0, y: box.height }, baseRef.current, geometry);
    let anchor = toBasePoint(corner, baseRef.current, geometry);
    // Duas inserções pelo botão cairiam no mesmo pixel e a segunda frase nasceria em
    // cima da primeira, com as alças sobrepostas: cada caixa desce uma linha até
    // achar lugar livre.
    while (textsOf(editRef.current.items).some((other) => other.x === anchor.x && other.y === anchor.y))
      anchor = { x: anchor.x + step.x, y: anchor.y + step.y };
    const placed = { kind: "text" as const, ...empty, ...clampTextPosition({ ...empty, ...anchor }, measure, bounds) };
    chooseText(id);
    // A criação e as teclas do texto compartilham a chave: o primeiro caractere
    // substitui a caixa vazia, e um Desfazer some com o texto inteiro em vez de
    // deixar uma caixa vazia para trás.
    commit(addItem(editRef.current, placed), `text:${id}`);
    // O foco vai para o campo no próximo quadro, quando ele já deixou de estar
    // desabilitado — campo desabilitado não recebe foco.
    queueMicrotask(() => textFieldRef.current?.focus());
  };
  /** O botão de teclado: sem ponteiro, o texto entra no meio do que está à vista. */
  const insertTextAtCenter = () => {
    if (!ready || busy) return;
    const fitted = outputSize(baseRef.current, geometryOf(editRef.current, "text"));
    insertText({ x: fitted.width / 2, y: fitted.height / 2 }, "center");
  };
  /** Trocar de texto selecionado fecha o agrupamento do histórico: a chave é do
   *  objeto, e continuar com a de outro funde dois momentos de edição num passo só.
   *  Reafirmar o mesmo texto não fecha nada — é o que deixa a seta repetida ser um
   *  gesto de reposicionar, e não um passo por tecla. */
  const chooseText = (id?: number) => {
    if (id !== selectedRef.current) groupRef.current = undefined;
    selectedRef.current = id;
    setSelectedText(id);
  };
  const selectText = (id: number) => {
    const item = textById(editRef.current.items, id);
    if (!item) return;
    chooseText(id);
    // A régua passa a mostrar o tamanho deste texto: mantê-la no último valor faria o
    // primeiro arrasto dela redimensionar para um número que ninguém pediu.
    const fitted = outputSize(baseRef.current, geometryOf(editRef.current, "text"));
    setTextLevel(textLevelOf(item.size, Math.max(fitted.width, fitted.height)));
    setTextColor(item.color);
  };
  /** Mede a cada tecla e prende de volta: sem isto, uma frase longa escrita perto da
   *  borda cresceria para fora da foto e o pedaço de fora seria cortado no envio, sem
   *  o operador ver que perdeu palavra. Quando o texto cabe, prender não move nada. */
  const reshapeText = (id: number, patch: Partial<TextItem>, group: string) => {
    const item = textById(editRef.current.items, id);
    if (!item) return;
    const next = { ...item, ...patch };
    const bounds = visibleBase(baseRef.current, geometryOf(editRef.current, "text"));
    commit(updateTextItem(editRef.current, id, { ...patch, ...clampTextPosition(next, measure, bounds) }), group);
  };
  const changeText = (value: string) => {
    if (selectedText === undefined) return;
    reshapeText(selectedText, { text: value.slice(0, TEXT_MAX_LENGTH) }, `text:${selectedText}`);
  };
  const changeTextLevel = (next: number) => {
    setTextLevel(next);
    if (selectedText === undefined) return;
    const fitted = outputSize(baseRef.current, geometryOf(editRef.current, "text"));
    reshapeText(selectedText, { size: textSize(next, Math.max(fitted.width, fitted.height)) }, `size:${selectedText}`);
  };
  const changeTextColor = (value: string) => {
    setTextColor(value);
    if (selectedText === undefined) return;
    commit(updateTextItem(editRef.current, selectedText, { color: value }), `color:${selectedText}`);
  };
  const deleteText = (id?: number) => {
    if (id === undefined || busy) return;
    chooseText(undefined);
    setLiveText(undefined);
    commit(removeTextItem(editRef.current, id));
  };
  const startTextDrag = (id: number) => (event: ReactPointerEvent<HTMLElement>) => {
    const canvas = canvasRef.current;
    const item = textById(editRef.current.items, id);
    if (!canvas || !item || !ready || busy || event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectText(id);
    // `preventDefault` num ponteiro impede o navegador de dar foco ao botão, e sem
    // foco a seta e o Delete continuariam agindo no texto selecionado antes deste.
    event.currentTarget.focus();
    setTextDrag({ id, pointerId: event.pointerId, origin: { x: item.x, y: item.y }, point: canvasPoint(canvas, event.clientX, event.clientY) });
  };
  /** O teclado do texto, na mesma convenção da alça do recorte: seta anda um pixel,
   *  Shift anda dez, e o passo é dado em pixels da tela — é o que faz "para a direita"
   *  continuar sendo para a direita depois de girar a foto. Enter leva ao campo de
   *  digitação; Delete apaga. Sem isto, texto seria ferramenta só de quem tem mouse. */
  const textKeys = (id: number) => (event: KeyboardEvent<HTMLElement>) => {
    if (busy) return;
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); event.stopPropagation(); deleteText(id); return; }
    // O foco só vai para o campo no próximo quadro: até o React repintar, o campo
    // ainda está desabilitado — porque este texto acabou de ser selecionado — e
    // elemento desabilitado não recebe foco.
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); selectText(id); queueMicrotask(() => textFieldRef.current?.focus()); return; }
    const arrow = ARROW_STEP[event.key];
    const item = textById(editRef.current.items, id);
    if (!arrow || !item) return;
    event.preventDefault();
    event.stopPropagation();
    const distance = event.shiftKey ? 10 : 1;
    const geometry = geometryOf(editRef.current, "text");
    const delta = canvasDeltaToBase({ x: arrow.x * distance, y: arrow.y * distance }, baseRef.current, geometry);
    const moved = clampTextPosition({ ...item, x: item.x + delta.x, y: item.y + delta.y }, measure, visibleBase(baseRef.current, geometry));
    selectText(id);
    // Segurar a seta dispara uma tecla por quadro: sem a chave, mover o texto meio
    // centímetro deixaria sessenta passos de desfazer para trás. Reposicionar pelo
    // teclado é um passo só, como o arrasto do ponteiro é um passo só.
    commit(updateTextItem(editRef.current, id, moved), `move:${id}`);
  };
  /** Sair do controle fecha o agrupamento: voltar a ele depois começa passo novo, em
   *  vez de fundir dois ajustes separados por outra coisa qualquer. */
  const endGroup = () => { groupRef.current = undefined; };

  const startCropDrag = (handle: CropHandle) => (event: ReactPointerEvent<HTMLElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || busy || event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    setDrag({ handle, pointerId: event.pointerId, rect: selection, point: canvasPoint(canvas, event.clientX, event.clientY) });
  };
  /** Seta move a alça um pixel do quadro; com Shift, dez. É o que torna o recorte
   *  alcançável sem mouse — arrastar uma alça de 16 px é o gesto mais fino do
   *  editor inteiro. */
  const nudgeCrop = (handle: CropHandle) => (event: KeyboardEvent<HTMLElement>) => {
    const arrow = ARROW_STEP[event.key];
    if (!arrow || busy) return;
    event.preventDefault();
    event.stopPropagation();
    const distance = event.shiftKey ? 10 : 1;
    const from = cropHandlePoint(selection, handle);
    commitCrop(dragCrop({ rect: selection, point: from, handle }, { x: from.x + arrow.x * distance, y: from.y + arrow.y * distance }, frame, aspect));
  };
  const chooseAspect = (value?: number) => {
    setAspect(value);
    if (value) commitCrop(fitAspect(selection, value));
  };
  /** Girar não toca na lista de traços: eles estão em coordenadas da base, e a
   *  base não gira — a transformação do canvas é que gira. O recorte, esse, tem de
   *  acompanhar, senão o enquadramento cai noutro pedaço da foto. */
  const turn = (quarter: 1 | -1) => {
    const current = editRef.current;
    const before = frameSize(baseRef.current, current.rotation);
    const rotation = turnRotation(current.rotation, quarter);
    const crop = current.crop ? normalizeCrop(turnRect(current.crop, before, quarter), frameSize(baseRef.current, rotation)) : undefined;
    setAspect(undefined);
    setLive(undefined);
    commit({ ...current, rotation, crop });
  };

  const step = (delta: number) => {
    const index = history.index + delta;
    const next = history.entries[index];
    if (!next || busy) return;
    editRef.current = next;
    setLive(undefined);
    setLiveText(undefined);
    // Desfazer solta a seleção, e soltar a seleção fecha o agrupamento — que é o que
    // impede a primeira tecla depois de um desfazer de substituir o passo que o
    // desfazer acabou de restaurar.
    //
    // Soltar é obrigatório: o passo para onde se foi pode não ter aquele texto e, pior,
    // pode ter outro com o mesmo id, porque o id é o maior da lista mais um e volta a
    // ser oferecido quando um texto é apagado. Seleção presa a um crachá reaproveitado
    // apagaria o texto errado no Delete seguinte.
    chooseText(undefined);
    setHistory({ entries: history.entries, index });
  };
  /** Volta à imagem como ela entrou: some o desenho, o texto, o giro e o recorte de
   *  uma vez, inclusive o que já tinha sido aplicado numa passagem anterior. Continua
   *  sendo um passo do histórico, então desfazer traz tudo de volta. */
  const discard = () => { setError(""); setAspect(undefined); setLive(undefined); setLiveText(undefined); chooseText(undefined); commit(PRISTINE_EDIT); };

  const confirm = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || busy) return;
    const current = editRef.current;
    // Sem traço, sem giro e sem recorte não há o que reexportar: devolver o
    // original preserva o EXIF e poupa uma recodificação que só perderia qualidade.
    if (isPristineEdit(current)) { onConfirm(file, current); return; }
    // Concluir com o recorte ainda em edição tem de exportar o resultado, não o
    // quadro inteiro que a seleção estava mostrando por cima.
    setMode("pen");
    paint(current, "pen");
    setBusy(true);
    setError("");
    try {
      const outcome = await exportAnnotated(canvas, file);
      if (!outcome.ok) { setError(exportErrorMessage(outcome)); return; }
      onConfirm(outcome.file, current);
    } catch {
      setError("Não foi possível gerar a imagem editada neste navegador.");
    } finally {
      setBusy(false);
    }
  };

  const escapeCloses = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    // Um Esc desfaz um passo: primeiro o arrasto em curso, depois a seleção do texto,
    // e só então o painel.
    if (drag) { setDrag(undefined); setLive(undefined); return; }
    if (textDrag) { setTextDrag(undefined); setLiveText(undefined); return; }
    // Soltar a seleção também fecha o agrupamento: sem isso, a digitação depois de
    // um Esc substituiria o passo anterior em vez de empilhar sobre ele.
    if (selectedText !== undefined) { chooseText(undefined); return; }
    onCancel();
  };
  const percent = (value: number, total: number) => `${total ? (value / total) * 100 : 0}%`;
  const pristine = isPristineEdit(edit);
  const chosenText = textById(edit.items, selectedText);

  return (
    <div className="composer-editor" role="dialog" aria-label="Editar imagem" onKeyDown={escapeCloses}>
      <div className="composer-editor-head">
        <strong>Editar imagem</strong>
        <button type="button" onClick={onCancel} aria-label="Fechar edição">×</button>
      </div>
      {/* A moldura existe para a seleção do recorte poder ser posicionada em
          porcentagem: sem ela, `object-fit: contain` deixaria faixas vazias dentro
          da caixa do canvas e a alça pousaria fora da imagem. */}
      <div className="composer-editor-frame" style={{ "--editor-ratio": `${output.height ? output.width / output.height : 1}` } as CSSProperties}>
        <canvas
          ref={canvasRef}
          className="composer-editor-canvas"
          aria-label="Área de marcação da imagem"
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
        />
        {/* A alça de cada texto é um `<button>` de verdade, do tamanho da caixa: é o
            que dá alvo ao ponteiro, foco ao Tab e rótulo ao leitor de tela sem
            inventar um campo flutuante sobre o canvas. O desenho continua sendo do
            canvas — a alça não pinta nada. */}
        {mode === "text" && ready && (
          <div className="composer-editor-text-layer">
            {textsOf(edit.items).map((item) => {
              const box = textOverlayRect(item, measure, base, geometryOf(edit, mode));
              // Um texto que o recorte jogou para fora não ganha alça. A camada tem
              // `overflow: hidden`, então ela seria invisível — mas continuaria na
              // ordem do Tab, e um Delete ali apagaria um texto que ninguém vê.
              // Recorte corta a marcação como corta tinta (§3.7): para trazer o texto
              // de volta, desfaz-se o recorte.
              if (!rectsOverlap(box, fullRect(output))) return null;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`composer-editor-text-item${item.id === selectedText ? " is-selected" : ""}`}
                  aria-label={item.text ? `Texto “${item.text}”` : "Texto sem conteúdo"}
                  aria-pressed={item.id === selectedText}
                  style={{ left: percent(box.x, output.width), top: percent(box.y, output.height), width: percent(box.width, output.width), height: percent(box.height, output.height) }}
                  onPointerDown={startTextDrag(item.id)}
                  onClick={() => selectText(item.id)}
                  onKeyDown={textKeys(item.id)}
                  onBlur={endGroup}
                />
              );
            })}
          </div>
        )}
        {mode === "crop" && ready && (
          <div className="composer-editor-crop">
            <div
              className="composer-editor-crop-box"
              role="group"
              aria-label={`Recorte de ${Math.round(selection.width)} por ${Math.round(selection.height)} pixels`}
              style={{ left: percent(selection.x, frame.width), top: percent(selection.y, frame.height), width: percent(selection.width, frame.width), height: percent(selection.height, frame.height) }}
              onPointerDown={startCropDrag("move")}
            >
              {CROP_HANDLES.map((handle) => (
                <button
                  key={handle}
                  type="button"
                  className={`composer-editor-crop-handle is-${handle}`}
                  aria-label={HANDLE_LABEL[handle]}
                  title={HANDLE_LABEL[handle]}
                  onPointerDown={startCropDrag(handle)}
                  onKeyDown={nudgeCrop(handle)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      {notice && <p className="composer-editor-notice">{notice}</p>}
      {error && <p className="composer-editor-error" role="alert">{error}</p>}
      <div className="composer-editor-tools">
        <div className="composer-editor-modes" role="radiogroup" aria-label="Ferramenta">
          <button type="button" role="radio" aria-checked={mode === "pen"} aria-label="Caneta" onClick={() => setMode("pen")}><span aria-hidden="true">✎</span> Caneta</button>
          <button type="button" role="radio" aria-checked={mode === "text"} aria-label="Texto" onClick={() => setMode("text")}><span aria-hidden="true">T</span> Texto</button>
          <button type="button" role="radio" aria-checked={mode === "crop"} aria-label="Recortar" onClick={() => setMode("crop")}><span aria-hidden="true">⛶</span> Recortar</button>
        </div>
        <div className="composer-editor-turns">
          <button type="button" onClick={() => turn(-1)} disabled={!ready || busy} aria-label="Girar 90° à esquerda" title="Girar 90° à esquerda"><span aria-hidden="true">⟲</span> 90°</button>
          <button type="button" onClick={() => turn(1)} disabled={!ready || busy} aria-label="Girar 90° à direita" title="Girar 90° à direita"><span aria-hidden="true">⟳</span> 90°</button>
        </div>
      </div>
      {mode === "pen" ? (
        <div className="composer-editor-tools">
          <div className="composer-editor-colors" role="radiogroup" aria-label="Cor da caneta">
            {PEN_COLORS.map((pen) => (
              <button
                key={pen.value}
                type="button"
                role="radio"
                aria-checked={pen.value === color}
                aria-label={pen.label}
                title={pen.label}
                style={{ background: pen.value }}
                onClick={() => setColor(pen.value)}
              />
            ))}
          </div>
          <label className="composer-editor-width">
            <span>Espessura</span>
            <input
              type="range"
              min={PEN_LEVELS.min}
              max={PEN_LEVELS.max}
              step={1}
              value={level}
              aria-label="Espessura do traço"
              onChange={(event) => setLevel(Number(event.target.value))}
            />
            <b>{level}</b>
          </label>
        </div>
      ) : mode === "text" ? (
        <>
          <div className="composer-editor-tools">
            {/* O caminho sem ponteiro: sem este botão, criar texto exigiria clicar na
                imagem, que é o único gesto do editor que o teclado não alcança. */}
            <button type="button" className="composer-editor-text-action" onClick={insertTextAtCenter} disabled={!ready || busy}>
              <span aria-hidden="true">+</span> Adicionar texto
            </button>
            {/* O campo mora aqui, e não flutuando sobre a imagem: assim é um input
                comum, com rótulo, que o leitor de tela anuncia e o teclado do celular
                abre sem truque. O canvas repinta a cada tecla, então o texto aparece
                na foto enquanto se digita. */}
            <label className="composer-editor-text-field">
              <span>Conteúdo</span>
              <input
                ref={textFieldRef}
                type="text"
                value={chosenText?.text ?? ""}
                maxLength={TEXT_MAX_LENGTH}
                placeholder={chosenText ? "Escreva sobre a imagem" : "Toque na imagem ou use Adicionar texto"}
                aria-label="Conteúdo do texto"
                disabled={!chosenText || busy}
                onChange={(event) => changeText(event.target.value)}
                onBlur={endGroup}
              />
            </label>
            <button type="button" className="composer-editor-text-action" onClick={() => deleteText(selectedText)} disabled={!chosenText || busy} aria-label="Apagar texto">Apagar</button>
          </div>
          <div className="composer-editor-tools">
            <div className="composer-editor-colors" role="radiogroup" aria-label="Cor do texto">
              {PEN_COLORS.map((pen) => (
                <button
                  key={pen.value}
                  type="button"
                  role="radio"
                  aria-checked={pen.value === textColor}
                  aria-label={pen.label}
                  title={pen.label}
                  style={{ background: pen.value }}
                  onClick={() => changeTextColor(pen.value)}
                />
              ))}
            </div>
            <label className="composer-editor-width">
              <span>Tamanho</span>
              <input
                type="range"
                min={TEXT_LEVELS.min}
                max={TEXT_LEVELS.max}
                step={1}
                value={textLevel}
                aria-label="Tamanho do texto"
                onChange={(event) => changeTextLevel(Number(event.target.value))}
                onBlur={endGroup}
              />
              <b>{textLevel}</b>
            </label>
          </div>
        </>
      ) : (
        <div className="composer-editor-tools">
          <div className="composer-editor-aspects" role="radiogroup" aria-label="Proporção do recorte">
            {CROP_ASPECTS.map((option) => (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={aspect === option.value}
                onClick={() => chooseAspect(option.value)}
                disabled={!ready || busy}
              >{option.label}</button>
            ))}
          </div>
          <span className="composer-editor-crop-size">{Math.round(selection.width)}×{Math.round(selection.height)} px</span>
        </div>
      )}
      <div className="composer-editor-actions">
        <button type="button" className="composer-editor-undo" onClick={() => step(-1)} disabled={history.index === 0} aria-label="Desfazer">↺ Desfazer</button>
        <button type="button" onClick={() => step(1)} disabled={history.index >= history.entries.length - 1} aria-label="Refazer">↻ Refazer</button>
        {/* Caixa de texto vazia não é marcação (§3.6), mas é uma caixa na tela: sem
            este `items.length` o botão ficaria desabilitado com caixas à vista, e não
            haveria como varrê-las senão apagando uma por uma. */}
        <button type="button" onClick={discard} disabled={pristine && !edit.items.length}>Descartar edição</button>
        <button type="button" className="composer-editor-confirm" onClick={() => void confirm()} disabled={!ready || busy}>{busy ? "Aplicando…" : "Concluir"}</button>
      </div>
    </div>
  );
}

/** Segurar o ponteiro mantém o traço vivo quando a mão sai da área de marcação.
 *  É opcional de propósito: o navegador recusa a captura quando o ponteiro já não
 *  está ativo, e perder a captura é bem menos grave do que derrubar o traço. */
const capturePointer = (canvas: HTMLCanvasElement, pointerId: number, hold: boolean) => {
  try { if (hold) canvas.setPointerCapture?.(pointerId); else canvas.releasePointerCapture?.(pointerId); } catch { /* captura é conforto, não requisito */ }
};

/** O motivo da recusa muda o que o operador tem de fazer, então cada um tem a sua
 *  frase — despejar "falhou" mandaria tentar de novo o que vai falhar de novo. */
const exportErrorMessage = (outcome: Extract<ExportOutcome, { ok: false }>) => {
  if (outcome.reason === "size")
    return `A imagem editada ficou com ${(outcome.size / 1024 / 1024).toFixed(1)} MB e o limite de envio é ${IMAGE_UPLOAD_LIMIT / 1024 / 1024} MB. Escolha uma imagem menor.`;
  if (outcome.reason === "format") return "Este navegador gerou a imagem num formato que o envio não aceita.";
  return "Não foi possível gerar a imagem editada neste navegador.";
};
