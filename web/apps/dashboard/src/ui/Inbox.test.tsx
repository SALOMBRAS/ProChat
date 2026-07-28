import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { InboxApi, InboxConversation, Page } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({
  WorkspaceApi: class {
    users = async () => [];
    teams = async () => [];
  },
}));

import Inbox from "./Inbox.js";

const conversation = (
  id: string,
  overrides: Partial<InboxConversation> = {},
): InboxConversation => ({
  id,
  whatsappSessionId: "session-a",
  chatId: `551199999000${id.slice(-1)}@c.us`,
  contactId: null,
  conversationType: "direct",
  assignedUserId: null,
  assignedTeamId: null,
  assignedAt: null,
  routingQueueId: null,
  autoAssignedAt: null,
  routingLockedAt: null,
  status: "in_progress",
  priority: "normal",
  lastStatusChange: null,
  lastMessage: "Bom dia! Consegui resolver aquilo que conversamos ontem",
  lastMessageAt: "2026-07-28T12:00:00.000Z",
  unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T12:00:00.000Z",
  identity: {
    displayName: "Ana Beatriz",
    phone: "5511999990001",
    pushName: "Ana Beatriz",
    profileName: "Ana Beatriz",
    avatarUrl: null,
    lastSyncAt: null,
    syncStatus: "synced",
    knownContact: true,
  },
  ...overrides,
});

const conversations = [
  conversation("11111111-1111-4111-8111-111111111111", { unreadCount: 12 }),
  conversation("22222222-2222-4222-8222-222222222222"),
];

const emptyPage = <T,>(): Page<T> => ({ items: [], page: 1, pageSize: 50, total: 0 });

const stubApi = () =>
  ({
    conversations: vi.fn().mockResolvedValue({ items: conversations, page: 1, pageSize: 50, total: conversations.length }),
    messages: vi.fn().mockResolvedValue(emptyPage()),
    markRead: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
    activity: vi.fn().mockResolvedValue([]),
    slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA no teste")),
  }) as unknown as InboxApi;

const listItems = (root: ParentNode) => [
  ...root.querySelectorAll<HTMLButtonElement>(".chat-inbox .conversation-item"),
];

// ---------------------------------------------------------------------------
// Cor: as asserções de contraste comparam superfícies reais, então precisam
// compor as cores translúcidas sobre o fundo da coluna antes de medir.
// ---------------------------------------------------------------------------
type Rgba = [number, number, number, number];

const parseColor = (value: string): Rgba | undefined => {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1];
    const size = digits.length <= 4 ? 1 : 2;
    const parts = digits
      .match(new RegExp(`.{${size}}`, "g"))!
      .map((part) => Number.parseInt(size === 1 ? part + part : part, 16));
    return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3] / 255];
  }
  const rgb = /rgba?\(([^)]+)\)/i.exec(value);
  if (!rgb) return undefined;
  const parts = rgb[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
};

const over = (top: Rgba, bottom: Rgba): Rgba => [
  top[3] * top[0] + (1 - top[3]) * bottom[0],
  top[3] * top[1] + (1 - top[3]) * bottom[1],
  top[3] * top[2] + (1 - top[3]) * bottom[2],
  1,
];

const luminance = ([r, g, b]: Rgba) => {
  const channel = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: Rgba, b: Rgba) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

const colorsIn = (value: string) =>
  [...value.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)/gi)]
    .map((match) => parseColor(match[0]))
    .filter((color): color is Rgba => color !== undefined);

/** Cor que o olho enxerga no elemento: gradiente (média das paradas) ou cor sólida,
 *  composta sobre o fundo herdado. Sem tratar `background-image` um card pintado
 *  de roxo passaria por transparente — que é justamente o estado sob vigilância. */
const surfaceOf = (element: Element, base: Rgba): Rgba => {
  const style = getComputedStyle(element);
  const stops = colorsIn(style.backgroundImage || "");
  const painted = over(parseColor(style.backgroundColor || "") ?? [0, 0, 0, 0], base);
  if (!stops.length) return painted;
  const average = [0, 1, 2, 3].map(
    (channel) => stops.reduce((sum, stop) => sum + stop[channel], 0) / stops.length,
  ) as Rgba;
  return over(average, painted);
};

const px = (value: string) => Number.parseFloat(value || "0") || 0;

/** styles.css mistura blocos minificados (`.a{…}`) e legíveis (`.a { … }`).
 *  Junta todas as declarações do seletor exato, em qualquer um dos formatos. */
