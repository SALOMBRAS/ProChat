import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlaOperationalSummary } from "../api/inbox.js";
import stylesheet from "./styles.css?raw";

const realtime = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: any) => void),
}));

vi.mock("../api/realtime.js", () => ({
  connectRealtime: (handler: (event: any) => void) => {
    realtime.handler = handler;
    return () => {
      realtime.handler = undefined;
    };
  },
}));

import {
  criticalContactLabel,
  formatSlaDuration,
  formatSlaPercentage,
  SlaOperationalDashboard,
} from "./SlaOperationalDashboard.js";

const summary: SlaOperationalSummary = {
  generatedAt: "2026-07-23T12:00:00.000Z",
  totals: {
    active: 12,
    waitingOperator: 4,
    waitingCustomer: 3,
    withinSla: 8,
    warning: 2,
    overdue: 2,
    frozen: 1,
  },
  averages: {
    firstResponseSeconds: 272,
    operatorWaitSeconds: null,
    customerWaitSeconds: 4320,
  },
  percentages: { withinSla: 67 },
  critical: [
    {
      conversationId: "red-conversation",
      displayName: "Cliente atrasado",
      phoneNumber: "5511999990000",
      assignedUserId: null,
      routingQueueId: null,
      status: "waiting_operator",
      indicator: "red",
      deadlineAt: "2026-07-23T11:50:00.000Z",
      lastActivityAt: "2026-07-23T11:00:00.000Z",
    },
    {
      conversationId: "yellow-conversation",
      displayName: "Cliente em atenção",
      phoneNumber: "5511888888888",
      assignedUserId: null,
      routingQueueId: null,
      status: "waiting_customer",
      indicator: "yellow",
      deadlineAt: "2026-07-23T12:10:00.000Z",
      lastActivityAt: "2026-07-23T11:30:00.000Z",
    },
  ],
};

const criticalItem = (index: number): SlaOperationalSummary["critical"][number] => ({
  ...summary.critical[0],
  conversationId: `conversation-${index}`,
  displayName: `Cliente ${index}`,
});

const scrollRegionName = "Lista rolável de atendimentos que exigem atenção";

const cssRule = (selector: string) => {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `regra ${selector} ausente em styles.css`).toBeGreaterThan(-1);
  return stylesheet.slice(start, stylesheet.indexOf("}", start));
};

const renderDashboard = (api = { slaSummary: vi.fn().mockResolvedValue(summary) }) => {
  const onOpenConversation = vi.fn();
  render(
    <SlaOperationalDashboard
      api={api}
      workspaceId="workspace-a"
      onOpenConversation={onOpenConversation}
    />,
  );
  return { api, onOpenConversation };
};

afterEach(() => {
  vi.useRealTimers();
  realtime.handler = undefined;
});

