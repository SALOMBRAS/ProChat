import type { InboxMessage } from "../api/inbox.js";
// O formatador de tamanho já existe no espelho da policy; uma cópia só.
export { fileSizeLabel } from "./attachmentIntake.js";

/** Leitura do que o WhatsApp manda junto de uma mensagem de mídia.
 *
 *  O payload cru da WAHA chega inteiro como `metadata` (é o `payloadJson` que o
 *  leitor de mensagens devolve sem filtrar), e ele carrega campos que as colunas
 *  dedicadas não receberam. Medido na base de produção:
 *
 *  - `duration` está nula em 100% dos áudios e vídeos; `_data.duration` tem os
 *    segundos, como texto.
 *  - `media_size` está nula em 89 de 89 documentos; `_data.size` tem os bytes nos
 *    89.
 *  - `media_filename` existe em 1 de 89 documentos e em 35 de 105 imagens.
 *  - `_data.waveform` traz 64 amplitudes por nota de voz.
 *
 *  Nada aqui inventa campo: tudo é lido do que o backend já entrega. Preferir a
 *  coluna quando ela existe mantém o dia em que ela for preenchida como a fonte
 *  boa, e o payload como retaguarda.
 */
type WahaData = Record<string, unknown>;
export const wahaData = (message: Pick<InboxMessage, "metadata">): WahaData =>
  ((message.metadata as { _data?: WahaData } | undefined)?._data ?? {}) as WahaData;

const finite = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** A #57 promove `audio` para `ptt` só na entrada nova e diz, no próprio doc, que
 *  não houve backfill. As 114 notas já gravadas continuam com `messageType` igual
 *  a `audio` e a distinção só no payload. Ler `_data.type` aqui aplica a mesma
 *  regra do servidor às linhas que ficaram para trás — é exibição, não
 *  reclassificação: nada é regravado. */
export const isVoiceNote = (message: Pick<InboxMessage, "messageType" | "metadata">): boolean =>
  message.messageType === "ptt" || wahaData(message).type === "ptt";

export const mediaDuration = (message: Pick<InboxMessage, "duration" | "metadata">): number | undefined =>
  finite(message.duration) ?? finite(wahaData(message).duration);

export const mediaSize = (message: Pick<InboxMessage, "mediaSize" | "metadata">): number | undefined => {
  const data = wahaData(message);
  return finite(message.mediaSize) ?? finite(data.size) ?? finite(data.fileLength);
};

/** O WhatsApp usa `image`, `audio` e `video` como nome quando o remetente não deu
 *  um, e o próprio ChatPro cai em `attachment` no `sanitizeFilename` do servidor:
 *  são rótulos, não nomes de arquivo, e mostrá-los ao operador é pior que não
 *  mostrar nada. Visto na tela: um vídeo real exibindo "attachment · 0:35". */
const PLACEHOLDER_NAME = /^(image|imagem|audio|áudio|video|vídeo|file|arquivo|attachment|anexo|document|documento)(\.[a-z0-9]+)?$/i;
export const mediaFilename = (message: Pick<InboxMessage, "mediaFilename" | "metadata">): string | undefined => {
  const name = text(message.mediaFilename) ?? text(wahaData(message).filename);
  return name && !PLACEHOLDER_NAME.test(name) ? name : undefined;
};

/* ---------- Mídia que não existe mais ---------- */

/** Por que o carregamento falhou, do ponto de vista do operador.
 *
 *  `gone` é o arquivo que não volta: a WAHA guarda o arquivo por 180 s e o
 *  descarta, e a mensagem que não foi persistida nessa janela fica com registro,
 *  legenda e metadados — sem arquivo. O reprocessamento do histórico traz milhares
 *  assim. `transient` é todo o resto: rede caída, proxy fora do ar, formato que
 *  este navegador não toca. A diferença importa porque uma pede "tente de novo" e
 *  a outra não pede nada — insistir é perder tempo. */
export type MediaFailure = "gone" | "transient";
/** O proxy de mídia responde 404 `Media file not found` quando o arquivo não está
 *  no armazenamento nem na WAHA — medido na base de produção em 03/08/2026, com a
 *  resposta chegando em 0,1 s. Qualquer outro status é problema de agora. */
