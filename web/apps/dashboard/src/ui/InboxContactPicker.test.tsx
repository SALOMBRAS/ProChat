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
 * A PR #53 entregou o envio de cartão de contato com `window.prompt` duas vezes:
 * uma para o termo de busca e outra para o número do item numa lista numerada
 * colada dentro da caixa branca do sistema. Aqui isso vira tela própria, com
 * busca, lista, seleção por caixa de marcação e envio de mais de um contato —
 * que o contrato já aceitava (`.min(1).max(20)`) e ninguém usava.
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

const pessoa = (id: string, displayName: string, phoneNumber: string, photoUrl?: string) => ({
  id, workspaceId: "workspace-a", displayName, phoneNumber, ...(photoUrl ? { photoUrl } : {}),
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T10:00:00.000Z",
});
/** O caso da base: 66 dos 93 contatos têm `displayName` idêntico ao telefone. */
const SEM_NOME = pessoa("dddddddd-4444-4444-8444-444444444444", "558592369359", "558592369359");
const CONTATOS = [
  pessoa("aaaaaaaa-1111-4111-8111-111111111111", "Ana Ribeiro", "5511999990001"),
  pessoa("bbbbbbbb-2222-4222-8222-222222222222", "Bruno Carvalho", "5511999990002"),
  pessoa("cccccccc-3333-4333-8333-333333333333", "Carla Souza", "5511999990003"),
];

const domainWith = (contacts = vi.fn().mockResolvedValue({ items: CONTATOS, page: 1, pageSize: 20, total: CONTATOS.length })) =>
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

beforeEach(() => { Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), configurable: true }); });
afterEach(() => vi.restoreAllMocks());

