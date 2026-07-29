import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxApi, InboxConversation, InboxMessage, Page } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * O WhatsApp trata nota de voz (PTT, com forma de onda) e arquivo de música
 * (uma faixa, com nome) de formas diferentes. A Inbox tinha um player só, casado
 * por `messageType === "audio"` ou mime `audio/`, com `aria-label` fixo
 * "Mensagem de áudio" — os dois casos ficavam indistinguíveis na tela.
 *
 * Medido na base antes desta mudança: das 116 linhas de áudio, 114 eram notas de
 * voz (`_data.type = 'ptt'`) e 2 eram arquivos, e todas as 116 estavam gravadas
 * como `audio`. Agora a recepção separa as duas, e estes testes fixam que a
 * separação chega até o que o operador vê.
 *
 * A renderização é o mínimo para validar o caminho: rótulo e nome do arquivo. O
 * refinamento visual — forma de onda contra linha de faixa — não é desta etapa.
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
  id: "m1", conversationId: "c1", direction: "inbound", messageType: "audio", content: null,
  timestamp: "2026-07-28T12:00:00.000Z", status: "received", senderWhatsappId: null,
  mediaUrl: "https://waha.test/media/m1", mediaMimeType: "audio/ogg; codecs=opus", mediaFilename: null,
  mediaSize: null, thumbnailUrl: null, duration: 7, quotedMessageId: null, metadata: {}, ...overrides,
} as InboxMessage);

const api = (messages: InboxMessage[]) => ({
  conversations: vi.fn().mockResolvedValue({ items: [conversation("11111111-1111-4111-8111-111111111111")], page: 1, pageSize: 50, total: 1 }),
  messages: vi.fn().mockResolvedValue({ ...emptyPage<InboxMessage>(), items: messages, total: messages.length }),
  mediaUrl: vi.fn().mockResolvedValue({ url: "https://storage.test/signed-audio" }),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
}) as unknown as InboxApi;

const abrirConversa = async (messages: InboxMessage[]) => {
  render(<Inbox api={api(messages)} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  document.querySelector<HTMLElement>(".chat-inbox .conversation-item")!.click();
};

beforeEach(() => { Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), configurable: true }); });
afterEach(() => { vi.restoreAllMocks(); });

describe("nota de voz e arquivo de áudio na Inbox", () => {
  it("chama a nota de voz pelo que ela é", async () => {
    await abrirConversa([message({ messageType: "ptt" })]);
    expect(await screen.findByLabelText("Mensagem de voz")).toBeTruthy();
    expect(screen.queryByLabelText("Arquivo de áudio")).toBeNull();
  });

  it("chama o arquivo de áudio pelo que ele é, e mostra o nome do arquivo", async () => {
    await abrirConversa([message({ messageType: "audio", mediaMimeType: "audio/mpeg", mediaFilename: "musica.mp3" })]);
    expect(await screen.findByLabelText("Arquivo de áudio")).toBeTruthy();
    expect(screen.queryByLabelText("Mensagem de voz")).toBeNull();
    expect(await screen.findByText("musica.mp3")).toBeTruthy();
  });

  it("não pendura nome de arquivo numa nota de voz, que não tem um", async () => {
    await abrirConversa([message({ messageType: "ptt", mediaFilename: "PTT-20260728.ogg" })]);
    await screen.findByLabelText("Mensagem de voz");
    expect(screen.queryByText("PTT-20260728.ogg")).toBeNull();
  });

  it("mantém a nota de voz no player, e não no cartão de documento", async () => {
    await abrirConversa([message({ messageType: "ptt" })]);
    await waitFor(() => expect(document.querySelector(".audio-player")).toBeTruthy());
    expect(document.querySelector(".message-document")).toBeNull();
  });

  /** Sem mime não há o que casar com `audio/`, então o roteamento por
   *  `messageType === "ptt"` é a única coisa que impede a nota de voz de cair no
   *  cartão de documento. Há 224 linhas assim na base — notas de voz cuja
   *  classificação se perdeu por falta de mime. */
  it("roteia uma nota de voz sem mime pelo tipo, não pelo mime que ela não tem", async () => {
    await abrirConversa([message({ messageType: "ptt", mediaMimeType: null })]);
    await waitFor(() => expect(document.querySelector(".audio-player")).toBeTruthy());
    expect(await screen.findByLabelText("Mensagem de voz")).toBeTruthy();
  });
});