export const MEDIA_GONE_STATUS = 404;
export const mediaFailureFrom = (status?: number): MediaFailure => (status === MEDIA_GONE_STATUS ? "gone" : "transient");

/** Uma requisição `HEAD`, e só depois de o elemento já ter falhado: no caminho
 *  feliz não custa nada, e mesmo na falha não transfere o arquivo. Medido: 404 em
 *  0,1 s no que sumiu, 200 com zero byte no que está guardado.
 *
 *  Erro de rede conta como `transient`. Chamar de `gone` o que não se conseguiu
 *  nem perguntar seria afirmar uma perda que talvez não exista. */
export const probeMedia = async (url: string, fetchImpl: typeof fetch = fetch): Promise<MediaFailure> => {
  try {
    return mediaFailureFrom((await fetchImpl(url, { method: "HEAD" })).status);
  } catch {
    return "transient";
  }
};

/** Como chamar o que sumiu, na frase do operador. Figurinha não é "imagem" e nota
 *  de voz não é "arquivo de áudio" — o cartão fica errado se generalizar. */
export const mediaKindLabel = (message: Pick<InboxMessage, "messageType" | "metadata" | "mediaMimeType">): string => {
  if (message.messageType === "sticker") return "Figurinha";
  if (message.messageType === "image") return "Imagem";
  if (message.messageType === "video") return "Vídeo";
  if (isVoiceNote(message)) return "Mensagem de voz";
  if (message.messageType === "audio" || message.messageType === "ptt" || message.mediaMimeType?.startsWith("audio/")) return "Áudio";
  return "Documento";
};

export const WAVEFORM_BARS = 64;
/** As 64 amplitudes da nota de voz, normalizadas para 0–1.
 *
 *  Chega como objeto de chaves numéricas (`{"0": 0, "1": 27, …}`) e não como
 *  array — é assim que o JSON do WhatsApp atravessa a WAHA. A escala do protocolo
 *  é 0–100; dividir pelo maior valor quando ele passa de 100 evita que uma
 *  variação de escala corte o topo do desenho. */
export const voiceWaveform = (message: Pick<InboxMessage, "metadata">): number[] | undefined => {
  const raw = wahaData(message).waveform;
  if (!raw || typeof raw !== "object") return undefined;
  // `Object.keys` devolve chave de índice inteiro em ordem numérica crescente por
  // especificação, então "10" já vem depois de "2" sem ordenar nada aqui.
  const values = (Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>))
    .map((value) => finite(value) ?? 0);
  if (values.length < 8) return undefined;
  const ceiling = Math.max(100, ...values);
  return values.map((value) => Math.min(1, value / ceiling));
};

