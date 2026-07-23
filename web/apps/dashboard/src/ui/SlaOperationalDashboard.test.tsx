import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlaOperationalSummary } from "../api/inbox.js";

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
      contactName: "Cliente atrasado",
      assignedUserId: null,
      routingQueueId: null,
      status: "waiting_operator",
      indicator: "red",
      deadlineAt: "2026-07-23T11:50:00.000Z",
      lastActivityAt: "2026-07-23T11:00:00.000Z",
    },
    {
      conversationId: "yellow-conversation",
      contactName: "Cliente em atenção",
      assignedUserId: null,
      routingQueueId: null,
      status: "waiting_customer",
      indicator: "yellow",
      deadlineAt: "2026-07-23T12:10:00.000Z",
      lastActivityAt: "2026-07-23T11:30:00.000Z",
    },
  ],
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

  it("renders a positive empty state", async () => {
    renderDashboard({
      slaSummary: vi.fn().mockResolvedValue({ ...summary, critical: [] }),
    });

    expect(
      await screen.findByText("Nenhum atendimento exige atenção neste momento."),
    ).toBeInTheDocument();
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
