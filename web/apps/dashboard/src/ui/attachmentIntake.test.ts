import { describe, expect, it } from "vitest";
import {
  ACCEPTED_SUMMARY,
  ATTACHMENT_POLICY,
  HTML_IMAGE_ONLY_MESSAGE,
  acceptAttachment,
  attachmentKind,
  extraFilesMessage,
  fileSizeLabel,
  intakeName,
  magicMatches,
  normalizeMime,
  readHead,
  readTransfer,
  rejectedMessage,
  verdictMessage,
} from "./attachmentIntake.js";

/**
 * Leitura e validação do que chega por colar ou arrastar. As duas entradas usam o
 * mesmo `DataTransfer`, então tudo aqui vale para as duas.
 *
 * A allowlist e os magic bytes são cópia da validação do servidor (`policy` e
 * `magicMatches` em attachment-outbox.service.ts): estes testes prendem a cópia
 * ao original.
 */
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const WEBP = [...[0x52, 0x49, 0x46, 0x46], 0, 0, 0, 0, ...[0x57, 0x45, 0x42, 0x50]];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const bytes = (values: number[], pad = 0) => new Uint8Array([...values, ...new Array(pad).fill(0x41)]);
const file = (name: string, type: string, content: number[] = JPEG) => new File([new Uint8Array(content)], name, { type });
const sized = (source: File, size: number) => { Object.defineProperty(source, "size", { value: size }); return source; };

const transfer = (options: { files?: File[]; items?: { kind: string; getAsFile: () => File | null }[]; text?: string; html?: string }) => ({
  files: options.files ?? [],
  items: options.items ?? [],
  getData: (format: string) => (format === "text/plain" ? options.text ?? "" : format === "text/html" ? options.html ?? "" : ""),
}) as unknown as DataTransfer;

describe("allowlist espelhada", () => {
  it("classifica cada tipo aceito pelo servidor", () => {
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("audio/ogg")).toBe("audio");
    expect(attachmentKind("video/mp4")).toBe("video");
    expect(attachmentKind("application/pdf")).toBe("document");
  });

  it("recusa o que o servidor recusaria com 415", () => {
    // HEIC do iPhone, GIF e SVG não estão na allowlist.
    expect(attachmentKind("image/heic")).toBeUndefined();
    expect(attachmentKind("image/gif")).toBeUndefined();
    expect(attachmentKind("image/svg+xml")).toBeUndefined();
    expect(attachmentKind("")).toBeUndefined();
    expect(attachmentKind(undefined)).toBeUndefined();
  });

  it("normaliza parâmetro e caixa antes de comparar", () => {
    expect(normalizeMime("IMAGE/PNG")).toBe("image/png");
    expect(attachmentKind("text/plain;charset=utf-8")).toBe("document");
  });

  it("mantém os limites de cada família", () => {
    expect(ATTACHMENT_POLICY.image.max).toBe(15 * 1024 * 1024);
    expect(ATTACHMENT_POLICY.video.max).toBe(50 * 1024 * 1024);
    expect(ATTACHMENT_POLICY.audio.max).toBe(25 * 1024 * 1024);
    expect(ATTACHMENT_POLICY.document.max).toBe(25 * 1024 * 1024);
  });
});

