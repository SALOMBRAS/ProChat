import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { InboxApi, InboxConversation, InboxMessage, Page } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox, { locationOf, mapsUrl, coordinatesLabel } from "./Inbox.js";

/**
 * A PR #51 entregou o envio de localização com UI mínima: dois itens soltos no menu
 * e `window.prompt` para as coordenadas, com uma única mensagem para qualquer falha
 * de geolocalização. Aqui isso vira um item só, um painel, e as três causas que a
 * API distingue — cada uma com o seu texto.
 */
const conversation = (id: string): InboxConversation => ({
  id, whatsappSessionId: "session-a", chatId: "5511999990001@c.us", contactId: null, conversationType: "direct",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Ana", phone: "5511999990001", pushName: "Ana", profileName: "Ana", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
const emptyPage = <T,>(): Page<T> => ({ items: [], page: 1, pageSize: 50, total: 0 });
const message = (overrides: Partial<InboxMessage>): InboxMessage => ({
  id: "m1", conversationId: "c1", direction: "inbound", messageType: "location", content: null,
  timestamp: "2026-07-28T12:00:00.000Z", status: "received", senderWhatsappId: null, mediaUrl: null,
  mediaMimeType: null, mediaFilename: null, mediaSize: null, thumbnailUrl: null, duration: null,
  quotedMessageId: null, metadata: {}, ...overrides,
} as InboxMessage);

const api = (messages: InboxMessage[] = []) => ({
  conversations: vi.fn().mockResolvedValue({ items: [conversation("11111111-1111-4111-8111-111111111111")], page: 1, pageSize: 50, total: 1 }),
  messages: vi.fn().mockResolvedValue({ ...emptyPage<InboxMessage>(), items: messages, total: messages.length }),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  sendLocation: vi.fn().mockResolvedValue(undefined),
}) as unknown as InboxApi;

const geolocation = (impl?: Partial<Geolocation>) => {
  Object.defineProperty(navigator, "geolocation", { value: impl, configurable: true });
};
const abrirPainel = async (client = api()) => {
  render(<Inbox api={client} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  fireEvent.click(await screen.findByLabelText("Adicionar anexo"));
  const menu = screen.getByRole("menu", { name: "Opções de anexo" });
  const itens = [...menu.querySelectorAll("button")].map((b) => b.textContent ?? "");
  fireEvent.click(within(menu).getByText("Localização"));
  return { client, itens, painel: await screen.findByRole("dialog", { name: "Enviar localização" }) };
};

beforeEach(() => { Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), configurable: true }); });
afterEach(() => { geolocation(undefined); vi.restoreAllMocks(); });

describe("envio de localização", () => {
  it("é um item só no menu, não dois", async () => {
    geolocation({ getCurrentPosition: vi.fn() } as never);
    const { itens } = await abrirPainel();
    // A #51 tinha "Localização atual" e "Informar coordenadas" lado a lado.
    expect(itens.filter((texto) => /Localiza/i.test(texto))).toHaveLength(1);
    expect(itens.some((texto) => /Informar coordenadas/i.test(texto))).toBe(false);
  });

  it("usa a localização do navegador e preenche as coordenadas para conferência", async () => {
    const getCurrentPosition = vi.fn().mockImplementation((ok: PositionCallback) =>
      ok({ coords: { latitude: -7.1153, longitude: -34.8610 } } as GeolocationPosition));
    geolocation({ getCurrentPosition } as never);
    const { client, painel } = await abrirPainel();
    fireEvent.click(within(painel).getByText("Usar minha localização atual"));

    const campo = await within(painel).findByLabelText("Latitude, longitude");
    await waitFor(() => expect((campo as HTMLInputElement).value).toContain("-7.115"));
    // Confere no mapa antes de enviar, sem sair do painel.
    expect(within(painel).getByText(/Conferir no mapa/i).getAttribute("href")).toContain("query=-7.1153,-34.861");

    fireEvent.click(within(painel).getByRole("button", { name: "Enviar localização" }));
    await waitFor(() => expect(client.sendLocation).toHaveBeenCalled());
    expect((client.sendLocation as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ latitude: -7.1153, longitude: -34.861 });
  });

  it("envia um ponto informado à mão, com nome opcional", async () => {
    geolocation({ getCurrentPosition: vi.fn() } as never);
    const { client, painel } = await abrirPainel();
    fireEvent.change(within(painel).getByLabelText("Latitude, longitude"), { target: { value: "-3.783, -38.5545" } });
    fireEvent.change(within(painel).getByLabelText("Nome do ponto"), { target: { value: "Loja centro" } });
    fireEvent.click(within(painel).getByRole("button", { name: "Enviar localização" }));
    await waitFor(() => expect(client.sendLocation).toHaveBeenCalled());
    expect((client.sendLocation as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ latitude: -3.783, longitude: -38.5545, title: "Loja centro" });
  });

  it.each([
    [1, /permiss(ã|a)o de localiza(ç|c)(ã|a)o negada/i],
    [2, /localiza(ç|c)(ã|a)o indispon(í|i)vel/i],
    [3, /demorou demais/i],
  ])("dá mensagem própria para o erro de código %i", async (code, esperado) => {
    const getCurrentPosition = vi.fn().mockImplementation((_ok: PositionCallback, fail: PositionErrorCallback) =>
      fail({ code, message: "texto cru do navegador" } as GeolocationPositionError));
    geolocation({ getCurrentPosition } as never);
    const { painel } = await abrirPainel();
    fireEvent.click(within(painel).getByText("Usar minha localização atual"));
    const alerta = await within(painel).findByRole("alert");
    expect(alerta.textContent ?? "").toMatch(esperado);
    expect(alerta.textContent ?? "").not.toContain("texto cru do navegador");
  });

  it("sem geolocalização, ainda dá para informar o ponto", async () => {
    geolocation(undefined);
    const { painel } = await abrirPainel();
    fireEvent.click(within(painel).getByText("Usar minha localização atual"));
    expect((await within(painel).findByRole("alert")).textContent ?? "").toMatch(/n(ã|a)o exp(õ|o)e localiza(ç|c)(ã|a)o/i);
    expect(within(painel).getByLabelText("Latitude, longitude")).toBeTruthy();
  });

  it("recusa coordenadas fora de faixa em vez de mandar para o servidor", async () => {
    geolocation({ getCurrentPosition: vi.fn() } as never);
    const { client, painel } = await abrirPainel();
    for (const invalido of ["abc", "91, 0", "0, 181", "-7.115"]) {
      fireEvent.change(within(painel).getByLabelText("Latitude, longitude"), { target: { value: invalido } });
      fireEvent.click(within(painel).getByRole("button", { name: "Enviar localização" }));
      expect((await within(painel).findByRole("alert")).textContent ?? "").toMatch(/coordenadas inv(á|a)lidas/i);
    }
    expect(client.sendLocation).not.toHaveBeenCalled();
  });
});

