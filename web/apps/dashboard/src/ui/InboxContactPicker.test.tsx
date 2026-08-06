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
 * O picker é janela flutuante no padrão WhatsApp: abre MOSTRANDO os contatos
 * salvos no celular (~150, filtro `origin=phonebook` no servidor) — não a
 * base inteira, que já passa de dezenas de milhares. A lupa pesquisa o resto
 * NO SERVIDOR, em lotes de 150 com "Carregar mais", e o botão "Sincronizar
 * contatos" do cabeçalho puxa o que mudou desde a última vez.
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

/** O mock honra o contrato de verdade — `origin`, `search`, `page` e
 *  `pageSize` — porque agora é o SERVIDOR quem filtra e pagina: o picker
 *  abre só com o celular e a lupa pesquisa em lotes. Um mock que ignora a
 *  query não mediria nada disso. */
const contatosQueRespondem = (base = CONTATOS) =>
  vi.fn().mockImplementation((q: Record<string, unknown> = {}) => {
    let list = base;
    if (q.origin === "phonebook") list = list.filter((contact) => contact.origin === "phonebook");
    if (q.origin === "history") list = list.filter((contact) => contact.origin !== "phonebook");
    if (typeof q.search === "string" && q.search.trim()) {
      const texto = q.search.trim().toLowerCase();
      const digitos = texto.replace(/\D/g, "");
      list = list.filter((contact) => contact.displayName.toLowerCase().includes(texto) || (digitos.length > 0 && contact.phoneNumber.includes(digitos)));
    }
    const page = Number(q.page ?? 1);
    const size = Number(q.pageSize ?? 25);
    return Promise.resolve({ items: list.slice((page - 1) * size, page * size), page, pageSize: size, total: list.length });
  });

const domainWith = (contacts = contatosQueRespondem()) =>
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
/** O caminho feliz: abre e a última sincronização aparece sozinha. */
const abrirECarregar = async (client = api(), domain = domainWith()) => {
  const aberto = await abrirContatos(client, domain);
  await within(aberto.painel).findByRole("list", { name: "Contatos" });
  return aberto;
};

beforeEach(() => { Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), configurable: true }); });
afterEach(() => vi.restoreAllMocks());

