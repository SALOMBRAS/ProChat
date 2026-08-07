import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DomainApi } from "../api/domain";
import type { SessionsApi } from "../api/sessions";
import type { WorkspaceApi } from "../api/workspace";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => undefined }));

import { Departments } from "./Departments.js";

const team = { id: "team-a", workspaceId: "workspace-a", name: "Vendas", description: null, color: "#f97316", isActive: true, memberCount: 1, createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z" };
const users = [
  { id: "u-1", workspaceId: "workspace-a", email: "ana@chatpro.dev", displayName: "Ana Silva", avatarUrl: null, role: "agent", status: "active", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", lastSeenAt: null },
  { id: "u-2", workspaceId: "workspace-a", email: "bruno@chatpro.dev", displayName: "Bruno Lima", avatarUrl: null, role: "agent", status: "active", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", lastSeenAt: null },
];
const session = { id: "s-1", workspaceId: "workspace-a", name: "Comercial", status: "connected", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", wahaName: "chatpro-abc123", managed: true };

const harness = (operational: Record<string, string> = {}) => {
  const workspace = {
    teams: vi.fn().mockResolvedValue([team]),
    users: vi.fn().mockResolvedValue(users),
    members: vi.fn().mockResolvedValue([{ teamId: "team-a", userId: "u-1", membershipRole: "member", createdAt: "2026-08-06T00:00:00Z" }]),
    updateTeam: vi.fn().mockResolvedValue(team),
    createTeam: vi.fn().mockResolvedValue(team),
    addMember: vi.fn().mockResolvedValue({}),
    removeMember: vi.fn().mockResolvedValue(true),
  } as unknown as WorkspaceApi;
  const sessionsApi = { list: vi.fn().mockResolvedValue([session]) } as unknown as SessionsApi;
  const domainApi = {
    settings: vi.fn().mockResolvedValue({ workspaceId: "workspace-a", settings: { operational } }),
    saveSettings: vi.fn().mockResolvedValue({}),
  } as unknown as DomainApi;
  return { workspace, sessionsApi, domainApi };
};

describe("Departamentos", () => {
  it("mostra os cartões com cor, ícone, instâncias e membros do departamento", async () => {
    const { workspace, sessionsApi, domainApi } = harness({ "instanceTeam:chatpro-abc123": "team-a", "teamIcon:team-a": "🎧" });
    render(<Departments workspace={workspace} sessionsApi={sessionsApi} domainApi={domainApi} />);

    expect(await screen.findByText("Vendas")).toBeInTheDocument();
    expect(screen.getByText("🎧")).toBeInTheDocument();
    expect(screen.getByText("▦ 1 instância")).toBeInTheDocument();
    expect(screen.getByText("👥 1 membro")).toBeInTheDocument();
    expect(screen.getByText("1", { selector: ".departments-banner strong" })).toBeInTheDocument();
    expect(screen.getByText("AN", { selector: ".department-avatars span" })).toBeInTheDocument();
  });

  it("salva nome, cor, ícone, vínculo de instância e colaboradores pelo modal", async () => {
    const { workspace, sessionsApi, domainApi } = harness({ "teamIcon:team-a": "🎧" });
    render(<Departments workspace={workspace} sessionsApi={sessionsApi} domainApi={domainApi} />);

    fireEvent.click(await screen.findByLabelText("Editar departamento Vendas"));
    fireEvent.change(screen.getByLabelText("Nome do departamento"), { target: { value: "Vendas Brasil" } });
    fireEvent.click(screen.getByLabelText("Ícone 🚀"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Comercial/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Bruno Lima/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(workspace.updateTeam).toHaveBeenCalledWith("team-a", { name: "Vendas Brasil", color: "#f97316" }));
    expect(domainApi.saveSettings).toHaveBeenCalledWith({ operational: { "teamIcon:team-a": "🚀", "instanceTeam:chatpro-abc123": "team-a" } });
    expect(workspace.addMember).toHaveBeenCalledWith("team-a", { userId: "u-2" });
    expect(workspace.removeMember).not.toHaveBeenCalled();
  });

  it("desvincular a instância remove só a chave dela, sem tocar em outros departamentos", async () => {
    const { workspace, sessionsApi, domainApi } = harness({ "instanceTeam:chatpro-abc123": "team-a", "instanceTeam:chatpro-outra": "team-b", "teamIcon:team-a": "🎧" });
    render(<Departments workspace={workspace} sessionsApi={sessionsApi} domainApi={domainApi} />);

    fireEvent.click(await screen.findByLabelText("Editar departamento Vendas"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Comercial/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(domainApi.saveSettings).toHaveBeenCalledWith({ operational: { "instanceTeam:chatpro-outra": "team-b", "teamIcon:team-a": "🎧" } }));
  });
});