describe("magic bytes", () => {
  it.each([
    ["image/jpeg", JPEG],
    ["image/png", PNG],
    ["image/webp", WEBP],
    ["application/pdf", PDF],
    ["audio/ogg", [0x4f, 0x67, 0x67, 0x53]],
    ["video/webm", [0x1a, 0x45, 0xdf, 0xa3]],
    ["video/mp4", [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", [0x50, 0x4b, 3, 4]],
  ])("reconhece %s", (mime, head) => {
    expect(magicMatches(mime, bytes(head))).toBe(true);
  });

  it("pega o arquivo que mente sobre o próprio tipo", () => {
    // O navegador deriva o tipo da extensão quando o arquivo vem do gerenciador:
    // um .png que é PDF chega declarando image/png e o servidor responde 400
    // depois do upload inteiro.
    expect(magicMatches("image/png", bytes(PDF))).toBe(false);
    expect(magicMatches("image/jpeg", bytes(PNG))).toBe(false);
    expect(magicMatches("image/webp", bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBe(false);
  });

  it("texto é texto enquanto não tiver byte zero", () => {
    expect(magicMatches("text/plain", bytes([0x6f, 0x69]))).toBe(true);
    expect(magicMatches("text/plain", bytes([0x6f, 0x00, 0x69]))).toBe(false);
  });

  it("não inventa formato fora da allowlist", () => {
    expect(magicMatches("image/gif", bytes([0x47, 0x49, 0x46, 0x38]))).toBe(false);
  });
});

describe("leitura do DataTransfer", () => {
  it("prefere files e não soma items, que descrevem o mesmo arquivo", () => {
    // O Chrome preenche os dois num print de tela; somar duplicaria o anexo.
    const print = file("image.png", "image/png", PNG);
    const intake = readTransfer(transfer({ files: [print], items: [{ kind: "file", getAsFile: () => print }] }));
    expect(intake.accepted).toHaveLength(1);
  });

  it("cai em items quando o navegador não preenche files", () => {
    const print = file("image.png", "image/png", PNG);
    expect(readTransfer(transfer({ items: [{ kind: "file", getAsFile: () => print }] })).accepted).toEqual([print]);
  });

  it("ignora item que não é arquivo", () => {
    expect(readTransfer(transfer({ items: [{ kind: "string", getAsFile: () => null }], text: "oi" })).accepted).toHaveLength(0);
  });

  it("separa o que a allowlist recusa, sem repetir o tipo", () => {
    const intake = readTransfer(transfer({ files: [file("a.gif", "image/gif"), file("b.gif", "image/gif"), file("c.png", "image/png", PNG)] }));
    expect(intake.accepted.map((item) => item.name)).toEqual(["c.png"]);
    expect(intake.rejected).toEqual(["image/gif"]);
  });

  it("detecta imagem que veio só como marcação da página", () => {
    const intake = readTransfer(transfer({ html: '<meta charset="utf-8"><img src="https://exemplo.test/a.png">' }));
    expect(intake.imageWithoutFile).toBe(true);
    expect(intake.accepted).toHaveLength(0);
  });

  it("não olha o HTML quando veio arquivo: com arquivo o HTML é só a moldura", () => {
    const intake = readTransfer(transfer({ files: [file("a.png", "image/png", PNG)], html: "<img src='x'>" }));
    expect(intake.imageWithoutFile).toBe(false);
  });

  it("devolve o texto puro para a colagem normal seguir", () => {
    const intake = readTransfer(transfer({ text: "bom dia" }));
    expect(intake).toMatchObject({ accepted: [], rejected: [], imageWithoutFile: false, text: "bom dia" });
  });

  it("sobrevive a transfer ausente ou a getData que explode", () => {
    expect(readTransfer(null).accepted).toHaveLength(0);
    const hostil = { files: [], items: [], getData: () => { throw new Error("bloqueado"); } } as unknown as DataTransfer;
    expect(readTransfer(hostil).text).toBe("");
  });
});

describe("aceitação do arquivo", () => {
  it("lê só a cabeça do arquivo", async () => {
    const head = await readHead(new File([new Uint8Array(9000)], "g.bin"), 16);
    expect(head).toHaveLength(16);
  });

  it("aceita imagem válida e mantém o nome que ela já tinha", async () => {
    const verdict = await acceptAttachment(file("print.png", "image/png", PNG), 123);
    expect(verdict).toMatchObject({ ok: true, kind: "image" });
    expect((verdict as { file: File }).file.name).toBe("print.png");
  });

  it("dá nome a print de tela que chega sem nome", async () => {
    const verdict = await acceptAttachment(new File([new Uint8Array(PNG)], "", { type: "image/png" }), 777);
    expect((verdict as { file: File }).file.name).toBe("colada-777.png");
    expect((verdict as { file: File }).file.type).toBe("image/png");
  });

  it("recusa tipo fora da allowlist antes de ler byte nenhum", async () => {
    expect(await acceptAttachment(file("a.gif", "image/gif"))).toEqual({ ok: false, reason: "type" });
  });

  it("recusa acima do limite da família", async () => {
    const grande = sized(file("print.png", "image/png", PNG), ATTACHMENT_POLICY.image.max + 1);
    expect(await acceptAttachment(grande)).toMatchObject({ ok: false, reason: "size", kind: "image" });
  });

  it("recusa arquivo vazio", async () => {
    expect(await acceptAttachment(new File([], "vazio.png", { type: "image/png" }))).toMatchObject({ ok: false, reason: "empty" });
  });

  it("recusa quando os bytes desmentem o tipo declarado", async () => {
    expect(await acceptAttachment(file("mentira.png", "image/png", PDF))).toMatchObject({ ok: false, reason: "bytes", kind: "image" });
  });

  it("aceita vídeo e documento pelo mesmo caminho", async () => {
    expect(await acceptAttachment(file("c.pdf", "application/pdf", PDF))).toMatchObject({ ok: true, kind: "document" });
    expect(await acceptAttachment(file("v.webm", "video/webm", [0x1a, 0x45, 0xdf, 0xa3]))).toMatchObject({ ok: true, kind: "video" });
  });
});

describe("mensagens", () => {
  it("nomeia o formato recusado e diz o que serve", () => {
    const message = rejectedMessage(["image/gif"]);
    expect(message).toContain("image/gif");
    expect(message).toContain(ACCEPTED_SUMMARY);
  });

  it("não deixa recusa sem tipo virar frase truncada", () => {
    expect(rejectedMessage([""])).toContain("tipo não identificado");
  });

  it("diz o tamanho medido e o limite, não só que falhou", () => {
    const grande = sized(file("print.png", "image/png", PNG), 20 * 1024 * 1024);
    const message = verdictMessage({ ok: false, reason: "size", kind: "image" }, grande);
    expect(message).toContain("20.0 MB");
    expect(message).toContain("15.0 MB");
  });

  it("explica a extensão trocada em vez de dizer só inválido", () => {
    expect(verdictMessage({ ok: false, reason: "bytes", kind: "image" }, file("m.png", "image/png", PDF))).toMatch(/extens(ã|a)o trocada/);
  });

  it("avisa quantos arquivos ficaram de fora", () => {
    expect(extraFilesMessage(3)).toContain("3");
    expect(extraFilesMessage(3)).toMatch(/um anexo por vez/);
  });

  it("a imagem sem arquivo diz o que fazer, não só que não deu", () => {
    expect(HTML_IMAGE_ONLY_MESSAGE).toMatch(/salve a imagem/i);
    expect(HTML_IMAGE_ONLY_MESSAGE).toMatch(/cole ou arraste/i);
  });

  it("formata tamanho de arquivo", () => {
    expect(fileSizeLabel(512)).toBe("512 B");
    expect(fileSizeLabel(2048)).toBe("2 KB");
    // MB sempre com uma casa: o formatador veio de Inbox.tsx sem alteração, e o
    // cartão do anexo pendente já mostra assim.
    expect(fileSizeLabel(15 * 1024 * 1024)).toBe("15.0 MB");
  });

  it("dá nome só quando falta", () => {
    expect(intakeName(file("a.png", "image/png"), 5)).toBe("a.png");
    expect(intakeName(new File([], "  ", { type: "image/jpeg" }), 5)).toBe("colada-5.jpg");
    expect(intakeName(new File([], "", { type: "application/zip" }), 5)).toBe("colada-5.bin");
  });
});