describe("SlaOperationalDashboard", () => {
  it("formats durations and percentages from the compact contract", () => {
    expect(formatSlaDuration(45)).toBe("45 s");
    expect(formatSlaDuration(272)).toBe("4 min 32 s");
    expect(formatSlaDuration(4320)).toBe("1 h 12 min");
    expect(formatSlaDuration(null)).toBe("—");
    expect(formatSlaPercentage(101)).toBe("100%");
    expect(criticalContactLabel({ ...summary.critical[0], displayName: "100000000000001@lid", phoneNumber: null })).toBe("Contato sem identificação");
  });

  it("renders all operational cards and preserves the server critical order", async () => {
    const { onOpenConversation } = renderDashboard();

    expect(await screen.findByText("Atendimentos ativos")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
    expect(screen.getByText("4 min 32 s")).toBeInTheDocument();
    expect(screen.getByText(/Espera média do atendente: —/)).toBeInTheDocument();
    const critical = screen.getAllByRole("button", { name: /Abrir Cliente/ });
    expect(critical.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Cliente atrasado"),
      expect.stringContaining("Cliente em atenção"),
    ]);

    fireEvent.click(critical[0]);
    expect(onOpenConversation).toHaveBeenCalledWith("red-conversation");
  });

  it("keeps every critical item inside one bounded scroll region", async () => {
    const critical = Array.from({ length: 25 }, (_, index) => criticalItem(index));
    renderDashboard({
      slaSummary: vi.fn().mockResolvedValue({
        ...summary,
        totals: { ...summary.totals, warning: 9, overdue: 40 },
        critical,
      }),
    });

    const region = await screen.findByRole("region", { name: scrollRegionName });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getAllByRole("listitem")).toHaveLength(25);
    expect(within(region).getByRole("list")).toBeInTheDocument();
    expect(region.querySelector(".sla-critical-fade")).not.toBeNull();
    expect(screen.getByText("Cliente 24")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Atendimentos que exigem atenção" }),
    ).not.toContainElement(region);
  });

  it("counts every at-risk conversation in the badge, not the returned sample", async () => {
    renderDashboard({
      slaSummary: vi.fn().mockResolvedValue({
        ...summary,
        totals: { ...summary.totals, warning: 9, overdue: 40 },
        critical: Array.from({ length: 20 }, (_, index) => criticalItem(index)),
      }),
    });

    expect(await screen.findByText("49 em foco")).toBeInTheDocument();
    expect(screen.queryByText("20 em foco")).not.toBeInTheDocument();
    expect(
      screen.getByText("Mostrando os 20 mais urgentes de 49."),
    ).toBeInTheDocument();
  });

  it("renders a positive empty state outside the scroll region", async () => {
    renderDashboard({
      slaSummary: vi.fn().mockResolvedValue({
        ...summary,
        totals: { ...summary.totals, warning: 0, overdue: 0 },
        critical: [],
      }),
    });

    expect(
      await screen.findByText("Nenhum atendimento exige atenção neste momento."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: scrollRegionName })).not.toBeInTheDocument();
    expect(document.querySelector(".sla-critical-scroll")).toBeNull();
    expect(document.querySelector(".sla-critical-fade")).toBeNull();
    expect(screen.getByText("0 em foco")).toBeInTheDocument();
  });

  it("keeps the error state outside the scroll region", async () => {
    renderDashboard({
      slaSummary: vi.fn().mockRejectedValue(new Error("Resumo indisponível")),
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Resumo indisponível");
    expect(screen.queryByRole("region", { name: scrollRegionName })).not.toBeInTheDocument();
    expect(document.querySelector(".sla-critical-scroll")).toBeNull();
  });

  it("bounds the scroll region by row height instead of a fixed pixel box", () => {
    const scroll = cssRule(".sla-critical-scroll");
    expect(scroll).toMatch(/--sla-critical-rows:\s*10/);
    expect(scroll).toMatch(/--sla-critical-row:\s*[\d.]+rem/);
    expect(scroll).toMatch(
      /max-height:\s*min\(calc\(var\(--sla-critical-rows\)\s*\*\s*\(var\(--sla-critical-row\)\s*\+\s*var\(--sla-critical-row-gap\)\)\),\s*\d+vh\)/,
    );
    expect(scroll).not.toMatch(/max-height:\s*\d/);
    expect(scroll).not.toMatch(/min-height/);
    expect(scroll).toMatch(/overflow-y:\s*auto/);
    expect(scroll).toMatch(/overscroll-behavior:\s*contain/);
    expect(cssRule(".sla-critical-scroll:focus-visible")).toMatch(/outline:/);

    const items = cssRule(".sla-critical-items");
    expect(items).toMatch(/list-style:\s*none/);
    expect(items).toMatch(/margin:\s*0/);

    const fade = cssRule(".sla-critical-fade");
    expect(fade).toMatch(/position:\s*sticky/);
    expect(fade).toMatch(/linear-gradient/);

    expect(stylesheet).toMatch(
      /@media \(max-width: 760px\)[^}]*\.sla-critical-scroll \{[^}]*--sla-critical-row:\s*[\d.]+rem/,
    );
  });

  it("never falls back to a technical conversation identifier", async () => {
    renderDashboard({
      slaSummary: vi.fn().mockResolvedValue({
        ...summary,
        critical: [{ ...summary.critical[0], conversationId: "731f83f8-0000-4000-8000-000000000000", displayName: null, phoneNumber: null }],
      }),
    });

    expect(await screen.findByText("Contato sem identificação")).toBeInTheDocument();
    expect(screen.queryByText(/731f83f8/)).not.toBeInTheDocument();
  });

  it("keeps failures isolated and retries on demand", async () => {
    const api = {
      slaSummary: vi
        .fn()
        .mockRejectedValueOnce(new Error("Resumo indisponível"))
        .mockResolvedValueOnce(summary),
    };
    renderDashboard(api);

    expect(await screen.findByRole("alert")).toHaveTextContent("Resumo indisponível");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Atendimentos ativos")).toBeInTheDocument();
    expect(api.slaSummary).toHaveBeenCalledTimes(2);
  });

  it("groups nearby realtime events into one refresh", async () => {
    vi.useFakeTimers();
    const { api } = renderDashboard();
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.slaSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      realtime.handler?.({ eventType: "conversation.sla.updated", workspaceId: "workspace-a", payload: {} });
      realtime.handler?.({ eventType: "conversation.updated", workspaceId: "workspace-a", payload: {} });
      realtime.handler?.({ eventType: "conversation.kanban.moved", workspaceId: "workspace-a", payload: {} });
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(api.slaSummary).toHaveBeenCalledTimes(2);
  });

  it("does not poll while the document is hidden and clears its timer on unmount", async () => {
    vi.useFakeTimers();
    const api = { slaSummary: vi.fn().mockResolvedValue(summary) };
    const view = render(
      <SlaOperationalDashboard api={api} onOpenConversation={vi.fn()} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => vi.advanceTimersByTime(60_000));
    expect(api.slaSummary).toHaveBeenCalledTimes(1);
    view.unmount();
    act(() => vi.advanceTimersByTime(120_000));
    expect(api.slaSummary).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("refreshes after returning to a stale visible tab", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    const { api } = renderDashboard();
    await act(async () => {
      await Promise.resolve();
    });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });
    expect(api.slaSummary).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(api.slaSummary).toHaveBeenCalledTimes(2);
  });
});
