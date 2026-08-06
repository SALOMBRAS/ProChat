import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { InboxApi, InboxMessage } from "../api/inbox.js";
import { LinkPreview, linkify } from "./LinkPreviewCard.js";
import { previewCache } from "./linkPreview.js";

/**
 * Links vivos e cartão de prévia. A nativa (rede zero) vence sempre; a
 * retaguarda OG da API entra só quando não há nativa, e falha não deixa
 * resíduo — o texto linkado permanece.
 */
const message = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: "m-1", direction: "inbound", content: null, timestamp: "2026-07-29T12:00:00.000Z",
  status: "received", messageType: "text", chatId: "5511999990001@c.us", metadata: {}, ...over,
});
const api = (impl?: () => Promise<unknown>) => ({ linkPreview: vi.fn().mockImplementation(impl ?? (() => Promise.resolve({ url: "https://example.com/materia", title: "Matéria", provider: "generic" as const }))) }) as unknown as InboxApi;

beforeEach(() => { previewCache.clear(); });

describe("linkify", () => {
  it("a URL do texto vira âncora segura", () => {
    const { container } = render(<p>{linkify("olha https://example.com/materia agora")}</p>);
    const link = container.querySelector("a.message-link")!;
    expect(link.getAttribute("href")).toBe("https://example.com/materia");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(container.textContent).toBe("olha https://example.com/materia agora");
  });

  it("a pontuação da frase fica fora do href", () => {
    const { container } = render(<p>{linkify("vi https://example.com/a, gostou?")}</p>);
    expect(container.querySelector("a")!.getAttribute("href")).toBe("https://example.com/a");
    expect(container.textContent).toContain(", gostou?");
  });

  it("texto sem URL não vira elemento nenhum", () => {
    const { container } = render(<p>{linkify("bom dia, sem link")}</p>);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("LinkPreview", () => {
  it("sem link na mensagem, não chama a API", async () => {
    const client = api();
    render(<LinkPreview message={message({ content: "bom dia" })} api={client} />);
    await waitFor(() => expect(document.querySelector(".link-preview-card")).toBeNull());
    expect(client.linkPreview).not.toHaveBeenCalled();
  });

  it("a prévia nativa do envio renderiza sem custar rede", async () => {
    const client = api();
    render(<LinkPreview message={message({ content: "Veja https://example.com/a", metadata: { linkPreview: { url: "https://example.com/a", title: "Enviada", provider: "youtube" } } })} api={client} />);
    const card = await screen.findByLabelText("Abrir link: Enviada");
    expect(card.className).toContain("is-youtube");
    expect(client.linkPreview).not.toHaveBeenCalled();
  });

  it("a recebida com thumbnail no _data renderiza a imagem sem rede", async () => {
    const client = api();
    render(<LinkPreview message={message({ content: "https://example.com/b", metadata: { _data: { title: "Recebida", thumbnail: "QUJD", canonicalUrl: "https://example.com/b" } } })} api={client} />);
    const card = await screen.findByLabelText("Abrir link: Recebida");
    expect(card.querySelector("img")!.getAttribute("src")).toBe("data:image/jpeg;base64,QUJD");
    expect(client.linkPreview).not.toHaveBeenCalled();
  });

  it("sem nativa, a retaguarda OG entra uma vez e desenha o cartão", async () => {
    const client = api();
    render(<LinkPreview message={message({ content: "olha https://example.com/materia" })} api={client} />);
    const card = await screen.findByLabelText("Abrir link: Matéria");
    expect(card.className).toContain("link-preview-card");
    expect(within(card as HTMLElement).getByText("Matéria")).toBeTruthy();
    expect(client.linkPreview).toHaveBeenCalledTimes(1);
    expect(client.linkPreview).toHaveBeenCalledWith("https://example.com/materia");
  });

  it("duas mensagens com o mesmo link dividem uma única busca", async () => {
    const client = api();
    render(<>
      <LinkPreview message={message({ id: "m-1", content: "https://example.com/x" })} api={client} />
      <LinkPreview message={message({ id: "m-2", content: "de novo https://example.com/x" })} api={client} />
    </>);
    await waitFor(() => expect(document.querySelectorAll(".link-preview-card:not(.is-loading)")).toHaveLength(2));
    expect(client.linkPreview).toHaveBeenCalledTimes(1);
  });

  it("a falha da retaguarda não deixa resíduo: o cartão some e o texto segue", async () => {
    const client = api(() => Promise.reject(new Error("422")));
    render(<LinkPreview message={message({ content: "olha https://example.com/quebrado" })} api={client} />);
    await waitFor(() => expect(client.linkPreview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector(".link-preview-card")).toBeNull());
  });
});

describe("estilo da T4", () => {
  it("a folha tem as regras dos cartões, das ações do documento e da barra de upload", () => {
    expect(stylesheet).toMatch(/\.chat-inbox \.message-link\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.link-preview-card\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.link-preview-card\.is-youtube\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.link-preview-card\.is-loading\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-document-actions a,/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-document-thumb\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.document-text-preview\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-upload-progress\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-document-icon\.tone-zip\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-document-icon\.tone-book\s*\{/);
  });
});