describe("escolha de contato para envio", () => {
  it("abre a janela flutuante já carregando a última sincronização, com o sync no cabeçalho e sem prompt", async () => {
    const prompt = vi.spyOn(window, "prompt");
    const { domain, painel } = await abrirContatos();
    expect(painel).toBeInTheDocument();
    expect(document.querySelector(".composer-contact-overlay")).toBeInTheDocument();
    expect(within(painel).getByRole("button", { name: "Sincronizar contatos" })).toBeInTheDocument();
    expect(await within(painel).findByRole("list", { name: "Contatos" })).toBeInTheDocument();
    expect(domain.contacts).toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("lista nome e telefone depois do carregamento, com o telefone formatado", async () => {
    const { painel } = await abrirECarregar();
    const lista = within(painel).getByRole("list", { name: "Contatos" });
    expect(within(lista).getByText("Ana Ribeiro")).toBeInTheDocument();
    // Formatado, não os dígitos crus: é o telefone que o operador lê em voz alta.
    expect(within(lista).getByText("+55 (11) 99999-0001")).toBeInTheDocument();
    expect(within(lista).queryByText("5511999990001")).toBeNull();
    // Só os dois do celular: Bruno é histórico e chega pela lupa, não na abertura.
    expect(within(painel).getAllByRole("checkbox")).toHaveLength(2);
  });

  it("abre mostrando só os salvos no celular, pedidos ao servidor com o filtro de origem", async () => {
    const contacts = contatosQueRespondem();
    const { painel } = await abrirECarregar(api(), domainWith(contacts));
    const lista = within(painel).getByRole("list", { name: "Contatos" });
    expect(within(lista).getByText("Ana Ribeiro")).toBeInTheDocument();
    expect(within(lista).getByText("Carla Souza")).toBeInTheDocument();
    // Bruno é histórico de conversas: NÃO aparece na abertura — é o que
    // impede a tela de baixar a base inteira de graça.
    expect(within(lista).queryByText("Bruno Carvalho")).toBeNull();
    expect(contacts).toHaveBeenCalledWith(expect.objectContaining({ origin: "phonebook" }));
  });

  it("a lupa encontra quem não está no celular, pesquisando no servidor", async () => {
    const contacts = contatosQueRespondem();
    const { painel } = await abrirECarregar(api(), domainWith(contacts));
    fireEvent.change(within(painel).getByLabelText("Buscar contato por nome ou telefone"), { target: { value: "bruno" } });
    // 300 ms de debounce e então a consulta: o termo vai ao SERVIDOR, não a
    // um filtro local sobre a lista aberta.
    await waitFor(() => expect(contacts).toHaveBeenCalledWith(expect.objectContaining({ search: "bruno", page: 1, pageSize: 150 })));
    const lista = await within(painel).findByRole("list", { name: "Contatos" });
    expect(await within(lista).findByText("Bruno Carvalho")).toBeInTheDocument();
    expect(within(lista).queryByText("Ana Ribeiro")).toBeNull();
  });

  it("limpar a lupa devolve a lista do celular sem nova consulta", async () => {
    const contacts = contatosQueRespondem();
    const { painel } = await abrirECarregar(api(), domainWith(contacts));
    const campo = within(painel).getByLabelText("Buscar contato por nome ou telefone");
    fireEvent.change(campo, { target: { value: "bruno" } });
    await waitFor(() => expect(contacts).toHaveBeenCalledWith(expect.objectContaining({ search: "bruno" })));
    const chamadas = contacts.mock.calls.length;
    fireEvent.change(campo, { target: { value: "" } });
    const lista = within(painel).getByRole("list", { name: "Contatos" });
    await waitFor(() => expect(within(lista).getByText("Ana Ribeiro")).toBeInTheDocument());
    expect(contacts.mock.calls.length).toBe(chamadas);
  });

  it("a busca vem em lotes: Carregar mais traz a página seguinte, sem repetir contato", async () => {
    const lote1 = Array.from({ length: 3 }, (_, index) => pessoa(`eeeeeee${index}-1111-4111-8111-111111111111`, `Zelia ${index}`, `551188888000${index}`, "history"));
    const contacts = vi.fn().mockImplementation((q: Record<string, unknown> = {}) => {
      if (q.origin === "phonebook") return Promise.resolve({ items: CONTATOS.filter((c) => c.origin === "phonebook"), page: 1, pageSize: 150, total: 2 });
      const page = Number(q.page ?? 1);
      // Página 2 repete o último da página 1 — contato criado durante a
      // paginação — e a união por id é o que impede a linha duplicada.
      const items = page === 1 ? lote1 : [lote1[2], pessoa("ffffffff-9999-4999-8999-999999999999", "Zuleica", "5511888889999", "history")];
      return Promise.resolve({ items, page, pageSize: 150, total: 4 });
    });
    const { painel } = await abrirECarregar(api(), domainWith(contacts));
    fireEvent.change(within(painel).getByLabelText("Buscar contato por nome ou telefone"), { target: { value: "z" } });
    expect(await within(painel).findByText("Zelia 0")).toBeInTheDocument();
    const mais = within(painel).getByRole("button", { name: /Carregar mais \(3 de 4\)/ });
    fireEvent.click(mais);
    await waitFor(() => expect(contacts).toHaveBeenCalledWith(expect.objectContaining({ search: "z", page: 2 })));
    expect(await within(painel).findByText("Zuleica")).toBeInTheDocument();
    expect(within(painel).getAllByText("Zelia 2")).toHaveLength(1); // sem duplicar
    expect(within(painel).queryByRole("button", { name: /Carregar mais/ })).toBeNull();
  });

  it("a abertura pagina o celular inteiro, de 150 em 150, sem botão de carregar mais", async () => {
    const contacts = vi.fn().mockImplementation((q: Record<string, unknown> = {}) => {
      const page = Number(q.page ?? 1);
      const items = page === 1
        ? [CONTATOS[0], CONTATOS[2]]
        : [pessoa("dddddddd-4444-4444-8444-444444444444", "Diego Alves", "5511999990004", "phonebook")];
      return Promise.resolve({ items, page, pageSize: 150, total: 3 });
    });
    const { painel } = await abrirECarregar(api(), domainWith(contacts));
    expect(await within(painel).findByText("Diego Alves")).toBeInTheDocument();
    expect(within(painel).getByText("Ana Ribeiro")).toBeInTheDocument();
    expect(contacts).toHaveBeenLastCalledWith(expect.objectContaining({ origin: "phonebook", page: 2, pageSize: 150 }));
    expect(within(painel).queryByRole("button", { name: /Carregar mais/ })).toBeNull();
  });

  it("mostra o estado de carregamento antes de a listagem responder", async () => {
    let liberar: (value: unknown) => void = () => {};
    const domain = domainWith(vi.fn().mockImplementation(() => new Promise((resolve) => { liberar = resolve; })));
    const { painel } = await abrirContatos(api(), domain);
    expect(await within(painel).findByText("Carregando contatos…")).toBeInTheDocument();
    liberar({ items: CONTATOS, page: 1, pageSize: 100, total: CONTATOS.length });
    await within(painel).findByRole("list", { name: "Contatos" });
  });

  it("avisa quando o carregamento falha e oferece Tentar novamente", async () => {
    const domain = domainWith(vi.fn().mockRejectedValue(new Error("rede")));
    const { painel } = await abrirContatos(api(), domain);
    expect(await within(painel).findByRole("alert")).toHaveTextContent("Não foi possível carregar os contatos.");
    expect(within(painel).getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
  });

  it("mostra o estado vazio quando o celular ainda não foi sincronizado, apontando o botão", async () => {
    const domain = domainWith(vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 }));
    const { painel } = await abrirContatos(api(), domain);
    expect(await within(painel).findByText(/Nenhum contato do celular por aqui/)).toBeInTheDocument();
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
    fireEvent.click(within(painel).getByRole("checkbox", { name: "Carla Souza" }));
    fireEvent.click(ana);
    fireEvent.click(within(painel).getByRole("button", { name: "Enviar contato" }));
    await waitFor(() => expect(client.sendVcard).toHaveBeenCalledWith(expect.any(String), [CONTATOS[2]!.id]));
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
    const semFoto = pessoa("bbbbbbbb-2222-4222-8222-222222222222", "Bruno Carvalho", "5511999990002", "phonebook");
    const { painel } = await abrirECarregar(api(), domainWith(vi.fn().mockResolvedValue({ items: [comFoto, semFoto], page: 1, pageSize: 100, total: 2 })));
    await within(painel).findByText("Ana Ribeiro");
    const avatares = painel.querySelectorAll(".composer-contact-avatar");

    expect(avatares[0].querySelector("img")?.getAttribute("src")).toBe("https://cdn.test/ana.jpg");
    expect(avatares[1].textContent).toBe("BC");
  });

  it("mostra o nome do WhatsApp quando o nome interno é só dígitos — o caso dos contatos LID", async () => {
    // Medido na base em 05/08/2026: a maioria dos contatos tem `displayName`
    // igual a um LID de 14-15 dígitos. O nome de verdade chega na listagem via
    // `whatsappName`/`whatsappPushName` (enriquecimento de identidade).
    const lid = { ...pessoa("ffffffff-6666-4666-8666-666666666666", "74599337345125", "74599337345125", "phonebook"), whatsappName: "Pizzaria Jana", photoUrl: "https://cdn.test/pizzaria.jpg" };
    const { painel } = await abrirContatos(api(), domainWith(vi.fn().mockResolvedValue({ items: [lid], page: 1, pageSize: 100, total: 1 })));
    const lista = await within(painel).findByRole("list", { name: "Contatos" });

    expect(within(lista).getByText("Pizzaria Jana")).toBeInTheDocument();
    expect(within(lista).getByText("74599337345125")).toBeInTheDocument(); // o número fica embaixo, até a cura trazer o real
    expect(lista.querySelector(".composer-contact-avatar img")?.getAttribute("src")).toBe("https://cdn.test/pizzaria.jpg");
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

  it("nome interno só de dígitos cede lugar ao nome do WhatsApp", () => {
    expect(contactRow({ id: "c", displayName: "74599337345125", phoneNumber: "74599337345125", whatsappName: "Pizzaria Jana" }))
      .toEqual({ title: "Pizzaria Jana", subtitle: "74599337345125", initials: "PJ" });
  });

  it("o nome do CRM continua vencendo o nome do WhatsApp", () => {
    expect(contactRow({ id: "c", displayName: "Ana Ribeiro", phoneNumber: "5511999990001", whatsappName: "Ana" }))
      .toEqual({ title: "Ana Ribeiro", subtitle: "+55 (11) 99999-0001", initials: "AR" });
  });

  it("sem nome salvo, vale o pushName do perfil WhatsApp", () => {
    expect(contactRow({ id: "c", displayName: "74599337345125", phoneNumber: "74599337345125", whatsappPushName: "Lucia Mãe" }).title)
      .toBe("Lucia Mãe");
  });
});
