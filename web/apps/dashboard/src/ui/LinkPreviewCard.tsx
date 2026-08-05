import { useEffect, useState, type ReactNode } from "react";
import type { InboxApi, InboxMessage } from "../api/inbox.js";
import { durationLabel } from "./messageMedia.js";
import { cachedLinkPreview, domainFromUrl, findUrls, nativeLinkPreview, providerFromUrl, type LinkPreviewData } from "./linkPreview.js";

/** URLs do texto viram âncoras seguras. Os trechos entre elas seguem como
 *  strings puras — o React escapa, nenhum HTML é montado (XSS-safe por
 *  construção). A busca anda para a frente, então URL repetida vira âncora nas
 *  duas ocorrências. */
export const linkify = (content: string): ReactNode => {
  const urls = findUrls(content);
  if (!urls.length) return content;
  const nodes: ReactNode[] = [];
  let rest = content;
  let key = 0;
  while (rest) {
    const positions = urls.map((url) => rest.indexOf(url)).filter((index) => index >= 0);
    if (!positions.length) { nodes.push(rest); break; }
    const at = Math.min(...positions);
    const url = urls.find((candidate) => rest.startsWith(candidate, at))!;
    if (at > 0) nodes.push(rest.slice(0, at));
    nodes.push(<a key={key++} className="message-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>);
    rest = rest.slice(at + url.length);
  }
  return nodes;
};

/** Uma prévia por mensagem, a do primeiro link — como o WhatsApp. A nativa
 *  (rede zero) vence sempre; sem ela, a retaguarda raspada pela API entra, e
 *  falha não deixa resíduo: o texto linkado permanece, o cartão some. */
export const LinkPreview = ({ message, api }: { message: InboxMessage; api: InboxApi }) => {
  const native = nativeLinkPreview(message);
  const firstUrl = message.content ? findUrls(message.content)[0] : undefined;
  const [fetched, setFetched] = useState<LinkPreviewData | null | undefined>(undefined);
  useEffect(() => {
    // Com nativa ou sem URL não há o que buscar — e a API não é chamada.
    if (native || !firstUrl) { setFetched(null); return; }
    let active = true;
    setFetched(undefined);
    void cachedLinkPreview(api, firstUrl).then((value) => { if (active) setFetched(value); });
    return () => { active = false; };
  }, [api, native, firstUrl]);

  const preview = native ?? fetched;
  if (!native && !firstUrl) return null;
  if (fetched === undefined && !native) {
    return <span className="link-preview-card is-loading" aria-hidden="true"><i /><i /><i /></span>;
  }
  if (!preview?.url || (!preview.title && !preview.imageUrl)) return null;
  const provider = preview.provider ?? providerFromUrl(preview.url);
  const domain = preview.siteName ?? domainFromUrl(preview.url);
  return (
    <a className={`link-preview-card is-${provider}`} href={preview.url} target="_blank" rel="noopener noreferrer" aria-label={preview.title ? `Abrir link: ${preview.title}` : `Abrir link: ${preview.url}`}>
      {preview.imageUrl && <span className="link-preview-image"><img src={preview.imageUrl} alt="" loading="lazy" />{preview.durationSeconds != null && <span className="link-preview-duration">{durationLabel(preview.durationSeconds)}</span>}</span>}
      <span className="link-preview-body">
        {preview.title && <strong className="link-preview-title">{preview.title}</strong>}
        {preview.author && <span className="link-preview-author">{preview.author}</span>}
        {preview.description && <span className="link-preview-description">{preview.description}</span>}
        <span className="link-preview-footer">{preview.faviconUrl && <img className="link-preview-favicon" src={preview.faviconUrl} alt="" loading="lazy" />}{preview.siteName && <span className="link-preview-site">{preview.siteName}</span>}<span className="link-preview-domain">{domain}</span></span>
        <small className="link-preview-url">{preview.url}</small>
      </span>
    </a>
  );
};
