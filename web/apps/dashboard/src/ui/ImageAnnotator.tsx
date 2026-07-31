import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  CROP_ASPECTS,
  CROP_HANDLES,
  EDITOR_MAX_DIMENSION,
  IMAGE_UPLOAD_LIMIT,
  PEN_COLORS,
  PEN_LEVELS,
  PRISTINE_EDIT,
  canvasPoint,
  cropHandlePoint,
  dragCrop,
  exportAnnotated,
  fitAspect,
  fitWithin,
  frameSize,
  fullRect,
  isPristineEdit,
  normalizeCrop,
  outputSize,
  penWidth,
  pointerSamples,
  renderAnnotation,
  toBasePoint,
  turnRect,
  turnRotation,
  type CropHandle,
  type ExportOutcome,
  type Geometry,
  type ImageEdit,
  type Point,
  type Rect,
  type Size,
  type Stroke,
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
 *  Traço, giro e recorte cabem no mesmo modelo porque nenhum dos três guarda
 *  pixels: o traço é uma lista de pontos na base, o giro é um número e o recorte é
 *  um retângulo. Repintar é aplicar a geometria como transformação do canvas e
 *  desenhar a base por dentro dela.
 */
type Mode = "pen" | "crop";

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
 *  cima, não um corte já aplicado. Só ao concluir — ou ao voltar para a caneta — o
 *  recorte entra na imagem. */
const geometryOf = (edit: ImageEdit, mode: Mode): Geometry =>
  mode === "crop" ? { rotation: edit.rotation } : { rotation: edit.rotation, crop: edit.crop };

/** O histórico de uma reabertura é reconstruído a partir da edição que voltou:
 *  primeiro a geometria, depois um passo por traço.
 *
 *  A ordem real das ações da passagem anterior não foi guardada — e não precisa
 *  ser, porque qualquer caminho até esta edição termina na mesma imagem. O que
 *  importa é que desfazer continue descascando o trabalho anterior um passo por
 *  vez, como fazia quando o histórico era só a lista de traços. */
const seedHistory = (edit: ImageEdit): ImageEdit[] => {
  const geometry: ImageEdit = { strokes: [], rotation: edit.rotation, crop: edit.crop };
  const entries: ImageEdit[] = [PRISTINE_EDIT];
  if (edit.rotation !== 0 || edit.crop) entries.push(geometry);
  for (let index = 1; index <= edit.strokes.length; index += 1) entries.push({ ...geometry, strokes: edit.strokes.slice(0, index) });
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
  const [color, setColor] = useState(PEN_COLORS[0].value);
  const [level, setLevel] = useState<number>(PEN_LEVELS.default);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const edit = history.entries[history.index];
  const frame = frameSize(base, edit.rotation);
  /** O que o operador vê como seleção: o arrasto em curso, o recorte já aplicado,
   *  ou o quadro inteiro quando ainda não recortou. */
  const selection = liveCrop ?? edit.crop ?? fullRect(frame);
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
    renderAnnotation(context, imageRef.current, live ? [...next.strokes, live] : next.strokes, size, geometry);
  }, []);
  const setLive = useCallback((rect?: Rect) => { liveCropRef.current = rect; setLiveCropState(rect); }, []);
  const commit = useCallback((next: ImageEdit) => {
    editRef.current = next;
    setHistory((current) => ({ entries: [...current.entries.slice(0, current.index + 1), next], index: current.index + 1 }));
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

  const setMode = (next: Mode) => { modeRef.current = next; setLive(undefined); setModeState(next); };

  /** Ponteiro → ponto de traço, nas coordenadas da base. Passar pela geometria é o
   *  que faz o traço cair no lugar certo depois de girar ou recortar. */
  const strokePoint = (canvas: HTMLCanvasElement, clientX: number, clientY: number): Point =>
    toBasePoint(canvasPoint(canvas, clientX, clientY), baseRef.current, geometryOf(editRef.current, "pen"));

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    // `button > 0` é botão do meio ou direito do mouse; toque e caneta chegam com 0.
    if (!canvas || !ready || busy || event.button > 0 || modeRef.current !== "pen") return;
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
    commit({ ...editRef.current, strokes: [...editRef.current.strokes, live.stroke] });
  };

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
    setHistory({ entries: history.entries, index });
  };
  /** Volta à imagem como ela entrou: some o desenho, o giro e o recorte de uma vez,
   *  inclusive o que já tinha sido aplicado numa passagem anterior. Continua sendo
   *  um passo do histórico, então desfazer traz tudo de volta. */
  const discard = () => { setError(""); setAspect(undefined); setLive(undefined); commit(PRISTINE_EDIT); };

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
    // Um Esc desfaz um passo: primeiro o arrasto da alça, e só então o painel.
    if (drag) { setDrag(undefined); setLive(undefined); return; }
    onCancel();
  };
  const percent = (value: number, total: number) => `${total ? (value / total) * 100 : 0}%`;
  const pristine = isPristineEdit(edit);

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
        <button type="button" onClick={discard} disabled={pristine}>Descartar edição</button>
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