describe("escolha de contato para envio", () => {
  it("abre uma tela própria em vez de chamar o prompt do navegador", async () => {
    const prompt = vi.spyOn(window, "prompt");
    const { painel } = await abrirContatos();
    expect(painel).toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("lista nome e telefone dos contatos que a busca devolveu", async () => {
    const { painel } = await abrirContatos();
    const lista = await within(painel).findByRole("list", { name: "Contatos encontrados" });
    expect(within(lista).getByText("Ana Ribeiro")).toBeInTheDocument();
    // Formatado, não os dígitos crus: é o telefone que o operador lê em voz alta.
    expect(within(lista).getByText("+55 (11) 99999-0001")).toBeInTheDocument();
    expect(within(lista).queryByText("5511999990001")).toBeNull();
    expect(within(lista).getAllByRole("checkbox")).toHaveLength(3);
  });

  it("com nome e sem foto, o avatar são as iniciais", async () => {
    const { painel } = await abrirContatos();
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
    expect(painel.querySelectorAll(".composer-contact-avatar")[0]?.textContent).toBe("AR");
    expect(contactInitials("Ana Ribeiro")).toBe("AR");
    expect(contactInitials("Ana")).toBe("A");
    expect(contactInitials("   ")).toBe("?");
  });

  it("mantém o envio desabilitado enquanto nada estiver marcado", async () => {
    const { painel } = await abrirContatos();
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
    const enviar = within(painel).getByRole("button", { name: "Enviar contato" });
    expect(enviar).toBeDisabled();
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Ana Ribeiro" }));
    expect(enviar).toBeEnabled();
  });

  it("envia os dois contatos marcados numa chamada só", async () => {
    const { client, painel } = await abrirContatos();
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Ana Ribeiro" }));
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Carla Souza" }));
    fireEvent.click(within(painel).getByRole("button", { name: "Enviar 2 contatos" }));
    await waitFor(() => expect(client.sendVcard).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      [CONTATOS[0]!.id, CONTATOS[2]!.id],
    ));
  });

  it("desmarcar tira o contato do envio", async () => {
    const { client, painel } = await abrirContatos();
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
    const ana = within(painel).getByRole("checkbox", { name: "Ana Ribeiro" });
    fireEvent.click(ana);
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Bruno Carvalho" }));
    fireEvent.click(ana);
    fireEvent.click(within(painel).getByRole("button", { name: "Enviar contato" }));
    await waitFor(() => expect(client.sendVcard).toHaveBeenCalledWith(expect.any(String), [CONTATOS[1]!.id]));
  });

  it("pede a busca ao banco em vez de filtrar a lista carregada", async () => {
    const { domain, painel } = await abrirContatos();
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
    fireEvent.change(within(painel).getByLabelText("Buscar contato por nome, telefone ou e-mail"), { target: { value: "carla" } });
    await waitFor(() => expect(domain.contacts).toHaveBeenCalledWith(expect.objectContaining({ search: "carla", page: 1 })));
  });

  it("mostra o estado vazio quando a busca não devolve nada", async () => {
    const domain = domainWith(vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }));
    const { painel } = await abrirContatos(api(), domain);
    expect(await within(painel).findByText("Nenhum contato encontrado.")).toBeInTheDocument();
    expect(within(painel).queryByRole("list", { name: "Contatos encontrados" })).toBeNull();
  });

  it("mostra o estado de carregamento antes de a busca responder", async () => {
    let liberar: (value: unknown) => void = () => {};
    const domain = domainWith(vi.fn().mockImplementation(() => new Promise((resolve) => { liberar = resolve; })));
    const { painel } = await abrirContatos(api(), domain);
    expect(within(painel).getByText("Carregando contatos…")).toBeInTheDocument();
    liberar({ items: CONTATOS, page: 1, pageSize: 20, total: CONTATOS.length });
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
  });

  it("avisa quando a busca falha, em vez de ficar em carregando", async () => {
    const domain = domainWith(vi.fn().mockRejectedValue(new Error("rede")));
    const { painel } = await abrirContatos(api(), domain);
    expect(await within(painel).findByRole("alert")).toHaveTextContent("Não foi possível buscar os contatos.");
  });

  it("carrega a próxima página sob demanda, somando à lista", async () => {
    const contacts = vi.fn()
      .mockResolvedValueOnce({ items: CONTATOS, page: 1, pageSize: 20, total: 4 })
      .mockResolvedValueOnce({ items: [pessoa("dddddddd-4444-4444-8444-444444444444", "Diego Alves", "5511999990004")], page: 2, pageSize: 20, total: 4 });
    const { painel } = await abrirContatos(api(), domainWith(contacts));
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
    fireEvent.click(within(painel).getByRole("button", { name: /Carregar mais/ }));
    expect(await within(painel).findByText("Diego Alves")).toBeInTheDocument();
    expect(within(painel).getByText("Ana Ribeiro")).toBeInTheDocument();
    expect(contacts).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
  });

  it("sem nome, mostra só o telefone formatado — e não o mesmo número duas vezes", async () => {
    // Medido na base em 03/08/2026: 66 dos 93 contatos têm `displayName` igual ao
    // telefone. Era isso que punha "558592369359" em cima e embaixo na mesma linha.
    const { painel } = await abrirContatos(api(), domainWith(vi.fn().mockResolvedValue({ items: [SEM_NOME], page: 1, pageSize: 20, total: 1 })));
    const linha = await within(painel).findByText("+55 (85) 9236-9359");

    expect(within(painel).getAllByText(/9236-9359|558592369359/)).toHaveLength(1);
    // Uma linha de texto, não duas: sem nome não há subtítulo a mostrar.
    expect(linha.closest(".composer-contact-identity")!.children).toHaveLength(1);
  });

  it("sem nome, o avatar é silhueta e não o número dentro do círculo", async () => {
    const { painel } = await abrirContatos(api(), domainWith(vi.fn().mockResolvedValue({ items: [SEM_NOME], page: 1, pageSize: 20, total: 1 })));
    await within(painel).findByText("+55 (85) 9236-9359");
    const avatar = painel.querySelector(".composer-contact-avatar")!;

    expect(avatar.textContent).toBe("");
    expect(avatar.querySelector("svg.composer-contact-silhouette")).toBeTruthy();
  });

  it("com nome, mostra nome em cima e telefone formatado embaixo", async () => {
    const { painel } = await abrirContatos();
    const nome = await within(painel).findByText("Ana Ribeiro");

    expect(nome.closest(".composer-contact-identity")!.children).toHaveLength(2);
    expect(within(painel).getByText("+55 (11) 99999-0001")).toBeTruthy();
  });

  it("usa a foto quando ela existe, e as iniciais quando não", async () => {
    // A foto não chega por este contrato hoje — 552 das 748 identidades têm
    // `profile_picture_url`, e `/domain/contacts` não devolve o campo. A lista já
    // sabe desenhá-la para o dia em que ele for exposto.
    const comFoto = pessoa("eeeeeeee-5555-4555-8555-555555555555", "Ana Ribeiro", "5511999990001", "https://cdn.test/ana.jpg");
    const { painel } = await abrirContatos(api(), domainWith(vi.fn().mockResolvedValue({ items: [comFoto, CONTATOS[1]], page: 1, pageSize: 20, total: 2 })));
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

  it("não oferece carregar mais quando a lista já tem tudo", async () => {
    const { painel } = await abrirContatos();
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
    expect(within(painel).queryByRole("button", { name: /Carregar mais/ })).toBeNull();
  });

  it("trava a seleção no teto de 20 que o contrato aceita", async () => {
    const muitos = Array.from({ length: 25 }, (_, index) =>
      pessoa(`${index}`.padStart(8, "0") + "-5555-4555-8555-555555555555", `Pessoa ${index}`, `55119999${`${index}`.padStart(5, "0")}`));
    const domain = domainWith(vi.fn().mockResolvedValue({ items: muitos, page: 1, pageSize: 25, total: 25 }));
    const { painel } = await abrirContatos(api(), domain);
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
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
    const { client, painel } = await abrirContatos();
    await within(painel).findByRole("list", { name: "Contatos encontrados" });
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Ana Ribeiro" }));
    fireEvent.click(within(painel).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Enviar contato" })).toBeNull());
    expect(client.sendVcard).not.toHaveBeenCalled();
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
