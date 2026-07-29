import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { fileSizeLabel } from "./attachmentIntake.js";

/** Tela de composição de anexo: toma o lugar da conversa quando há mídia
 *  pendente.
 *
 *  O cartão de 40px ao lado do campo de texto mostrava nome e tamanho — tudo
 *  menos a imagem. Quem anexa uma foto quer *ver* a foto antes de mandar, e a
 *  legenda só faz sentido junto dela. Aqui o preview ocupa o espaço da conversa e
 *  a legenda fica encostada nele, com o envio ao lado.
 *
 *  A tela não envia nada: o `<form>` da legenda é submetido pelo mesmo
 *  `submitMessage` do compositor, com o mesmo campo `name="text"`. O caminho
 *  `setAttachment` → `api.sendAttachment` continua exatamente onde estava.
 */
export type AttachmentComposerProps = {
  file: File;
  previewUrl?: string;
  caption: string;
  onCaption: (value: string) => void;
  sending: boolean;
  status?: string;
  /** Recado de colar ou arrastar. Vem para cá porque o compositor — onde ele
   *  aparecia — sai do ar quando esta tela entra, e "só o primeiro foi anexado"
   *  precisa ser lido justamente quando vários arquivos abriram a tela. */
  notice?: { text: string; failed: boolean };
  /** Editor de traço já montado pelo Inbox, posto sobre o preview. Ausente quando
   *  fechado — é o que diz à tela se o Esc é dela ou do editor. */
  editor?: ReactNode;
  onEditorClose: () => void;
  canEdit: boolean;
  onEdit: () => void;
  /** Há legenda ou traço a perder: fechar e remover passam pela confirmação. */
  dirty: boolean;
  /** Volta à conversa descartando o anexo; a legenda sobrevive no compositor. */
  onClose: () => void;
  /** Descarta anexo e legenda de uma vez. */
  onRemove: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

type Pending = "close" | "remove";

export function AttachmentComposer({
  file, previewUrl, caption, onCaption, sending, status, notice,
  editor, onEditorClose, canEdit, onEdit, dirty, onClose, onRemove, onSubmit,
}: AttachmentComposerProps) {
  const [pending, setPending] = useState<Pending>();
  const run = (action: Pending) => (action === "remove" ? onRemove : onClose)();
  // Sem nada a perder a confirmação só atrapalharia: fechar uma tela onde não se
  // escreveu nada tem de ser um clique.
  const ask = (action: Pending) => { if (sending) return; if (dirty) setPending(action); else run(action); };
  const confirmPending = () => { const action = pending; setPending(undefined); if (action) run(action); };

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Um Esc desfaz um passo: primeiro a confirmação, depois o editor, e só
      // então a tela. Fechar tudo de uma vez descartaria o traço sem perguntar.
      if (pending) { setPending(undefined); return; }
      if (editor) { onEditorClose(); return; }
      ask("close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Enter envia e Shift+Enter quebra linha — é o que o WhatsApp faz na legenda.
   *  Vale só aqui: o compositor da conversa continua com Enter quebrando linha,
   *  porque mudar isso é outra decisão. */
  const captionKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || sending) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const video = file.type.startsWith("video/");
  return (
    <div className="attachment-stage" role="region" aria-label="Compor anexo">
      <div className="attachment-stage-bar">
        <div className="attachment-stage-file">
          <strong title={file.name}>{file.name}</strong>
          <span>{fileSizeLabel(file.size)}</span>
        </div>
        <div className="attachment-stage-tools">
          {canEdit && <button type="button" onClick={onEdit} disabled={sending || Boolean(editor)} aria-label="Editar com a caneta" title="Editar com a caneta"><span aria-hidden="true">✎</span><b>Editar</b></button>}
          <button type="button" onClick={() => ask("remove")} disabled={sending} aria-label="Remover anexo" title="Remover anexo"><span aria-hidden="true">⌫</span><b>Remover</b></button>
          <button type="button" className="attachment-stage-close" onClick={() => ask("close")} disabled={sending} aria-label="Fechar" title="Fechar"><span aria-hidden="true">×</span><b>Fechar</b></button>
        </div>
      </div>
      {notice && <p className={`composer-intake-message${notice.failed ? " failed" : ""}`} role={notice.failed ? "alert" : "status"}>{notice.text}</p>}
      <div className="attachment-stage-preview">
        {editor ?? (
          previewUrl
            ? video
              ? <video className="attachment-stage-media" src={previewUrl} controls playsInline aria-label={`Prévia de ${file.name}`} />
              : <img className="attachment-stage-media" src={previewUrl} alt={`Prévia de ${file.name}`} />
            : <p className="attachment-stage-empty">Não foi possível gerar a prévia deste arquivo.</p>
        )}
      </div>
      {pending && (
        <div className="attachment-stage-confirm" role="alertdialog" aria-label="Confirmar descarte">
          <p>{pending === "remove" ? "Descartar o anexo e a legenda?" : "Descartar o anexo? A legenda volta para o campo de mensagem."}</p>
          <button type="button" onClick={() => setPending(undefined)}>Cancelar</button>
          <button type="button" className="attachment-stage-discard" onClick={confirmPending}>{pending === "remove" ? "Descartar tudo" : "Descartar anexo"}</button>
        </div>
      )}
      <form className="attachment-stage-composer" onSubmit={onSubmit}>
        <textarea
          name="text"
          value={caption}
          onChange={(event) => onCaption(event.target.value)}
          onKeyDown={captionKeys}
          placeholder="Adicionar legenda (opcional)"
          aria-label="Legenda do anexo"
          maxLength={4096}
          disabled={sending}
          autoFocus
        />
        {status && <span className="attachment-stage-status">{status}</span>}
        <button className="send-button" disabled={sending} aria-label={sending ? "Enviando anexo" : "Enviar"}>{sending ? "…" : "➤"}</button>
      </form>
    </div>
  );
}
