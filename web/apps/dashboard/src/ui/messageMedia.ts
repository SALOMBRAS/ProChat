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

/** Um documento é reconhecido pela extensão e, quando ela falta, pelo mime — que a
 *  coluna também não traz, mas `_data.mimetype` traz. `tone` só escolhe a cor da
 *  etiqueta; o rótulo é o que o operador lê. */
export const documentKind = (filename?: string | null, mimeType?: string | null): { label: string; tone: string } => {
  const extension = filename?.split(".").pop()?.toLowerCase() ?? "";
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.includes("pdf") || extension === "pdf") return { label: "PDF", tone: "pdf" };
  if (["doc", "docx", "odt", "rtf"].includes(extension) || mime.includes("wordprocessing")) return { label: "DOC", tone: "doc" };
  if (["xls", "xlsx", "csv", "ods"].includes(extension) || mime.includes("spreadsheet")) return { label: "XLS", tone: "xls" };
  if (["ppt", "pptx", "odp"].includes(extension) || mime.includes("presentation")) return { label: "PPT", tone: "ppt" };
  if (["zip", "rar", "7z", "gz", "tar"].includes(extension) || mime.includes("zip")) return { label: "ZIP", tone: "zip" };
  if (["txt", "log", "md"].includes(extension) || mime.startsWith("text/")) return { label: "TXT", tone: "txt" };
  // Mídia mandada como documento acontece: o exemplo real na base é um
  // `document` com `_data.mimetype = image/jpeg`.
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) return { label: "IMG", tone: "img" };
  if (mime.startsWith("audio/")) return { label: "AUD", tone: "aud" };
  if (mime.startsWith("video/")) return { label: "VID", tone: "vid" };
  return { label: "ARQ", tone: "file" };
};

export type ContactCard = { fullName?: string; phoneNumber?: string; organization?: string };
export const contactCards = (message: Pick<InboxMessage, "metadata">): ContactCard[] =>
  (message.metadata as { contacts?: ContactCard[] } | undefined)?.contacts ?? [];

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
 *  põe a mesma frase duas vezes, uma dentro do cartão e outra logo abaixo. */
export const bodyRepeatsCard = (message: Pick<InboxMessage, "messageType" | "content" | "metadata">): boolean => {
  const body = message.content?.trim();
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
