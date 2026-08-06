import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxApi, InboxConversation, InboxMessage, Page } from "../api/inbox.js";
import type { DomainApi } from "../api/domain.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";
import stylesheet from "./styles.css?raw";
import { contactInitials, contactRow, toggleSelection } from "./ContactPicker.js";

/**
 * O picker virou janela flutuante no padrão WhatsApp: abre VAZIA (nenhuma
 * lista antes da sincronização), um botão para sincronizar e um atalho para
 * carregar o que já está sincronizado. Depois do carregamento a lista vem
 * inteira — nada de "carregar mais" de 20 em 20 — em DUAS COLUNAS por origem:
 * contatos salvos no celular de um lado, histórico de conversas do outro.
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

const api = () => ({
  conversations: vi.fn().mockResolvedValue({ items: [conversation("11111111-1111-4111-8111-111111111111")], page: 1, pageSize: 50, total: 1 }),
  messages: vi.fn().mockResolvedValue(emptyPage<InboxMessage>()),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  sendVcard: vi.fn().mockResolvedValue(undefined),
}) as unknown as InboxApi;

const pessoa = (id: string, displayName: string, phoneNumber: string, origin: "phonebook" | "history", photoUrl?: string) => ({
  id, workspaceId: "workspace-a", displayName, phoneNumber, origin, ...(photoUrl ? { photoUrl } : {}),
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T10:00:00.000Z",
});
/** O caso da base: contato cujo `displayName` é idêntico ao telefone. */
const SEM_NOME = pessoa("dddddddd-4444-4444-8444-444444444444", "558592369359", "558592369359", "phonebook");
const CONTATOS = [
  pessoa("aaaaaaaa-1111-4111-8111-111111111111", "Ana Ribeiro", "5511999990001", "phonebook"),
  pessoa("bbbbbbbb-2222-4222-8222-222222222222", "Bruno Carvalho", "5511999990002", "history"),
  pessoa("cccccccc-3333-4333-8333-333333333333", "Carla Souza", "5511999990003", "phonebook"),
];

const domainWith = (contacts = vi.fn().mockResolvedValue({ items: CONTATOS, page: 1, pageSize: 100, total: CONTATOS.length })) =>
  ({ contacts }) as unknown as DomainApi;

const abrirContatos = async (client = api(), domain = domainWith()) => {
  render(<Inbox api={client} domain={domain} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  fireEvent.click(await screen.findByLabelText("Adicionar anexo"));
  const menu = screen.getByRole("menu", { name: "Opções de anexo" });
  fireEvent.click(within(menu).getByText("Contato"));
  return { client, domain, painel: await screen.findByRole("dialog", { name: "Enviar contato" }) };
};
/** O caminho feliz sem WAHA: abre e carrega o que já está sincronizado. */
const abrirECarregar = async (client = api(), domain = domainWith()) => {
  const aberto = await abrirContatos(client, domain);
  fireEvent.click(within(aberto.painel).getByRole("button", { name: "Já sincronizei — carregar contatos" }));
  await within(aberto.painel).findByRole("list", { name: "Salvos no celular" });
  return aberto;
};

beforeEach(() => { Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), configurable: true }); });
afterEach(() => vi.restoreAllMocks());