describe("leitura do ponto nas duas origens", () => {
  it("lê a localização enviada por nós", () => {
    expect(locationOf({ location: { latitude: -7.1, longitude: -34.8, title: "Loja" } })).toMatchObject({ latitude: -7.1, longitude: -34.8, title: "Loja" });
  });

  // Forma medida em duas mensagens reais da base: name/address/thumbnail no payload.
  it("lê a recebida do WhatsApp, com name em vez de title", () => {
    const point = locationOf({ location: { live: false, name: "Planeta Animal", address: "Av Dr Silas Munguba 1299", latitude: -3.783, longitude: -38.5545, thumbnail: "/9j/4AAQ" } });
    expect(point).toMatchObject({ latitude: -3.783, longitude: -38.5545, title: "Planeta Animal", address: "Av Dr Silas Munguba 1299", live: false });
    // A miniatura vem em base64 cru e vira data URI: preview sem chave de API.
    expect(point?.thumbnail).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });

  it("ignora ponto sem coordenadas utilizáveis", () => {
    expect(locationOf(undefined)).toBeUndefined();
    expect(locationOf({})).toBeUndefined();
    expect(locationOf({ location: { latitude: "x", longitude: 1 } })).toBeUndefined();
  });

  it("monta link e rótulo", () => {
    expect(mapsUrl(-7.1153, -34.861)).toBe("https://www.google.com/maps/search/?api=1&query=-7.1153,-34.861");
    expect(coordinatesLabel(-7.115312, -34.861)).toBe("-7.11531, -34.86100");
  });
});

describe("cartão da mensagem de localização", () => {
  const abrirConversa = async (metadata: Record<string, unknown>) => {
    render(<Inbox api={api([message({ metadata })])} />);
    await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
    fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
    return await screen.findByRole("link", { name: /Abrir no mapa/i });
  };

  it("o cartão inteiro é o link e diz para onde leva", async () => {
    const link = await abrirConversa({ location: { name: "Planeta Animal", address: "Av Dr Silas Munguba 1299", latitude: -3.783, longitude: -38.5545 } });
    expect(link.getAttribute("href")).toBe(mapsUrl(-3.783, -38.5545));
    // Abre fora sem dar acesso ao opener.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");
    expect(link.textContent).toContain("Planeta Animal");
    expect(link.textContent).toContain("Av Dr Silas Munguba 1299");
    expect(link.textContent).toContain("-3.78300, -38.55450");
    expect(link.textContent).toMatch(/Abrir no mapa/);
  });

  it("mostra a miniatura que o WhatsApp já mandou", async () => {
    const link = await abrirConversa({ location: { latitude: -3.783, longitude: -38.5545, thumbnail: "/9j/4AAQ" } });
    const img = link.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });

  it("não quebra quando a localização vem sem coordenadas", async () => {
    render(<Inbox api={api([message({ metadata: { location: { name: "sem ponto" } } })])} />);
    await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
    fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
    expect(await screen.findByText(/Localiza(ç|c)(ã|a)o sem coordenadas/i)).toBeTruthy();
  });

  it("o cartão e o painel têm estilo próprio, só com tokens já existentes", () => {
    // Busca literal: o seletor é escrito exatamente assim no arquivo, e montar
    // regex a partir dele já me escapou errado uma vez — a asserção passava sem
    // afirmar nada.
    for (const selector of [".chat-inbox .message-location", ".chat-inbox .composer-location"]) {
      const start = stylesheet.indexOf(`${selector} {`);
      expect(start, `regra ${selector} ausente em styles.css`).toBeGreaterThan(-1);
      const body = stylesheet.slice(start, stylesheet.indexOf("}", start));
      expect(body).toMatch(/background/);
      for (const token of new Set([...body.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0])))
        expect(stylesheet.split(token).length - 1, `${token} é uma cor nova`).toBeGreaterThan(1);
    }
    // A escala da PR #47: nome 15/600, contexto 13, referência 11.
    expect(stylesheet).toMatch(/\.chat-inbox \.message-location-copy strong \{[^}]*font-size: 15px[^}]*font-weight: 600/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-location-copy > span \{[^}]*font-size: 13px/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-location-copy small \{[^}]*font-size: 11px/);
  });
});
