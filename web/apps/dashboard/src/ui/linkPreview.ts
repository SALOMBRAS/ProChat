import type { LinkPreview, LinkPreviewProvider } from "@chatpro/contracts";
import type { InboxApi, InboxMessage } from "../api/inbox.js";

export const MAX_URLS = 32;
export const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?'"»]+$/;

/** Apara a pontuação da frase que gruda na URL. O parêntese excedente sai
 *  enquanto houver mais `)` que `(` — o da frase sai, o da URL estilo Wikipédia
 *  (balanceado) fica. */
export const trimUrl = (raw: string): string => {
  let url = raw.replace(TRAILING, "");
  while (url.endsWith(")") && (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length) url = url.slice(0, -1);
  return url;
};

/** Só http(s), sem repetição, até 32 — texto de mensagem tem 4.096 chars no
 *  contrato, então a varredura é finita por construção. */
export const findUrls = (text: string): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (!url || found.includes(url)) continue;
    found.push(url);
    if (found.length >= MAX_URLS) break;
  }
  return found;
};

/** Hostname sem `www.` — como o WhatsApp mostra no rodapé do cartão. */
export const domainFromUrl = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

/** Espelho cliente do `providerFromHostname` da API; cobre também `fb.watch`. */
export const providerFromUrl = (url: string): LinkPreviewProvider => {
  const host = domainFromUrl(url).toLowerCase();
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
  if (host === "github.com") return "github";
  if (host === "open.spotify.com") return "spotify";
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch") return "facebook";
  if (host === "figma.com" || host.endsWith(".figma.com")) return "figma";
  if (host === "notion.so" || host.endsWith(".notion.site")) return "notion";
  if (host === "drive.google.com" || host === "docs.google.com") return "google-drive";
  if (host === "dropbox.com" || host.endsWith(".dropbox.com")) return "dropbox";
  return "generic";
};

export type LinkPreviewData = Pick<LinkPreview, "url"> & Partial<Omit<LinkPreview, "url">>;

const asText = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Validação frouxa do `metadata.linkPreview`: exige `url` e ao menos `title`
 *  ou `imageUrl`; campos tortos caem fora em vez de derrubar a prévia. */
const sanitize = (value: unknown): LinkPreviewData | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const url = asText(raw.url);
  const title = asText(raw.title);
  const imageUrl = asText(raw.imageUrl);
  if (!url || (!title && !imageUrl)) return undefined;
  const duration = typeof raw.durationSeconds === "number" && Number.isFinite(raw.durationSeconds) && raw.durationSeconds >= 0 ? Math.floor(raw.durationSeconds) : undefined;
  const provider = asText(raw.provider) as LinkPreviewProvider | undefined;
  return {
    url,
    ...(title ? { title } : {}),
    ...(asText(raw.description) ? { description: asText(raw.description) } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(asText(raw.siteName) ? { siteName: asText(raw.siteName) } : {}),
    ...(asText(raw.faviconUrl) ? { faviconUrl: asText(raw.faviconUrl) } : {}),
    ...(asText(raw.author) ? { author: asText(raw.author) } : {}),
    ...(provider ? { provider } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
  };
};

/** Prévia que viaja na mensagem, na prioridade do WhatsApp:
 *
 *  1. `metadata.linkPreview` — os nossos envios, persistidos pela API a partir
 *     do `_data` que a WAHA devolve no `sendText`;
 *  2. `metadata._data` — as recebidas, payload cru do whatsapp-web.js.
 *
 *  Custo de rede: zero. Sem título nem imagem devolve `null` — quem decide se
 *  busca a retaguarda é o componente. */
export const nativeLinkPreview = (message: Pick<InboxMessage, "content" | "metadata">): LinkPreviewData | null => {
  const persisted = sanitize((message.metadata as { linkPreview?: unknown } | undefined)?.linkPreview);
  if (persisted) return persisted;
  const data = (message.metadata as { _data?: Record<string, unknown> } | undefined)?._data;
  if (!data) return null;
  const title = asText(data.title);
  const thumbnail = asText(data.thumbnail);
  if (!title && !thumbnail) return null;
  const url = asText(data.canonicalUrl) ?? asText(data.matchedText) ?? (message.content ? findUrls(message.content)[0] : undefined);
  if (!url) return null;
  return {
    url,
    ...(title ? { title } : {}),
    ...(asText(data.description) ? { description: asText(data.description) } : {}),
    ...(thumbnail ? { imageUrl: thumbnail.startsWith("data:") ? thumbnail : `data:image/jpeg;base64,${thumbnail}` } : {}),
  };
};

/** Cache de sessão (vive na aba). Guarda a promessa antes de começar: dez
 *  cartões do mesmo link montados no mesmo render dividem a mesma busca. Falha
 *  vira `null` cacheado — insistir na raspagem que acabou de falhar é pedir o
 *  mesmo 422 a cada mensagem. */
export const previewCache = new Map<string, Promise<LinkPreview | null>>();

export const cachedLinkPreview = (api: Pick<InboxApi, "linkPreview">, url: string): Promise<LinkPreview | null> => {
  const cached = previewCache.get(url);
  if (cached) return cached;
  const promise = api.linkPreview(url).catch(() => null);
  previewCache.set(url, promise);
  return promise;
};