describe("escolha de contato para envio", () => {
  it("abre uma janela flutuante vazia, sem chamar o banco nem o prompt", async () => {
    const prompt = vi.spyOn(window, "prompt");
    const { domain, painel } = await abrirContatos();
    expect(painel).toBeInTheDocument();
    expect(document.querySelector(".composer-contact-overlay")).toBeInTheDocument();
    expect(within(painel).getByText("Nenhum contato carregado.")).toBeInTheDocument();
    expect(within(painel).queryByRole("list")).toBeNull();
    expect(domain.contacts).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("lista nome e telefone depois do carregamento, com o telefone formatado", async () => {
    const { painel } = await abrirECarregar();
    const lista = within(painel).getByRole("list", { name: "Salvos no celular" });
    expect(within(lista).getByText("Ana Ribeiro")).toBeInTheDocument();
    // Formatado, não os dígitos crus: é o telefone que o operador lê em voz alta.
    expect(within(lista).getByText("+55 (11) 99999-0001")).toBeInTheDocument();
    expect(within(lista).queryByText("5511999990001")).toBeNull();
    expect(within(painel).getAllByRole("checkbox")).toHaveLength(3);
  });

  it("separa as duas colunas por origem: celular de um lado, conversas do outro", async () => {
    const { painel } = await abrirECarregar();
    const celular = within(painel).getByRole("list", { name: "Salvos no celular" });
    const historico = within(painel).getByRole("list", { name: "Histórico de conversas" });
    expect(within(celular).getByText("Ana Ribeiro")).toBeInTheDocument();
    expect(within(celular).getByText("Carla Souza")).toBeInTheDocument();
    expect(within(celular).queryByText("Bruno Carvalho")).toBeNull();
    expect(within(historico).getByText("Bruno Carvalho")).toBeInTheDocument();
    expect(within(historico).queryByText("Ana Ribeiro")).toBeNull();
  });

  it("a busca filtra as duas colunas na hora, sem chamar o banco de novo", async () => {
    const contacts = vi.fn().mockResolvedValue({ items: CONTATOS, page: 1, pageSize: 100, total: CONTATOS.length });
    const { painel } = await abrirECarregar(api(), domainWith(contacts));
    const chamadas = contacts.mock.calls.length;
    fireEvent.change(within(painel).getByLabelText("Buscar contato por nome ou telefone"), { target: { value: "carla" } });
    const celular = within(painel).getByRole("list", { name: "Salvos no celular" });
    expect(within(celular).getByText("Carla Souza")).toBeInTheDocument();
    expect(within(celular).queryByText("Ana Ribeiro")).toBeNull();
    expect(contacts.mock.calls.length).toBe(chamadas);
  });

  it("carrega TODAS as páginas de uma vez, sem botão de carregar mais", async () => {
    const contacts = vi.fn()
      .mockResolvedValueOnce({ items: CONTATOS, page: 1, pageSize: 100, total: 4 })
      .mockResolvedValueOnce({ items: [pessoa("dddddddd-4444-4444-8444-444444444444", "Diego Alves", "5511999990004", "history")], page: 2, pageSize: 100, total: 4 });
    const { painel } = await abrirECarregar(api(), domainWith(contacts));
    expect(await within(painel).findByText("Diego Alves")).toBeInTheDocument();
    expect(within(painel).getByText("Ana Ribeiro")).toBeInTheDocument();
    expect(contacts).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(within(painel).queryByRole("button", { name: /Carregar mais/ })).toBeNull();
  });

  it("mostra o estado de carregamento antes de a listagem responder", async () => {
    let liberar: (value: unknown) => void = () => {};
    const domain = domainWith(vi.fn().mockImplementation(() => new Promise((resolve) => { liberar = resolve; })));
    const { painel } = await abrirContatos(api(), domain);
    fireEvent.click(within(painel).getByRole("button", { name: "Já sincronizei — carregar contatos" }));
    expect(await within(painel).findByText("Carregando contatos…")).toBeInTheDocument();
    liberar({ items: CONTATOS, page: 1, pageSize: 100, total: CONTATOS.length });
    await within(painel).findByRole("list", { name: "Salvos no celular" });
  });

  it("avisa quando o carregamento falha, em vez de ficar em carregando", async () => {
    const domain = domainWith(vi.fn().mockRejectedValue(new Error("rede")));
    const { painel } = await abrirContatos(api(), domain);
    fireEvent.click(within(painel).getByRole("button", { name: "Já sincronizei — carregar contatos" }));
    expect(await within(painel).findByRole("alert")).toHaveTextContent("Não foi possível carregar os contatos.");
  });

  it("mostra o estado vazio nas duas colunas quando não há contato nenhum", async () => {
    const domain = domainWith(vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 }));
    const { painel } = await abrirContatos(api(), domain);
    fireEvent.click(within(painel).getByRole("button", { name: "Já sincronizei — carregar contatos" }));
    await waitFor(() => expect(within(painel).getAllByText("Nenhum contato encontrado.")).toHaveLength(2));
    expect(within(painel).queryByRole("list")).toBeNull();
  });

  it("com nome e sem foto, o avatar são as iniciais", async () => {
    const { painel } = await abrirECarregar();
    expect(painel.querySelectorAll(".composer-contact-avatar")[0]?.textContent).toBe("AR");
    expect(contactInitials("Ana Ribeiro")).toBe("AR");
    expect(contactInitials("Ana")).toBe("A");
    expect(contactInitials("   ")).toBe("?");
  });

  it("mantém o envio desabilitado enquanto nada estiver marcado", async () => {
    const { painel } = await abrirECarregar();
    const enviar = within(painel).getByRole("button", { name: "Enviar contato" });
    expect(enviar).toBeDisabled();
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Ana Ribeiro" }));
    expect(enviar).toBeEnabled();
  });

  it("envia os dois contatos marcados numa chamada só", async () => {
    const { client, painel } = await abrirECarregar();
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Ana Ribeiro" }));
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Carla Souza" }));
    fireEvent.click(within(painel).getByRole("button", { name: "Enviar 2 contatos" }));
    await waitFor(() => expect(client.sendVcard).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      [CONTATOS[0]!.id, CONTATOS[2]!.id],
    ));
  });

  it("desmarcar tira o contato do envio", async () => {
    const { client, painel } = await abrirECarregar();
    const ana = within(painel).getByRole("checkbox", { name: "Ana Ribeiro" });
    fireEvent.click(ana);
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Bruno Carvalho" }));
    fireEvent.click(ana);
    fireEvent.click(within(painel).getByRole("button", { name: "Enviar contato" }));
    await waitFor(() => expect(client.sendVcard).toHaveBeenCalledWith(expect.any(String), [CONTATOS[1]!.id]));
  });

  it("sem nome, mostra só o telefone formatado — e não o mesmo número duas vezes", async () => {
    // Medido na base em 03/08/2026: boa parte dos contatos tem `displayName`
    // igual ao telefone. Era isso que punha o número em cima e embaixo na linha.
    const { painel } = await abrirECarregar(api(), domainWith(vi.fn().mockResolvedValue({ items: [SEM_NOME], page: 1, pageSize: 100, total: 1 })));
    const linha = await within(painel).findByText("+55 (85) 9236-9359");

    expect(within(painel).getAllByText(/9236-9359|558592369359/)).toHaveLength(1);
    // Uma linha de texto, não duas: sem nome não há subtítulo a mostrar.
    expect(linha.closest(".composer-contact-identity")!.children).toHaveLength(1);
  });

  it("sem nome, o avatar é silhueta e não o número dentro do círculo", async () => {
    const { painel } = await abrirECarregar(api(), domainWith(vi.fn().mockResolvedValue({ items: [SEM_NOME], page: 1, pageSize: 100, total: 1 })));
    await within(painel).findByText("+55 (85) 9236-9359");
    const avatar = painel.querySelector(".composer-contact-avatar")!;

    expect(avatar.textContent).toBe("");
    expect(avatar.querySelector("svg.composer-contact-silhouette")).toBeTruthy();
  });

  it("com nome, mostra nome em cima e telefone formatado embaixo", async () => {
    const { painel } = await abrirECarregar();
    const nome = await within(painel).findByText("Ana Ribeiro");

    expect(nome.closest(".composer-contact-identity")!.children).toHaveLength(2);
    expect(within(painel).getByText("+55 (11) 99999-0001")).toBeTruthy();
  });

  it("usa a foto quando ela existe, e as iniciais quando não", async () => {
    const comFoto = pessoa("eeeeeeee-5555-4555-8555-555555555555", "Ana Ribeiro", "5511999990001", "phonebook", "https://cdn.test/ana.jpg");
    const { painel } = await abrirECarregar(api(), domainWith(vi.fn().mockResolvedValue({ items: [comFoto, CONTATOS[1]], page: 1, pageSize: 100, total: 2 })));
    await within(painel).findByText("Ana Ribeiro");
    const avatares = painel.querySelectorAll(".composer-contact-avatar");

    expect(avatares[0].querySelector("img")?.getAttribute("src")).toBe("https://cdn.test/ana.jpg");
    expect(avatares[1].textContent).toBe("BC");
  });

  it("a linha é horizontal e de altura fixa, e a caixa de marcação fica nela", () => {
    // A regra global `label{flex-direction:column}` alcança este `<label>`. Sem
    // declarar a direção aqui, ela vence por omissão — medido em Chrome real:
    // a linha ia a 114 px, empilhada e com a caixa solta acima. Com a declaração,
    // 52 px. É o teste que impede a volta silenciosa.
    const regra = /\.chat-inbox \.composer-contact-row \{([^}]*)\}/.exec(stylesheet);
    expect(regra, "regra .composer-contact-row ausente").toBeTruthy();
    expect(regra![1]).toMatch(/flex-direction:\s*row/);
    expect(regra![1]).toMatch(/min-height:\s*\d+px/);
    expect(regra![1]).toMatch(/align-items:\s*center/);
    // E o avatar precisa recortar a foto no círculo.
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-contact-avatar \{[^}]*overflow:\s*hidden/);
    expect(stylesheet).toMatch(/\.chat-inbox \.composer-contact-avatar img \{[^}]*object-fit:\s*cover/);
  });

  it("trava a seleção no teto de 20 que o contrato aceita", async () => {
    const muitos = Array.from({ length: 25 }, (_, index) =>
      pessoa(`${index}`.padStart(8, "0") + "-5555-4555-8555-555555555555", `Pessoa ${index}`, `55119999${`${index}`.padStart(5, "0")}`, "phonebook"));
    const domain = domainWith(vi.fn().mockResolvedValue({ items: muitos, page: 1, pageSize: 100, total: 25 }));
    const { painel } = await abrirECarregar(api(), domain);
    const caixas = within(painel).getAllByRole("checkbox");
    for (let index = 0; index < 20; index += 1) fireEvent.click(caixas[index]!);
    expect(within(painel).getByText("Máximo de 20 contatos por envio.")).toBeInTheDocument();
    expect(caixas[20]).toBeDisabled();
    expect(caixas[0]).toBeEnabled();
  });

  /* Pela tela o teto é inalcançável: a caixa chega `disabled`. Estes três casos
     provam a regra que sobra atrás dele, e que é o que evita um 400 do servidor
     se o `disabled` algum dia sair. */
  it("a regra de seleção para no teto e continua desmarcando", () => {
    const cheio = Array.from({ length: 20 }, (_, index) => `id-${index}`);
    expect(toggleSelection(cheio, "id-novo", 20)).toHaveLength(20);
    expect(toggleSelection(cheio, "id-novo", 20)).not.toContain("id-novo");
    expect(toggleSelection(cheio, "id-3", 20)).toHaveLength(19);
    expect(toggleSelection(["id-1"], "id-2", 20)).toEqual(["id-1", "id-2"]);
  });

  it("fecha sem enviar pelo Cancelar", async () => {
    const { client, painel } = await abrirECarregar();
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Ana Ribeiro" }));
    fireEvent.click(within(painel).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Enviar contato" })).toBeNull());
    expect(client.sendVcard).not.toHaveBeenCalled();
  });

  it("fecha pelo clique no fundo do modal, como no WhatsApp", async () => {
    await abrirContatos();
    fireEvent.click(document.querySelector(".composer-contact-overlay")!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Enviar contato" })).toBeNull());
  });
});

