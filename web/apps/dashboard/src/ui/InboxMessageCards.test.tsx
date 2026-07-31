import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { DomainApi } from "../api/domain.js";
import type { InboxApi, InboxConversation, InboxMessage, Page } from "../api/inbox.js";
import { Contacts, contactsSearchFromLocation } from "./App.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * Cartões de mídia na conversa, um teste por tipo tratado.
 *
 * O que estes testes prendem é a leitura do payload cru: as colunas dedicadas
 * chegam nulas na maior parte das linhas de produção (duração em 100% dos áudios,
 * tamanho em 89 de 89 documentos) e o dado está em `metadata._data`. Sem essa
 * leitura o cartão mostra "0:00" e "Tamanho não informado" para quase tudo.
 */
const conversationId = "11111111-1111-4111-8111-111111111111";
const conversation = (): InboxConversation => ({
  id: conversationId, whatsappSessionId: "session-a", chatId: "5511999990001@c.us", contactId: null, conversationType: "direct",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Ana", phone: "5511999990001", pushName: "Ana", profileName: "Ana", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
const message = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: "m-1", direction: "inbound", content: null, timestamp: "2026-07-29T12:00:00.000Z",
  status: "received", messageType: "text", chatId: "5511999990001@c.us", metadata: {}, ...over,
});
const page = <T,>(items: T[]): Page<T> => ({ items, page: 1, pageSize: 50, total: items.length });
const waveObject = (values: number[]) => Object.fromEntries(values.map((value, index) => [String(index), value]));
const sixtyFour = Array.from({ length: 64 }, (_, index) => (index % 2 ? 90 : 15));

