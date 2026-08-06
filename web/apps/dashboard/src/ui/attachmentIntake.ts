/** Entrada de anexo que não passa pelo menu "+": colar e arrastar.
 *
 *  Os dois chegam pelo mesmo objeto — `event.clipboardData` e `event.dataTransfer`
 *  são ambos `DataTransfer` —, então leitura, validação e mensagens são as mesmas.
 *  O que muda é só quem dispara.
 *
 *  A validação aqui é uma cópia deliberada da do servidor (`policy` e
 *  `magicMatches` em attachment-outbox.service.ts). Não dá para importar: é outro
 *  workspace. Repetir vale porque recusar antes de subir 8 MB de print é a
 *  diferença entre "formato não aceito" na hora e um 415 depois da espera.
 */

/** Espelho de `policy`. Ultrapassar não corrompe nada — a API responde 413 e o
 *  job nem é criado —, mas o operador só descobre depois do upload. `document`
 *  é o coringa: `mimes` vazio documenta que qualquer arquivo serve, como no
 *  WhatsApp — a recusa por formato sumiu daqui e do servidor. */
export const ATTACHMENT_POLICY = {
  image: { mimes: ["image/jpeg", "image/png", "image/webp"], max: 15 * 1024 * 1024 },
  audio: { mimes: ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm"], max: 25 * 1024 * 1024 },
  video: { mimes: ["video/mp4", "video/webm"], max: 50 * 1024 * 1024 },
  document: { mimes: [] as readonly string[], max: 50 * 1024 * 1024 },
} as const;
export type AttachmentKind = keyof typeof ATTACHMENT_POLICY;

const KIND_LABEL: Record<AttachmentKind, string> = { image: "imagem", audio: "áudio", video: "vídeo", document: "documento" };
export const ACCEPTED_SUMMARY = "imagem JPEG, PNG ou WebP até 15 MB, áudio até 25 MB, vídeo MP4 ou WebM até 50 MB e qualquer documento até 50 MB";

/** `image/png;charset=binary` e `IMAGE/PNG` são o mesmo tipo para a allowlist. */
export const normalizeMime = (mime?: string | null) => (mime ?? "").split(";", 1)[0].trim().toLowerCase();
/** Sempre retorna: procura só em imagem/áudio/vídeo; o resto é documento. */
export const attachmentKind = (mime?: string | null): AttachmentKind => {
  const normalized = normalizeMime(mime);
  return (["image", "audio", "video"] as const).find((kind) => (ATTACHMENT_POLICY[kind].mimes as readonly string[]).includes(normalized)) ?? "document";
};

export const fileSizeLabel = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / 1024 ** index).toFixed(index === 1 ? 0 : 1)} ${units[index - 1]}`;
};

const ascii = (head: Uint8Array, from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
const opens = (head: Uint8Array, bytes: number[]) => bytes.every((byte, index) => head[index] === byte);

/** Espelho de `magicMatches`. O tipo que o navegador declara vem da extensão do
 *  arquivo quando ele sai do gerenciador de arquivos, então um `.png` que na
 *  verdade é PDF chega aqui declarando `image/png` — e o servidor recusa com 400
 *  depois do upload inteiro. Assinatura conhecida é conferida; desconhecida
 *  passa. */
export const magicMatches = (mime: string, head: Uint8Array): boolean => {
  const normalized = normalizeMime(mime);
  if (normalized === "image/jpeg") return opens(head, [0xff, 0xd8, 0xff]);
  if (normalized === "image/png") return opens(head, [137, 80, 78, 71, 13, 10, 26, 10]);
  if (normalized === "image/webp") return ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP";
  if (normalized === "audio/ogg") return ascii(head, 0, 4) === "OggS";
  if (normalized === "audio/mpeg") return ascii(head, 0, 3) === "ID3" || head[0] === 0xff;
  if (normalized === "audio/mp4" || normalized === "video/mp4") return ascii(head, 4, 8) === "ftyp";
  if (normalized === "audio/webm" || normalized === "video/webm") return opens(head, [0x1a, 0x45, 0xdf, 0xa3]);
  if (normalized === "application/pdf") return ascii(head, 0, 5) === "%PDF-";
  if (normalized === "application/zip" || normalized === "application/x-zip-compressed" || normalized === "application/vnd.android.package-archive" || normalized === "application/epub+zip" || normalized.includes("openxmlformats")) return opens(head, [0x50, 0x4b]);
  if (normalized === "application/vnd.rar" || normalized === "application/x-rar-compressed") return ascii(head, 0, 6) === "Rar!\x1a\x07";
  if (normalized === "application/x-7z-compressed") return opens(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  if (normalized === "image/vnd.adobe.photoshop" || normalized === "application/x-photoshop" || normalized === "application/photoshop") return ascii(head, 0, 4) === "8BPS";
  if (normalized === "application/msword" || normalized === "application/vnd.ms-excel" || normalized === "application/vnd.ms-powerpoint") return opens(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (normalized === "application/postscript") return ascii(head, 0, 4) === "%!PS" || ascii(head, 0, 5) === "%PDF-";
  // O servidor procura o byte zero nos primeiros 8 KB; aqui só nos 4 KB lidos.
  // Ler menos é permissivo a mais, nunca a menos: o que escapar daqui o servidor
  // ainda pega.
  if (normalized.startsWith("text/") || normalized.includes("json") || normalized.includes("xml")) return !head.includes(0);
  return true;
};

export const HEAD_BYTES = 4096;
/** `Blob.arrayBuffer()` não existe em Safari antigo nem no jsdom; `FileReader`
 *  existe nos dois. Lê só a cabeça: o resto do arquivo não interessa. */
export const readHead = (file: Blob, bytes = HEAD_BYTES) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("leitura falhou"));
    reader.readAsArrayBuffer(file.slice(0, bytes));
  });

export type TransferIntake = {
  /** Arquivos com tipo que o composer envia, na ordem em que vieram. */
  accepted: File[];
  /** Tipos recusados, sem repetição, só para a mensagem. */
  rejected: string[];
  /** Veio `<img>` no HTML e nenhum arquivo: imagem copiada de página. */
  imageWithoutFile: boolean;
  text: string;
};

/** `files` e `items` descrevem a mesma coisa em navegadores diferentes: no print
 *  de tela o Chrome preenche os dois, o Safari antigo só `items`. Somar os dois
 *  duplicaria o anexo, então `files` tem precedência e `items` é a retaguarda. */
const transferFiles = (data: DataTransfer): File[] => {
  if (data.files?.length) return Array.from(data.files);
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
};

export const readTransfer = (data: DataTransfer | null | undefined): TransferIntake => {
  if (!data) return { accepted: [], rejected: [], imageWithoutFile: false, text: "" };
  const files = transferFiles(data);
  // Recusa agora é só de tamanho, arquivo vazio ou bytes mentirosos — e acontece
  // no `acceptAttachment`, arquivo a arquivo. `rejected` fica de molho para a
  // mensagem de formato antiga não reaparecer por engano.
  const accepted = files;
  const rejected: string[] = [];
  const read = (format: string) => { try { return data.getData?.(format) ?? ""; } catch { return ""; } };
  // Só olha o HTML quando não veio arquivo nenhum: com arquivo, o HTML é só a
  // moldura da mesma imagem e não muda decisão nenhuma.
  const html = files.length ? "" : read("text/html");
  return {
    accepted,
    rejected,
    // Detecta a marca, e só. A URL não é lida nem buscada de propósito — ver
    // `HTML_IMAGE_ONLY_MESSAGE`.
    imageWithoutFile: /<img[\s/>]/i.test(html),
    text: read("text/plain"),
  };
};

export type IntakeVerdict =
  | { ok: true; kind: AttachmentKind; file: File }
  | { ok: false; reason: "size" | "empty" | "bytes"; kind?: AttachmentKind };

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/webm": "weba",
  "video/mp4": "mp4", "video/webm": "webm", "application/pdf": "pdf", "text/plain": "txt",
};
/** Print de tela colado às vezes chega sem nome. O servidor sanitiza e cairia em
 *  `attachment`, que não diz nada ao contato que baixa. */
export const intakeName = (file: File, at: number) =>
  file.name?.trim() ? file.name : `colada-${at}.${EXTENSION[normalizeMime(file.type)] ?? "bin"}`;

export const acceptAttachment = async (file: File, at = 0): Promise<IntakeVerdict> => {
  const kind = attachmentKind(file.type);
  if (!file.size) return { ok: false, reason: "empty", kind };
  if (file.size > ATTACHMENT_POLICY[kind].max) return { ok: false, reason: "size", kind };
  let head: Uint8Array;
  try { head = await readHead(file); } catch { return { ok: false, reason: "bytes", kind }; }
  if (!magicMatches(file.type, head)) return { ok: false, reason: "bytes", kind };
  const name = intakeName(file, at);
  return { ok: true, kind, file: name === file.name ? file : new File([file], name, { type: file.type }) };
};

/** Buscar a URL foi descartado, e não por preguiça: o `src` de um HTML colado é
 *  conteúdo de terceiro, e ir atrás dele transformaria uma colagem numa requisição
 *  do navegador do operador para um endereço que ele não escolheu. Sem CORS a
 *  resposta é opaca e nem dá para validar; com CORS, o que volta pode não ser
 *  imagem. A saída honesta é dizer o que houve e o que fazer. */
export const HTML_IMAGE_ONLY_MESSAGE =
  "A imagem veio da página como link, sem o arquivo. Salve a imagem no computador e cole ou arraste o arquivo.";

/** O composer guarda um anexo pendente e o envio cria um job por arquivo, com um
 *  `clientRequestId` cada. Anexar vários exigiria fila, vários cartões e envio
 *  parcial — trabalho próprio. Pegar o primeiro e dizer que pegou é melhor do que
 *  descartar em silêncio. */
export const extraFilesMessage = (total: number) =>
  `De ${total} arquivos, só o primeiro foi anexado: o composer envia um anexo por vez.`;

export const rejectedMessage = (mimes: string[]) => {
  const label = mimes.filter(Boolean).join(", ") || "tipo não identificado";
  return `Formato não aceito: ${label}. O envio aceita ${ACCEPTED_SUMMARY}.`;
};

export const verdictMessage = (verdict: Extract<IntakeVerdict, { ok: false }>, file: File): string => {
  if (verdict.reason === "empty") return "O arquivo está vazio.";
  if (verdict.reason === "size")
    return `O arquivo tem ${fileSizeLabel(file.size)} e o limite para ${KIND_LABEL[verdict.kind!]} é ${fileSizeLabel(ATTACHMENT_POLICY[verdict.kind!].max)}.`;
  return `O conteúdo não corresponde a ${normalizeMime(file.type) || "um tipo conhecido"}. O arquivo pode estar corrompido ou com a extensão trocada.`;
};
