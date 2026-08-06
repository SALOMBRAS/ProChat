import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Devices } from "./App.js";
import type { SessionsApi } from "../api/sessions";
import type { DomainApi } from "../api/domain";
import type { WorkspaceApi } from "../api/workspace";

const session = { id: "s-1", workspaceId: "workspace-a", name: "Atendimento", status: "connected", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", wahaName: "chatpro-abc123", managed: true };

const harness = (settingsOperational: Record<string, string> = {}) => {
  const api = { list: vi.fn().mockResolvedValue([session]) } as unknown as SessionsApi;
  const domainApi = {
    settings: vi.fn().mockResolvedValue({ workspaceId: "workspace-a", settings: { operational: settingsOperational } }),
    saveSettings: vi.fn().mockResolvedValue({}),
  } as unknown as DomainApi;
  const workspace = { teams: vi.fn().mockResolvedValue([
    { id: "team-a", workspaceId: "workspace-a", name: "Vendas", description: null, color: null, isActive: true, createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z" },
    { id: "team-b", workspaceId: "workspace-a", name: "Suporte", description: null, color: null, isActive: true, createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z" },
  ]) } as unknown as WorkspaceApi;
  return { api, domainApi, workspace };
};

describe("Devices — vínculo instância→departamento", () => {
  it("mostra o departamento vinculado e salva a troca com a chave instanceTeam", async () => {
    const { api, domainApi, workspace } = harness({ "instanceTeam:chatpro-abc123": "team-a" });
    render(<Devices api={api} domainApi={domainApi} workspace={workspace} />);

    // O select mora no menu de ações da instância (⋯), como no Trynux.
    fireEvent.click(await screen.findByLabelText("Ações da sessão Atendimento"));
    const select = await screen.findByLabelText("Departamento da sessão Atendimento");
    expect(select).toHaveValue("team-a");

    fireEvent.change(select, { target: { value: "team-b" } });
    await waitFor(() => expect(domainApi.saveSettings).toHaveBeenCalledWith({ operational: { "instanceTeam:chatpro-abc123": "team-b" } }));
  });

  it("limpar o vínculo remove a chave dos settings", async () => {
    const { api, domainApi, workspace } = harness({ "instanceTeam:chatpro-abc123": "team-a" });
    render(<Devices api={api} domainApi={domainApi} workspace={workspace} />);

    fireEvent.click(await screen.findByLabelText("Ações da sessão Atendimento"));
    fireEvent.change(await screen.findByLabelText("Departamento da sessão Atendimento"), { target: { value: "" } });
    await waitFor(() => expect(domainApi.saveSettings).toHaveBeenCalledWith({ operational: {} }));
  });
});