describe("o que a linha mostra", () => {
  const contato = (displayName: string, phoneNumber: string, photoUrl?: string) => ({ id: "c", displayName, phoneNumber, ...(photoUrl ? { photoUrl } : {}) });

  it("nome de verdade vira título, telefone formatado vira subtítulo", () => {
    expect(contactRow(contato("Ana Ribeiro", "5511999990001")))
      .toEqual({ title: "Ana Ribeiro", subtitle: "+55 (11) 99999-0001", initials: "AR" });
  });

  it("nome que é o próprio telefone não é nome: uma linha, sem subtítulo e sem iniciais", () => {
    expect(contactRow(contato("558592369359", "558592369359")))
      .toEqual({ title: "+55 (85) 9236-9359" });
  });

  it("o teste é a forma, não a igualdade: dígitos diferentes também não são nome", () => {
    // Um número gravado no campo de nome não vira nome por ser outro número.
    expect(contactRow(contato("+55 85 9236 9359", "5511999990001")))
      .toEqual({ title: "+55 (11) 99999-0001" });
  });

  it("sem nome e sem telefone utilizável, cai no rótulo que a Inbox já usa", () => {
    expect(contactRow(contato("  ", "abc"))).toEqual({ title: "Contato sem identificação" });
  });

  it("a foto acompanha o título, com nome ou sem", () => {
    expect(contactRow(contato("Ana Ribeiro", "5511999990001", "u")).photoUrl).toBe("u");
    expect(contactRow(contato("558592369359", "558592369359", "u")).photoUrl).toBe("u");
    // String vazia não é foto: renderizar `<img src="">` recarrega a página.
    expect(contactRow(contato("Ana", "5511999990001", "   ")).photoUrl).toBeUndefined();
  });
});
