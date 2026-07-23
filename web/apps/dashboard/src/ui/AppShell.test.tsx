import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  SlaOperationalDashboard: ({ onOpenConversation }: { onOpenConversation: (id: string) => void }) => <section aria-label="SLA operacional"><button type="button" onClick={() => onOpenConversation("10000000-0000-4000-8000-000000000010")}>Abrir alerta SLA</button></section>,
}));

import { App } from "./App.js";

const dashboard = {
  contacts: 12,
  optOutContacts: 0,
  tags: 0,
  templates: 0,
  leads: 4,
  leadsByStage: [],
  recentActivities: [],
  campaignsByStatus: [],
  sessionsByStatus: [{ status: "connected", total: 2 }],
};

describe("App shell", () => {
  beforeEach(() => {
    history.replaceState({}, "", "/dashboard");
    shellMocks.dashboard.mockReset().mockResolvedValue(dashboard);
  });

  it("renders the existing home through its loading state with one dashboard request", async () => {
    render(<App />);

    expect(screen.getByText("Carregando seu painel…")).toBeInTheDocument();
    expect(
      await screen.findByText("Tudo que você precisa para crescer"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Painel" })).toBeInTheDocument();
    expect(shellMocks.dashboard).toHaveBeenCalledTimes(1);
  });

  it("keeps a dashboard loading failure isolated in the home", async () => {
    shellMocks.dashboard.mockRejectedValueOnce(new Error("offline"));

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Ocorreu um erro inesperado.",
    );
    expect(screen.getByRole("heading", { name: "Painel" })).toBeInTheDocument();
  });

  it("opens Inbox from the home callback and returns through the primary navigation", async () => {
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Abrir Inbox/ }),
    );
    expect(await screen.findByLabelText("Inbox atual")).toBeInTheDocument();
    expect(location.pathname).toBe("/inbox");

    fireEvent.click(screen.getByRole("button", { name: /Painel$/ }));
    await waitFor(() =>
      expect(
        screen.getByText("Tudo que você precisa para crescer"),
      ).toBeInTheDocument(),
    );
    expect(location.pathname).toBe("/dashboard");
    expect(shellMocks.dashboard).toHaveBeenCalledTimes(2);
  });

  it("selects Inbox directly from the primary navigation", async () => {
    render(<App />);
    await screen.findByText("Tudo que você precisa para crescer");

    fireEvent.click(screen.getByRole("button", { name: /Inbox$/ }));

    expect(await screen.findByLabelText("Inbox atual")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(shellMocks.dashboard).toHaveBeenCalledTimes(1);
  });

  it("opens the Inbox with a shareable conversationId from the SLA callback", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Abrir alerta SLA" }));
    expect(await screen.findByLabelText("Inbox atual")).toBeInTheDocument();
    expect(location.href).toContain("/inbox?conversationId=10000000-0000-4000-8000-000000000010");
  });
});