export const durationLabel = (seconds?: number): string => {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** Um documento é reconhecido pela extensão primeiro — é o que o operador vê no
 *  nome do arquivo — e, quando ela falta, pelo mime de retaguarda: medido na
 *  base real, 88 de 89 documentos sem `media_filename`, com o mime em
 *  `_data.mimetype` como o que salva. `tone` só escolhe a cor da etiqueta; o
 *  rótulo é o que o operador lê. */
const EXTENSION_KINDS: Record<string, { label: string; tone: string }> = {
  pdf: { label: "PDF", tone: "pdf" },
  txt: { label: "TXT", tone: "txt" }, log: { label: "TXT", tone: "txt" }, md: { label: "MD", tone: "txt" },
  json: { label: "JSON", tone: "code" }, xml: { label: "XML", tone: "code" },
  csv: { label: "CSV", tone: "xls" },
  svg: { label: "SVG", tone: "img" },
  doc: { label: "DOC", tone: "doc" }, docx: { label: "DOC", tone: "doc" }, odt: { label: "DOC", tone: "doc" }, rtf: { label: "DOC", tone: "doc" },
  xls: { label: "XLS", tone: "xls" }, xlsx: { label: "XLS", tone: "xls" }, ods: { label: "XLS", tone: "xls" },
  ppt: { label: "PPT", tone: "ppt" }, pptx: { label: "PPT", tone: "ppt" }, odp: { label: "PPT", tone: "ppt" },
  zip: { label: "ZIP", tone: "zip" }, rar: { label: "RAR", tone: "zip" }, "7z": { label: "7Z", tone: "zip" }, gz: { label: "ZIP", tone: "zip" }, tar: { label: "ZIP", tone: "zip" },
  apk: { label: "APK", tone: "app" },
  psd: { label: "PSD", tone: "design" }, ai: { label: "AI", tone: "design" }, fig: { label: "FIG", tone: "design" },
  epub: { label: "EPUB", tone: "book" },
  png: { label: "IMG", tone: "img" }, jpg: { label: "IMG", tone: "img" }, jpeg: { label: "IMG", tone: "img" }, webp: { label: "IMG", tone: "img" }, gif: { label: "IMG", tone: "img" },
};
const xmlMime = (mime: string) => mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml");
export const documentKind = (filename?: string | null, mimeType?: string | null): { label: string; tone: string } => {
  const extension = filename?.toLowerCase().split(".").pop() ?? "";
  const mime = (mimeType ?? "").toLowerCase();
  if (extension && EXTENSION_KINDS[extension]) return EXTENSION_KINDS[extension];
  if (mime.includes("pdf")) return { label: "PDF", tone: "pdf" };
  if (mime.includes("wordprocessing") || mime === "application/msword") return { label: "DOC", tone: "doc" };
  if (mime.includes("spreadsheet") || mime === "application/vnd.ms-excel") return { label: "XLS", tone: "xls" };
  if (mime.includes("presentation") || mime === "application/vnd.ms-powerpoint") return { label: "PPT", tone: "ppt" };
  if (mime === "text/csv") return { label: "CSV", tone: "xls" };
  if (mime === "text/markdown") return { label: "MD", tone: "txt" };
  if (mime.includes("json")) return { label: "JSON", tone: "code" };
  // svg antes do xmlMime: 'image/svg+xml' também termina em '+xml'.
  if (mime === "image/svg+xml") return { label: "SVG", tone: "img" };
  if (xmlMime(mime)) return { label: "XML", tone: "code" };
  if (mime.includes("rar")) return { label: "RAR", tone: "zip" };
  if (mime.includes("7z")) return { label: "7Z", tone: "zip" };
  // epub antes do includes("zip"): 'application/epub+zip' contém "zip".
  if (mime === "application/epub+zip") return { label: "EPUB", tone: "book" };
  if (mime.includes("zip")) return { label: "ZIP", tone: "zip" };
  if (mime === "application/vnd.android.package-archive") return { label: "APK", tone: "app" };
  if (mime.includes("photoshop")) return { label: "PSD", tone: "design" };
  if (mime === "application/postscript") return { label: "AI", tone: "design" };
  if (mime.startsWith("text/")) return { label: "TXT", tone: "txt" };
  // Mídia mandada como documento acontece: o exemplo real na base é um
  // `document` com `_data.mimetype = image/jpeg`.
  if (mime.startsWith("image/")) return { label: "IMG", tone: "img" };
  if (mime.startsWith("audio/")) return { label: "AUD", tone: "aud" };
  if (mime.startsWith("video/")) return { label: "VID", tone: "vid" };
  return { label: "ARQ", tone: "file" };
};

/** A primeira página de um PDF, por exemplo — em base64, na mesma forma da
 *  miniatura de localização. Só recebidos a trazem (`_data.thumbnail`). */
export const documentThumbnail = (message: Pick<InboxMessage, "metadata">): string | undefined => {
  const thumbnail = text(wahaData(message).thumbnail);
  if (!thumbnail) return undefined;
  return thumbnail.startsWith("data:") ? thumbnail : `data:image/jpeg;base64,${thumbnail}`;
};

const BROWSER_OPENABLE_EXTENSIONS = ["pdf", "txt", "md", "json", "xml", "svg", "csv", "log"];
/** O que o navegador abre direto numa aba. `xmlMime` compara por igualdade ou
 *  sufixo `+xml` — `includes("xml")` pegaria `vnd.openxmlformats-officedocument`,
 *  e planilha não abre em aba. */
export const browserOpenable = (filename?: string | null, mimeType?: string | null): boolean => {
  const extension = filename?.toLowerCase().split(".").pop() ?? "";
  if (BROWSER_OPENABLE_EXTENSIONS.includes(extension)) return true;
  const mime = (mimeType ?? "").toLowerCase();
  return mime === "application/pdf" || mime === "image/svg+xml" || mime.startsWith("text/") || mime.includes("json") || xmlMime(mime);
};

const TEXT_PREVIEWABLE_EXTENSIONS = ["md", "txt", "json", "xml", "csv", "log"];
/** Subconjunto texto do abrível: PDF e SVG o navegador renderiza melhor que um
 *  `<pre>`. */
export const textPreviewable = (filename?: string | null, mimeType?: string | null): boolean => {
  const extension = filename?.toLowerCase().split(".").pop() ?? "";
  if (TEXT_PREVIEWABLE_EXTENSIONS.includes(extension)) return true;
  const mime = (mimeType ?? "").toLowerCase();
  return mime.startsWith("text/") || mime.includes("json") || xmlMime(mime);
};

export const TEXT_PREVIEW_LIMIT = 200 * 1024;
/** JSON que parseia ganha indentação; JSON quebrado mostra cru — truncado não é
 *  JSON. Acima do teto: corta e avisa. */
export const formatTextPreview = (raw: string, mimeType?: string | null, filename?: string | null): string => {
  const mime = (mimeType ?? "").toLowerCase();
  const extension = filename?.toLowerCase().split(".").pop() ?? "";
  let body = raw;
  if (mime.includes("json") || extension === "json") {
    try { body = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* cru mesmo */ }
  }
  if (body.length > TEXT_PREVIEW_LIMIT) body = `${body.slice(0, TEXT_PREVIEW_LIMIT)}\n…\n(Conteúdo truncado. Baixe o arquivo para ver inteiro.)`;
  return body;
};

/** Download com barra. A URL assinada pode não liberar CORS para `fetch` — aí a
 *  promessa rejeita e quem chamou cai na âncora nativa, que sempre funcionou. */
export const downloadWithProgress = async (
  url: string,
  expectedSize: number | undefined,
  onProgress: (percent: number | null) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob> => {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  const total = Number(response.headers.get("content-length")) || expectedSize || 0;
  if (!response.body) { onProgress(null); return response.blob(); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null);
  }
  return new Blob(chunks as BlobPart[], { type: response.headers.get("content-type") ?? undefined });
};

export type ContactCard = { fullName?: string; phoneNumber?: string; organization?: string };
/** O cartão de contato chega de duas formas, e só uma delas estava sendo lida.
 *
 *  - enviado por nós: `metadata.contacts` já é uma lista de `ContactCard`,
 *    montada por internal-inbox.service.ts:41;
 *  - recebido do WhatsApp: `metadata` é o payload cru, e o cartão vem na RAIZ em
 *    `vCards` — uma lista de STRINGS no formato vCard, não de objetos. Medido: os
 *    6 cartões da base têm `vCards` com exatamente um item, e `_data.body` repete
 *    a mesma string.
 *
 *  Sem esta segunda leitura, classificar a mensagem como `contact` deixaria o
 *  cartão vazio — `contacts` não existe em payload recebido —, e o componente
 *  cairia no rótulo de retaguarda exibindo o texto cru do vCard. Pior quando o
 *  vCard traz `PHOTO;BASE64:`, o que acontece em um dos seis: aí o "texto" é
 *  outro bloco de base64, o mesmo sintoma que a localização produzia. */
const VCARD_TEL = /^(?:item\d+\.)?TEL(?:;[^:]*)?:/i;
const VCARD_WAID = /waid=([\d+]+)/i;
export const parseVcard = (raw: string): ContactCard | undefined => {
  if (!/^BEGIN:VCARD/im.test(raw)) return undefined;
  // Linha dobrada do vCard continua na seguinte, começando por espaço ou tab.
  const lines = raw.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const valueOf = (prefix: RegExp) => lines.find((line) => prefix.test(line))?.replace(prefix, "").trim();
  const telLine = lines.find((line) => VCARD_TEL.test(line));
  // `waid` é o identificador do WhatsApp, só dígitos, e é o que serve para
  // procurar no CRM; o valor depois dos dois pontos vem formatado à moda do
  // aparelho que exportou. Preferir o primeiro e cair no segundo.
  const phoneNumber = telLine?.match(VCARD_WAID)?.[1] ?? telLine?.replace(VCARD_TEL, "").trim();
  const fullName = valueOf(/^FN:/i) ?? valueOf(/^X-WA-BIZ-NAME:/i);
  const organization = valueOf(/^ORG:/i)?.replace(/;+$/, "");
  if (!fullName && !phoneNumber) return undefined;
  return { fullName: fullName || undefined, phoneNumber: phoneNumber || undefined, organization: organization || undefined };
};
export const contactCards = (message: Pick<InboxMessage, "metadata">): ContactCard[] => {
  const sent = (message.metadata as { contacts?: ContactCard[] } | undefined)?.contacts;
  if (sent?.length) return sent;
  const received = (message.metadata as { vCards?: unknown } | undefined)?.vCards;
  if (!Array.isArray(received)) return [];
  return received
    .filter((card): card is string => typeof card === "string")
    .map(parseVcard)
    .filter((card): card is ContactCard => Boolean(card));
};

/** Só dígitos e um `+` inicial: é o que serve para `tel:` e para procurar no CRM. */
export const phoneDigits = (value?: string | null) => (value ?? "").replace(/(?!^\+)[^\d]/g, "");
/** Telefone brasileiro legível. Fora do padrão de 12–13 dígitos com 55, devolve o
 *  que veio: inventar formato para número estrangeiro deixaria pior. */
export const phoneDisplay = (value?: string | null): string => {
  const digits = phoneDigits(value).replace(/^\+/, "");
  const local = digits.startsWith("55") ? digits.slice(2) : "";
  if (local.length === 11) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return value?.trim() || "Sem telefone";
};

/** O corpo guardado de uma localização é o título, e o de um cartão de contato é o
 *  nome — os mesmos textos que o cartão já mostra em destaque. Renderizar os dois
 *  põe a mesma frase duas vezes, uma dentro do cartão e outra logo abaixo.
 *
 *  No cartão RECEBIDO o corpo não é o nome: é o vCard inteiro, texto cru que o
 *  WEBJS copia para `body`. Ele nunca deve aparecer — e num dos seis cartões da
 *  base ele carrega um `PHOTO;BASE64:` de milhares de caracteres. */
export const bodyRepeatsCard = (message: Pick<InboxMessage, "messageType" | "content" | "metadata">): boolean => {
  const body = message.content?.trim();
  if (message.messageType === "contact" && /^BEGIN:VCARD/i.test(body ?? "")) return true;
  if (!body) return false;
  if (message.messageType === "location") {
    const title = (message.metadata as { location?: { title?: string; name?: string } } | undefined)?.location;
    return body === title?.title?.trim() || body === title?.name?.trim();
  }
  if (message.messageType !== "contact") return false;
  const cards = contactCards(message);
  if (!cards.length) return false;
  const single = cards[0]?.fullName?.trim();
  return body === single || body === `${single} e mais ${cards.length - 1}`;
};

/** Lê o ponto das duas origens, que não têm a mesma forma:
 *
 *  - enviada por nós: `metadata.location = { latitude, longitude, title }`, montado
 *    por internal-inbox.service;
 *  - recebida do WhatsApp: `metadata` é o payload cru, e o ponto vem em
 *    `location` com `name`, `address`, `description` e `thumbnail` além das
 *    coordenadas. Medido em duas mensagens reais da base.
 *
 *  `title` e `name` são o mesmo campo com nomes diferentes de cada lado — quem só
 *  lê `title` mostra coordenadas nuas para um lugar que veio nomeado. */
export const locationOf = (metadata: unknown) => {
  const point = (metadata as { location?: Record<string, unknown> } | undefined)?.location;
  if (!point) return undefined;
  const latitude = Number(point.latitude), longitude = Number(point.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const thumbnail = text(point.thumbnail);
  return {
    latitude, longitude,
    title: text(point.title) ?? text(point.name),
    address: text(point.address),
    // O WhatsApp já manda a miniatura embutida em base64: dá para mostrar o mapa
    // sem chave de API e sem terceiro no caminho.
    thumbnail: thumbnail && !thumbnail.startsWith("data:") ? `data:image/jpeg;base64,${thumbnail}` : thumbnail,
    live: point.live === true,
  };
};
export const mapsUrl = (latitude: number, longitude: number) => `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
export const coordinatesLabel = (latitude: number, longitude: number) => `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