const api = (messages: InboxMessage[]) => ({
  conversations: vi.fn().mockResolvedValue(page([conversation()])),
  messages: vi.fn().mockResolvedValue(page(messages)),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  mediaUrl: vi.fn().mockResolvedValue({ url: "https://cdn.test/arquivo", expiresAt: "2026-07-29T13:00:00.000Z" }),
  sendAttachment: vi.fn().mockResolvedValue({ id: "job-1", status: "pending" }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}) as unknown as InboxApi;
const domain = (found: unknown[] = []) => ({
  contacts: vi.fn().mockResolvedValue({ items: found, page: 1, pageSize: 1, total: found.length }),
  createContact: vi.fn().mockResolvedValue({ id: "c-1" }),
}) as unknown as DomainApi;

const abrirConversa = async (messages: InboxMessage[], crm = domain()) => {
  const client = api(messages);
  render(<Inbox api={client} domain={crm} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  await screen.findByLabelText("Adicionar anexo");
  return { client, crm };
};

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn().mockReturnValue("blob:preview"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null) as never;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("nota de voz", () => {
  it("desenha a forma de onda que veio no payload, e mostra a duração antes de tocar", async () => {
    await abrirConversa([message({
      messageType: "ptt", mediaUrl: "s3://nota", mediaMimeType: "audio/ogg", duration: null,
      metadata: { _data: { type: "ptt", duration: "19", waveform: waveObject(sixtyFour) } },
    })]);
    const nota = await screen.findByLabelText("Mensagem de voz");
    // As 64 barras são as amplitudes do WhatsApp; sem lê-las não haveria o que desenhar.
    expect(nota.querySelectorAll(".voice-note-wave i")).toHaveLength(64);
    // A coluna `duration` é nula em 100% dos áudios da base; `_data.duration` tem 19s.
    expect(within(nota).getByText("0:19")).toBeTruthy();
    expect(within(nota).getByLabelText("Velocidade 1x")).toBeTruthy();
    expect(document.querySelector(".audio-track")).toBeNull();
  });

  it("a nota histórica, gravada como audio, ainda cai no player de voz", async () => {
    await abrirConversa([message({
      messageType: "audio", mediaUrl: "s3://nota", mediaMimeType: "audio/ogg",
      metadata: { _data: { type: "ptt", duration: "8", waveform: waveObject(sixtyFour) } },
    })]);
    await screen.findByLabelText("Mensagem de voz");
    expect(screen.queryByLabelText("Arquivo de áudio")).toBeNull();
  });

  it("sem onda no payload cai numa barra simples em vez de fingir um traçado", async () => {
    await abrirConversa([message({ messageType: "ptt", mediaUrl: "s3://nota", mediaMimeType: "audio/ogg" })]);
    const nota = await screen.findByLabelText("Mensagem de voz");
    expect(nota.querySelector(".voice-note-wave.flat")).toBeTruthy();
  });
});

describe("arquivo de áudio", () => {
  it("parece faixa: nome e duração, e sem controle de velocidade", async () => {
    await abrirConversa([message({
      messageType: "audio", mediaUrl: "s3://faixa", mediaMimeType: "audio/mpeg", mediaFilename: "trilha-final.mp3",
      metadata: { _data: { type: "audio", duration: "212", size: 3_145_728 } },
    })]);
    const faixa = await screen.findByLabelText("Arquivo de áudio");
    expect(within(faixa).getByText("trilha-final.mp3")).toBeTruthy();
    expect(within(faixa).getByText(/3:32/)).toBeTruthy();
    expect(within(faixa).getByText(/3\.0 MB/)).toBeTruthy();
    // Velocidade é gesto de quem ouve recado; a faixa não tem.
    expect(within(faixa).queryByLabelText("Velocidade 1x")).toBeNull();
    expect(within(faixa).getByLabelText("Baixar trilha-final.mp3")).toBeTruthy();
    expect(document.querySelector(".voice-note")).toBeNull();
  });
});

describe("cartão de contato", () => {
  it("mostra nome e telefone legíveis e abre no CRM quando o contato existe", async () => {
    const crm = domain([{ id: "c-1", displayName: "Ana Souza" }]);
    await abrirConversa([message({
      messageType: "contact", content: "Ana Souza",
      metadata: { contacts: [{ fullName: "Ana Souza", phoneNumber: "5511999990001", organization: "Loja Centro" }] },
    })], crm);

    const cartao = document.querySelector(".message-contact-card")!;
    expect(within(cartao as HTMLElement).getByText("Ana Souza")).toBeTruthy();
    expect(within(cartao as HTMLElement).getByText("+55 (11) 99999-0001")).toBeTruthy();
    expect(within(cartao as HTMLElement).getByText("Loja Centro")).toBeTruthy();
    // O corpo guardado é o próprio nome: mostrá-lo abaixo do cartão o repetiria.
    expect(cartao.parentElement?.querySelectorAll("p")).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("Ver Ana Souza no CRM"));
    await waitFor(() => expect(crm.contacts).toHaveBeenCalledWith(expect.objectContaining({ search: "5511999990001" })));
    await waitFor(() => expect(location.pathname).toBe("/contacts"));
    expect(new URLSearchParams(location.search).get("search")).toBe("5511999990001");
    history.pushState({}, "", "/inbox");
  });

  it("oferece criar quando o contato não está no CRM", async () => {
    const crm = domain([]);
    await abrirConversa([message({
      messageType: "contact", content: "Bia",
      metadata: { contacts: [{ fullName: "Bia", phoneNumber: "5511988887777" }] },
    })], crm);

    fireEvent.click(screen.getByLabelText("Ver Bia no CRM"));
    await screen.findByText("Ainda não está no CRM.");
    fireEvent.click(screen.getByLabelText("Criar Bia no CRM"));
    await waitFor(() => expect(crm.createContact).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Bia", phoneNumber: "5511988887777" })));
    await screen.findByText("Criado · abrir");
  });

  it("não consulta o CRM ao renderizar: uma requisição por cartão seria N+1", async () => {
    const crm = domain([]);
    await abrirConversa([
      message({ id: "m-1", messageType: "contact", metadata: { contacts: [{ fullName: "Ana", phoneNumber: "5511999990001" }] } }),
      message({ id: "m-2", messageType: "contact", metadata: { contacts: [{ fullName: "Bia", phoneNumber: "5511988887777" }] } }),
    ], crm);
    await waitFor(() => expect(document.querySelectorAll(".message-contact-card")).toHaveLength(2));
    expect(crm.contacts).not.toHaveBeenCalled();
  });
});

describe("o CRM recebe o filtro pela URL", () => {
  it("a página de contatos abre já filtrada no telefone que o cartão mandou", async () => {
    // Sem isto, "abrir no CRM" jogaria o operador numa lista inteira para procurar
    // de novo o contato que ele acabou de clicar.
    history.pushState({}, "", "/contacts?search=5511999990001");
    expect(contactsSearchFromLocation()).toBe("5511999990001");
    const crm = { ...(domain([{ id: "c-1", displayName: "Ana Souza", phoneNumber: "5511999990001" }]) as unknown as Record<string, unknown>), tags: vi.fn().mockResolvedValue([]) } as unknown as DomainApi;
    render(<Contacts api={crm} />);
    await waitFor(() => expect(crm.contacts).toHaveBeenCalledWith(expect.objectContaining({ search: "5511999990001" })));
    expect((screen.getByLabelText("Buscar contatos") as HTMLInputElement).value).toBe("5511999990001");
    history.pushState({}, "", "/inbox");
  });

  it("sem o parâmetro, a busca começa vazia", () => {
    history.pushState({}, "", "/contacts");
    expect(contactsSearchFromLocation()).toBe("");
  });
});

describe("localização", () => {
  it("o cartão inteiro é o link do mapa, e o título não aparece duas vezes", async () => {
    await abrirConversa([message({
      messageType: "location", content: "Loja Centro",
      metadata: { location: { latitude: -7.115312, longitude: -34.861, title: "Loja Centro", address: "Av. Epitácio Pessoa, 100" } },
    })]);
    const link = await screen.findByLabelText("Abrir no mapa: Loja Centro");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://www.google.com/maps/search/?api=1&query=-7.115312,-34.861");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(within(link).getByText("Abrir no mapa ↗")).toBeTruthy();
    expect(within(link).getByText("Av. Epitácio Pessoa, 100")).toBeTruthy();
    // Sem URL crua e sem o título repetido como texto solto abaixo do cartão.
    expect(link.closest(".message-bubble")!.querySelectorAll("p")).toHaveLength(0);
    expect(link.closest(".message-bubble")!.textContent).not.toContain("https://");
  });
});

describe("documento", () => {
  it("tira nome, tamanho e tipo do payload quando as colunas vêm nulas", async () => {
    // Medido: 1 de 89 documentos tem media_filename e 0 têm media_size.
    await abrirConversa([message({
      messageType: "document", mediaUrl: "s3://doc", mediaFilename: null, mediaSize: null, mediaMimeType: null,
      metadata: { _data: { filename: "contrato-2026.pdf", size: 98_301, mimetype: "application/pdf" } },
    })]);
    const cartao = await screen.findByLabelText("Baixar contrato-2026.pdf");
    expect(within(cartao).getByText("contrato-2026.pdf")).toBeTruthy();
    expect(within(cartao).getByText("96 KB")).toBeTruthy();
    expect(cartao.querySelector(".message-document-icon")!.className).toContain("tone-pdf");
    expect(cartao.getAttribute("href")).toBe("https://cdn.test/arquivo");
    expect(cartao.getAttribute("download")).toBe("contrato-2026.pdf");
  });

  it("sem nome nenhum, usa o mime para o ícone em vez de dizer só Documento", async () => {
    await abrirConversa([message({
      messageType: "document", mediaUrl: "s3://doc",
      metadata: { _data: { size: 2048, mimetype: "image/jpeg" } },
    })]);
    const cartao = await screen.findByLabelText("Baixar Documento IMG");
    expect(cartao.querySelector(".message-document-icon")!.textContent).toBe("IMG");
    expect(within(cartao).getByText("2 KB")).toBeTruthy();
  });
});

describe("imagem e vídeo", () => {
  it("o vídeo mostra a duração que só existe no payload", async () => {
    await abrirConversa([message({
      messageType: "video", mediaUrl: "s3://video", mediaMimeType: "video/mp4", duration: null,
      metadata: { _data: { duration: "16", size: 1_048_576 } },
    })]);
    await waitFor(() => expect(document.querySelector(".message-video-card")).toBeTruthy());
    expect(screen.getByText(/0:16/)).toBeTruthy();
    expect(screen.getByText(/1\.0 MB/)).toBeTruthy();
  });

  it("a imagem sem nome mostra o tamanho em vez de um rótulo do protocolo", async () => {
    await abrirConversa([message({
      messageType: "image", mediaUrl: "s3://img", mediaMimeType: "image/jpeg", mediaFilename: "image",
      metadata: { _data: { size: 524_288 } },
    })]);
    await waitFor(() => expect(document.querySelector(".message-image-card")).toBeTruthy());
    // 'image' é rótulo do protocolo, não nome de arquivo.
    expect(screen.queryByText("image")).toBeNull();
    expect(screen.getByText("512 KB")).toBeTruthy();
  });
});

describe("mensagens em texto corrompido", () => {
  it("os avisos de mídia estão legíveis, não em mojibake", async () => {
    const client = api([message({ id: "m-1", messageType: "image", mediaUrl: "s3://img" })]);
    (client.mediaUrl as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("sem acesso"));
    render(<Inbox api={client} domain={domain()} />);
    await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
    fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
    // mojibake-esperado: estava gravado como "NÃ£o foi possÃ­vel carregar a mÃ­dia." — bytes UTF-8
    // lidos como Latin-1, visíveis ao operador.
    const aviso = await screen.findByText("Não foi possível carregar a mídia.");
    expect(aviso.textContent).not.toContain("Ã");
  });
});

describe("estilo", () => {
  it("os cartões têm regra própria, na escala da #47 e sem hex novo", () => {
    expect(stylesheet).toMatch(/\.chat-inbox \.voice-note-wave i\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.voice-note-wave i\.played\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.audio-track\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-contact-actions button\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-document-icon\.tone-pdf\s*\{/);
    // Escala da #47: nome 15/600, contexto 13, referência 11.
    expect(stylesheet).toMatch(/\.chat-inbox \.audio-track-copy strong\s*\{[^}]*font-size:\s*15px[^}]*font-weight:\s*600/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-contact-copy strong\s*\{[^}]*font-size:\s*15px[^}]*font-weight:\s*600/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-contact-copy > span\s*\{[^}]*font-size:\s*13px/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-contact-copy small\s*\{[^}]*font-size:\s*11px/);

    const usados = new Set([...stylesheet.matchAll(/\.chat-inbox \.(?:voice-note|audio-track|message-contact)[^{]*\{([^}]*)\}/g)]
      .flatMap((match) => [...match[1].matchAll(/#[0-9a-f]{3,8}\b/gi)].map((color) => color[0])));
    expect(usados.size).toBeGreaterThan(0);
    for (const token of usados)
      expect(stylesheet.split(token).length - 1, `${token} é uma cor nova`).toBeGreaterThan(1);
  });
});
