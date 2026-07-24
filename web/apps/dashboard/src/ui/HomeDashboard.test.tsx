import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const sla = vi.hoisted(() => ({ onOpenConversation: undefined as undefined | ((id: string) => void) }));

vi.mock("./SlaOperationalDashboard.js", () => ({
  SlaOperationalDashboard: ({ onOpenConversation }: { onOpenConversation: (id: string) => void }) => {
    sla.onOpenConversation = onOpenConversation;
    return <section aria-label="SLA operacional integrado" />;
  },
}));

import { HomeDashboard } from "./HomeDashboard.js";

describe("HomeDashboard", () => {
  it("renders Inbox aggregates instead of CRM leads and activities", async () => {
    const loadDashboard = vi.fn().mockResolvedValue({ contacts: 3, optOutContacts: 0, tags: 0, templates: 0, leads: 1, conversations: 21, messages: 89, leadsByStage: [], recentActivities: [], campaignsByStatus: [], sessionsByStatus: [] });
    render(<HomeDashboard loadDashboard={loadDashboard} onOpenInbox={vi.fn()} onOpenConversation={vi.fn()} />);
    expect(await screen.findByText("Conversas")).toBeInTheDocument();
    expect(screen.getByText("21")).toBeInTheDocument();
    expect(screen.getByText("89")).toBeInTheDocument();
  });

  it("composes the SLA area without changing the existing dashboard load", async () => {
    const loadDashboard = vi.fn().mockResolvedValue({
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
    });
    const onOpenConversation = vi.fn();

    render(
      <HomeDashboard
        loadDashboard={loadDashboard}
        onOpenInbox={vi.fn()}
        onOpenConversation={onOpenConversation}
      />,
    );

    expect(await screen.findByLabelText("SLA operacional integrado")).toBeInTheDocument();
    expect(loadDashboard).toHaveBeenCalledTimes(1);
    expect(sla.onOpenConversation).toBe(onOpenConversation);
  });
});