const cssDeclarationsFor = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?<=[};]|\\*/)\\s*(?:/\\*[^{}]*?\\*/\\s*)*${escaped}\\s*\\{([^}]*)\\}`, "g");
  const blocks = [...stylesheet.matchAll(rule)].map((match) => match[1]);
  expect(blocks.length, `regra ${selector} ausente em styles.css`).toBeGreaterThan(0);
  return blocks.join(";");
};

// ---------------------------------------------------------------------------
// O componente real é montado UMA vez, e a marcação que ele produziu vira o fixture
// dos testes de estilo. Duas razões: `getComputedStyle` sobre a árvore viva inteira,
// com styles.css completo, é proibitivamente caro em jsdom; e, como o HTML vem do
// próprio Inbox, o fixture não tem como divergir do componente.
// ---------------------------------------------------------------------------
let capturedList = "";

beforeAll(async () => {
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);

  const view = render(<Inbox api={stubApi()} />);
  await waitFor(() => expect(listItems(view.container)).toHaveLength(2));
  // Seleciona a conversa com não lidas: assim o fixture tem um card selecionado
  // COM badge e um card comum, que são os dois estados sob teste.
  fireEvent.click(listItems(view.container)[0]);
  await waitFor(() => expect(listItems(view.container)[0]).toHaveClass("selected"));
  capturedList = view.container.querySelector(".inbox-list")!.innerHTML;
  view.unmount();
  document.body.innerHTML = "";
});

let chosen: HTMLElement;
let plain: HTMLElement;
let base: Rgba;

beforeEach(() => {
  document.body.innerHTML = `<section class="page inbox chat-inbox"><div class="inbox-layout"><aside class="inbox-list">${capturedList}</aside></div></section>`;
  [chosen, plain] = listItems(document) as HTMLElement[];
  // Fundo herdado da coluna, lido do próprio stylesheet em vez de fixado no teste.
  base = colorsIn(getComputedStyle(document.querySelector(".inbox-layout")!).backgroundImage || "")[0] ?? [21, 21, 39, 1];
});

describe("Inbox — separação visual entre conversas", () => {
  // O fixture é a saída do componente real, então isto fixa o contrato de marcação
  // de que todas as regras de separação dependem.
  it("renderiza cada conversa como um card próprio, com badge de não lidas e marca de seleção", () => {
    expect(plain.className).toBe("conversation-item");
    expect(chosen.className).toBe("conversation-item selected");
    expect(within(chosen).getByText("12")).toHaveClass("unread");
    expect(plain.querySelector(".unread")).toBeNull();
    expect(chosen.querySelector(".conversation-content")).toBeTruthy();
  });

  it("tira o card da regra genérica de <button>, que vencia por especificidade", () => {
    // `button:not(.nav):not(.text-button):not(.icon-button):not(.profile-button)`
    // tem especificidade (0,4,1) e vencia `.chat-inbox .conversation-item` (0,2,0):
    // todo card recebia o gradiente roxo do botão e a lista virava um bloco só.
    expect(getComputedStyle(plain).backgroundImage).not.toMatch(/gradient/);
    expect(surfaceOf(plain, base)[2]).toBeLessThan(60); // sem o azul do roxo

    const genericButtonRule = /button(?::not\([^)]*\))+\s*\{[^}]*linear-gradient[^}]*\}/.exec(stylesheet);
    expect(genericButtonRule?.[0], "regra genérica de botão não encontrada").toBeTruthy();
    expect(genericButtonRule![0]).toContain(":not(.conversation-item)");
  });

  it("separa os cards com divisória e espaçamento", () => {
    const style = getComputedStyle(plain);

    // Espaçamento: existe vão entre um card e o seguinte.
    expect(px(style.marginBottom)).toBeGreaterThan(0);
    // Divisória: o card é contornado, e o contorno é visível sobre a coluna.
    expect(px(style.borderTopWidth)).toBeGreaterThanOrEqual(1);
    expect(px(style.borderBottomWidth)).toBeGreaterThanOrEqual(1);
    expect(contrast(over(parseColor(style.borderTopColor)!, base), base)).toBeGreaterThan(1.1);
    // Superfície: o card se distingue do fundo da coluna mesmo sem hover.
    expect(surfaceOf(plain, base)).not.toEqual(base);
  });

  it("paga o espaçamento com o padding interno, sem custar altura de linha", () => {
    const card = getComputedStyle(plain);
    const content = getComputedStyle(plain.querySelector(".conversation-content")!);

    // Orçamento vertical por linha, fora o texto: padding + bordas + vão + os dois
    // gaps entre as três linhas do card. Antes da mudança era 10+10+0+1+0+5+5 = 31px
    // (o padding vinha da regra genérica de botão). O passo medido no Chrome era, e
    // continua sendo, 85px por conversa — nenhuma conversa a menos por tela.
    const chrome =
      px(card.paddingTop) +
      px(card.paddingBottom) +
      px(card.borderTopWidth) +
      px(card.borderBottomWidth) +
      px(card.marginBottom) +
      2 * px(content.gap);

    expect(chrome).toBeGreaterThan(0); // as longhands foram mesmo resolvidas
    expect(chrome).toBeLessThanOrEqual(31);
  });

  it("mantém o card selecionado claramente distinguível do não selecionado", () => {
    const chosenSurface = surfaceOf(chosen, base);
    const plainSurface = surfaceOf(plain, base);
    expect(chosenSurface).not.toEqual(plainSurface);

    // O preenchimento sozinho é sutil de propósito (senão abafa o badge de não
    // lidas), então a distinção precisa vir também de sinais de alto contraste:
    // o contorno claro e a barra lateral.
    const chosenStyle = getComputedStyle(chosen);
    const plainBorder = over(parseColor(getComputedStyle(plain).borderTopColor)!, plainSurface);
    const chosenBorder = over(parseColor(chosenStyle.borderTopColor)!, chosenSurface);
    expect(contrast(chosenBorder, plainBorder)).toBeGreaterThanOrEqual(1.8);

    const accent = colorsIn(chosenStyle.boxShadow)[0];
    expect(accent, "estado selecionado sem barra lateral").toBeTruthy();
    expect(contrast(over(accent!, chosenSurface), plainSurface)).toBeGreaterThanOrEqual(3);

    // E o nome do contato acompanha, ficando mais claro no card selecionado.
    const nameColor = (item: HTMLElement) =>
      parseColor(getComputedStyle(item.querySelector(".conversation-top strong")!).color)!;
    expect(luminance(nameColor(chosen))).toBeGreaterThan(luminance(nameColor(plain)));
  });

  it("não confunde selecionado com hover", () => {
    // Antes os dois estados dividiam a mesma declaração
    // (`.conversation-item:hover,.conversation-item.selected{background:#8b5cf619}`),
    // então passar o mouse parecia selecionar.
    expect(cssDeclarationsFor(".chat-inbox .conversation-item:hover")).not.toEqual(
      cssDeclarationsFor(".chat-inbox .conversation-item.selected"),
    );
    expect(cssDeclarationsFor(".chat-inbox .conversation-item.selected")).toMatch(/box-shadow/);
    expect(cssDeclarationsFor(".chat-inbox .conversation-item:focus-visible")).toMatch(/outline/);
  });

  it("mantém o badge de não lidas destacado nos dois estados do card", () => {
    const element = chosen.querySelector(".unread")!;
    const badge = parseColor(getComputedStyle(element).backgroundColor)!;

    // Sobre o card roxo antigo o badge ficava a ~1,1:1 do fundo — ilegível.
    expect(contrast(badge, surfaceOf(chosen, base))).toBeGreaterThanOrEqual(3);
    expect(contrast(badge, surfaceOf(plain, base))).toBeGreaterThanOrEqual(3);
    // O peso do número vinha da regra genérica de botão; ao sair dela o badge
    // afinaria para o peso normal se não fosse declarado aqui.
    expect(Number(getComputedStyle(element).fontWeight)).toBeGreaterThanOrEqual(700);
  });

  it("deixa a prévia encolher para o badge e a hora caberem em viewport estreita", () => {
    // `.conversation-top`/`.conversation-bottom` são itens de grid: com
    // `min-width:auto` o texto `nowrap` definia o tamanho mínimo e empurrava a hora
    // e o badge para fora do card (medido em 320px: badge 160px fora, clipado).
    // Com `min-width:0` a prévia reticencia e os dois ficam sempre dentro do card.
    // Sem a regra o valor computado vem vazio; com ela, zero.
    expect(getComputedStyle(plain.querySelector(".conversation-top")!).minWidth).toMatch(/^0(px)?$/);
    expect(getComputedStyle(plain.querySelector(".conversation-bottom")!).minWidth).toMatch(/^0(px)?$/);
    expect(cssDeclarationsFor(".conversation-top strong,.conversation-preview")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("usa apenas tokens de cor já presentes em styles.css", () => {
    const separation = [
      ".chat-inbox .conversation-item",
      ".chat-inbox .conversation-item:hover",
      ".chat-inbox .conversation-item.selected",
      ".chat-inbox .conversation-item:focus-visible",
      ".chat-inbox .unread",
    ]
      .map(cssDeclarationsFor)
      .join(";");

    const used = [...new Set([...separation.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]))];
    expect(used.length).toBeGreaterThan(0);
    for (const token of used) {
      const occurrences = stylesheet.split(token).length - 1;
      expect(occurrences, `${token} é uma cor nova: só aparece nas regras de separação`).toBeGreaterThan(1);
    }
  });
});
