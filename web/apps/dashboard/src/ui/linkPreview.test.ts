import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedLinkPreview,
  domainFromUrl,
  findUrls,
  MAX_URLS,
  nativeLinkPreview,
  previewCache,
  providerFromUrl,
  trimUrl,
} from "./linkPreview.js";

/** Leitores puros do texto e do payload. Nada aqui toca na rede — a única
 *  promessa é a do `cachedLinkPreview`, com a API stubada. */

describe("findUrls", () => {
  it("extrai as URLs do texto na ordem", () => {
    expect(findUrls("olha https://example.com/a e depois http://example.com/b")).toEqual(["https://example.com/a", "http://example.com/b"]);
  });

  it("apara a pontuação da frase que gruda na URL", () => {
    expect(findUrls("vi https://example.com/materia, gostou?")).toEqual(["https://example.com/materia"]);
    expect(trimUrl("https://example.com/a...")).toBe("https://example.com/a");
    expect(trimUrl("https://example.com/a!")).toBe("https://example.com/a");
  });

  it("tira o parêntese excedente e mantém o balanceado, estilo Wikipédia", () => {
    expect(trimUrl("https://example.com/a)")).toBe("https://example.com/a");
    expect(findUrls("veja (https://example.com/a) depois")).toEqual(["https://example.com/a"]);
    expect(findUrls("https://pt.wikipedia.org/wiki/Arara_(ave)")).toEqual(["https://pt.wikipedia.org/wiki/Arara_(ave)"]);
  });

  it("não repete URL e para no teto de 32", () => {
    expect(findUrls("https://a.example/ https://a.example/")).toEqual(["https://a.example/"]);
    const texto = Array.from({ length: MAX_URLS + 5 }, (_, index) => `https://example.com/${index}`).join(" ");
    expect(findUrls(texto)).toHaveLength(MAX_URLS);
  });

  it("ignora o que não é http(s)", () => {
    expect(findUrls("ftp://example.com/a e mailto:a@example.com")).toEqual([]);
  });
});

describe("domainFromUrl", () => {
  it("devolve o hostname sem www.", () => {
    expect(domainFromUrl("https://www.example.com/a")).toBe("example.com");
    expect(domainFromUrl("https://blog.example.com/")).toBe("blog.example.com");
  });

  it("devolve vazio para URL quebrada, sem estourar", () => {
    expect(domainFromUrl("não é url")).toBe("");
  });
});

describe("providerFromUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=1", "youtube"],
    ["https://youtu.be/abc", "youtube"],
    ["https://www.tiktok.com/@a/video/1", "tiktok"],
    ["https://github.com/dono/repo", "github"],
    ["https://open.spotify.com/track/1", "spotify"],
    ["https://www.instagram.com/p/1", "instagram"],
    ["https://www.facebook.com/post/1", "facebook"],
    ["https://fb.watch/abc", "facebook"],
    ["https://www.figma.com/file/1", "figma"],
    ["https://notion.so/pagina", "notion"],
    ["https://equipe.notion.site/pagina", "notion"],
    ["https://drive.google.com/file/d/1", "google-drive"],
    ["https://docs.google.com/document/d/1", "google-drive"],
    ["https://www.dropbox.com/s/1", "dropbox"],
    ["https://example.com/qualquer", "generic"],
  ])("%s → %s", (url, provider) => {
    expect(providerFromUrl(url)).toBe(provider);
  });
});

describe("nativeLinkPreview", () => {
  const message = (over: Record<string, unknown> = {}) => ({ content: "Veja https://example.com/a", metadata: {}, ...over }) as never;

  it("a prévia persistida dos nossos envios vence tudo", () => {
    const linkPreview = { url: "https://example.com/a", title: "Matéria", imageUrl: "https://example.com/cover.png", provider: "generic" };
    expect(nativeLinkPreview(message({ metadata: { linkPreview, _data: { title: "Outro" } } }))).toMatchObject({ url: "https://example.com/a", title: "Matéria" });
  });

  it("exige url e ao menos título ou imagem na persistida", () => {
    expect(nativeLinkPreview(message({ metadata: { linkPreview: { url: "https://example.com/a" } } }))).toBeNull();
    expect(nativeLinkPreview(message({ metadata: { linkPreview: { title: "Sem url" } } }))).toBeNull();
    expect(nativeLinkPreview(message({ metadata: { linkPreview: { url: "https://example.com/a", imageUrl: "https://example.com/i.png" } } }))).not.toBeNull();
  });

  it("lê a recebida do _data, com thumbnail virando data URL", () => {
    const preview = nativeLinkPreview(message({ metadata: { _data: { title: "Recebida", thumbnail: "QUJD", canonicalUrl: "https://example.com/canon" } } }));
    expect(preview).toMatchObject({ url: "https://example.com/canon", title: "Recebida", imageUrl: "data:image/jpeg;base64,QUJD" });
  });

  it("canonicalUrl vence matchedText, que vence a primeira URL do texto", () => {
    expect(nativeLinkPreview(message({ metadata: { _data: { title: "T", matchedText: "https://matched.example/" } } }))).toMatchObject({ url: "https://matched.example/" });
    expect(nativeLinkPreview(message({ metadata: { _data: { title: "T" } } }))).toMatchObject({ url: "https://example.com/a" });
  });

  it("sem título nem thumbnail não há prévia nativa", () => {
    expect(nativeLinkPreview(message({ metadata: { _data: { description: "Só descrição" } } }))).toBeNull();
    expect(nativeLinkPreview(message())).toBeNull();
  });

  it("mantém durationSeconds íntegro e descarta o torto", () => {
    expect(nativeLinkPreview(message({ metadata: { linkPreview: { url: "https://a.example/", title: "T", durationSeconds: 83.7 } } }))).toMatchObject({ durationSeconds: 83 });
    expect(nativeLinkPreview(message({ metadata: { linkPreview: { url: "https://a.example/", title: "T", durationSeconds: -1 } } }))).not.toHaveProperty("durationSeconds");
  });
});

describe("cachedLinkPreview", () => {
  beforeEach(() => previewCache.clear());

  it("duas mensagens com o mesmo link custam uma busca", async () => {
    const api = { linkPreview: vi.fn().mockResolvedValue({ url: "https://a.example/", title: "T" }) };
    await Promise.all([cachedLinkPreview(api, "https://a.example/"), cachedLinkPreview(api, "https://a.example/")]);
    await cachedLinkPreview(api, "https://a.example/");
    expect(api.linkPreview).toHaveBeenCalledTimes(1);
  });

  it("falha vira null cacheado: a raspagem que falhou não se repete", async () => {
    const api = { linkPreview: vi.fn().mockRejectedValue(new Error("422")) };
    await expect(cachedLinkPreview(api, "https://b.example/")).resolves.toBeNull();
    await expect(cachedLinkPreview(api, "https://b.example/")).resolves.toBeNull();
    expect(api.linkPreview).toHaveBeenCalledTimes(1);
  });

  it("links diferentes são buscas diferentes", async () => {
    const api = { linkPreview: vi.fn().mockResolvedValue({ url: "u", title: "T" }) };
    await cachedLinkPreview(api, "https://a.example/");
    await cachedLinkPreview(api, "https://b.example/");
    expect(api.linkPreview).toHaveBeenCalledTimes(2);
  });
});
