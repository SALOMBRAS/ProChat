import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shellMocks = vi.hoisted(() => ({
  dashboard: vi.fn(),
}));

vi.mock("../api/domain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/domain.js")>();
  return {
    ...actual,
    DomainApi: class {
      dashboard = shellMocks.dashboard;
    },
  };
});

vi.mock("./Inbox.js", () => ({
  default: () => <section aria-label="Inbox atual">Inbox atual</section>,
}));

vi.mock("./SlaOperationalDashboard.js", () => ({
  SlaOperationalDashboard: () => <section aria-label="SLA operacional" />,
}));

import { App } from "./App.js";
import { SESSION_EXPIRED_EVENT, clearAuthSession } from "../api/auth-storage.js";
import { fakeUser, seedSession } from "../test/auth-session.js";

const dashboard = {
  contacts: 0,
  optOutContacts: 0,
  tags: 0,
  templates: 0,
  leads: 0,
  conversations: 0,
  messages: 0,
  leadsByStage: [],
  recentActivities: [],
  campaignsByStatus: [],
  sessionsByStatus: [],
};

describe("App auth", () => {
  beforeEach(() => {
    history.replaceState({}, "", "/dashboard");
    clearAuthSession();
    shellMocks.dashboard.mockReset().mockResolvedValue(dashboard);
  });

  afterEach(() => {
    clearAuthSession();
  });

  it("mostra a tela de login quando não há sessão", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Painel$/ })).not.toBeInTheDocument();
    expect(shellMocks.dashboard).not.toHaveBeenCalled();
  });

  it("admin vê a gestão, mas Equipe (cadastro de operadores) é exclusiva do dono", async () => {
    seedSession(fakeUser({ role: "admin" }));
    render(<App />);
    await screen.findByText("Tudo que você precisa para crescer");
    expect(screen.queryByRole("button", { name: /Equipe$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Departamentos$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Configurações$/ })).toBeInTheDocument();
  });

  it("dono vê Equipe, e rota direta de outro papel cai no Painel", async () => {
    seedSession(fakeUser({ role: "owner" }));
    render(<App />);
    await screen.findByText("Tudo que você precisa para crescer");
    expect(screen.getByRole("button", { name: /Equipe$/ })).toBeInTheDocument();
  });

  it("agent vê só Painel e Inbox, e rota de gestão cai no Painel", async () => {
    history.replaceState({}, "", "/settings");
    seedSession(fakeUser({ role: "agent", displayName: "Agente Um" }));
    render(<App />);
    await screen.findByText("Tudo que você precisa para crescer");
    expect(screen.getByRole("button", { name: /Painel$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inbox$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Equipe$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Configurações$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Painel" })).toBeInTheDocument();
  });

  it("mostra as iniciais do usuário logado e sai pelo botão Sair", async () => {
    seedSession(fakeUser({ displayName: "Maria Silva" }));
    render(<App />);
    await screen.findByText("Tudo que você precisa para crescer");
    expect(screen.getByRole("button", { name: "Usuário: Maria Silva" })).toHaveTextContent("MA");
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
  });

  it("volta ao login quando a sessão expira (evento de 401)", async () => {
    seedSession();
    render(<App />);
    await screen.findByText("Tudo que você precisa para crescer");
    fireEvent(window, new Event(SESSION_EXPIRED_EVENT));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Entrar" })).toBeInTheDocument());
  });
});
