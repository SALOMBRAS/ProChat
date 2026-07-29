import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  EDITOR_MAX_DIMENSION,
  IMAGE_UPLOAD_LIMIT,
  PEN_COLORS,
  PEN_LEVELS,
  canvasPoint,
  exportAnnotated,
  fitWithin,
  penWidth,
  pointerSamples,
  renderAnnotation,
  type ExportOutcome,
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
 *  rodada. Os traços já aplicados voltam por `initialStrokes`, então reabrir o
 *  editor continua de onde parou sem recodificar duas vezes.
 */
export function ImageAnnotator({ file, initialStrokes = [], onCancel, onConfirm }: {
  file: File;
  initialStrokes?: readonly Stroke[];
  onCancel: () => void;
  onConfirm: (edited: File, strokes: Stroke[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<CanvasImageSource>();
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const liveRef = useRef<{ pointerId: number; stroke: Stroke }>();
  // Os manipuladores de ponteiro leem o histórico durante o arrasto, quando o
  // estado do React ainda não repassou: a referência é a lista corrente.
  const strokesRef = useRef<Stroke[]>([...initialStrokes]);
  const [strokes, setStrokes] = useState<Stroke[]>(() => [...initialStrokes]);
  const [undone, setUndone] = useState<Stroke[]>([]);
  const [color, setColor] = useState(PEN_COLORS[0].value);
  const [level, setLevel] = useState<number>(PEN_LEVELS.default);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const repaint = useCallback((live?: Stroke) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    renderAnnotation(context, imageRef.current, live ? [...strokesRef.current, live] : strokesRef.current, sizeRef.current);
  }, []);
  const commit = useCallback((next: Stroke[], nextUndone: Stroke[]) => {
    strokesRef.current = next;
    setStrokes(next);
    setUndone(nextUndone);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const fitted = fitWithin(image.naturalWidth || image.width, image.naturalHeight || image.height);
      canvas.width = fitted.width;
      canvas.height = fitted.height;
      imageRef.current = image;
      sizeRef.current = { width: fitted.width, height: fitted.height };
      setNotice(fitted.reduced ? `Imagem reduzida para ${fitted.width}×${fitted.height} px na edição: o teto é ${EDITOR_MAX_DIMENSION} px no lado maior.` : "");
      setReady(true);
      repaint();
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
  }, [file, repaint]);
  // Desfazer, refazer e descartar mudam a lista inteira: repintar do zero é o que
  // faz a marcação desaparecer da tela junto.
  useEffect(() => { repaint(); }, [strokes, repaint]);

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    // `button > 0` é botão do meio ou direito do mouse; toque e caneta chegam com 0.
    if (!canvas || !ready || busy || event.button > 0) return;
    event.preventDefault();
    capturePointer(canvas, event.pointerId, true);
    const longest = Math.max(sizeRef.current.width, sizeRef.current.height);
    liveRef.current = { pointerId: event.pointerId, stroke: { color, width: penWidth(level, longest), points: [canvasPoint(canvas, event.clientX, event.clientY)] } };
    repaint(liveRef.current.stroke);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    const canvas = canvasRef.current;
    if (!live || !canvas || live.pointerId !== event.pointerId) return;
    event.preventDefault();
    for (const sample of pointerSamples(event)) live.stroke.points.push(canvasPoint(canvas, sample.clientX, sample.clientY));
    repaint(live.stroke);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    if (!live || live.pointerId !== event.pointerId) return;
    liveRef.current = undefined;
    if (canvasRef.current) capturePointer(canvasRef.current, event.pointerId, false);
    // Um traço novo apaga o refazer: é o mesmo que qualquer editor faz, e manter a
    // pilha traria de volta um traço que já não pertence ao desenho atual.
    commit([...strokesRef.current, live.stroke], []);
  };

  const undo = () => {
    const current = strokesRef.current;
    if (!current.length) return;
    commit(current.slice(0, -1), [...undone, current[current.length - 1]]);
  };
  const redo = () => {
    if (!undone.length) return;
    commit([...strokesRef.current, undone[undone.length - 1]], undone.slice(0, -1));
  };
  /** Volta à imagem como ela entrou: some o desenho inteiro, inclusive o que já
   *  tinha sido aplicado numa passagem anterior. */
  const discard = () => { setError(""); commit([], []); };

  const confirm = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || busy) return;
    // Sem traço não há o que reexportar: devolver o original preserva o EXIF e
    // poupa uma recodificação que só perderia qualidade.
    if (!strokesRef.current.length) { onConfirm(file, []); return; }
    setBusy(true);
    setError("");
    try {
      const outcome = await exportAnnotated(canvas, file);
      if (!outcome.ok) { setError(exportErrorMessage(outcome)); return; }
      onConfirm(outcome.file, strokesRef.current);
    } catch {
      setError("Não foi possível gerar a imagem editada neste navegador.");
    } finally {
      setBusy(false);
    }
  };

  const escapeCloses = (event: KeyboardEvent<HTMLDivElement>) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } };

  return (
    <div className="composer-editor" role="dialog" aria-label="Editar imagem" onKeyDown={escapeCloses}>
      <div className="composer-editor-head">
        <strong>Editar imagem</strong>
        <button type="button" onClick={onCancel} aria-label="Fechar edição">×</button>
      </div>
      <canvas
        ref={canvasRef}
        className="composer-editor-canvas"
        aria-label="Área de marcação da imagem"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      />
      {notice && <p className="composer-editor-notice">{notice}</p>}
      {error && <p className="composer-editor-error" role="alert">{error}</p>}
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
      <div className="composer-editor-actions">
        <button type="button" className="composer-editor-undo" onClick={undo} disabled={!strokes.length} aria-label="Desfazer">↺ Desfazer</button>
        <button type="button" onClick={redo} disabled={!undone.length} aria-label="Refazer">↻ Refazer</button>
        <button type="button" onClick={discard} disabled={!strokes.length && !undone.length}>Descartar edição</button>
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
