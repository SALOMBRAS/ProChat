import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Devices } from "./Devices.js";
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

describe("Devices — departamentos são somente leitura (quem vincula é a tela Departamentos)", () => {
  it("exibe no card os departamentos vinculados via settings, sem oferecer edição", async () => {
    const { api, domainApi, workspace } = harness({ "instanceTeam:chatpro-abc123": "team-a" });
    render(<Devices api={api} domainApi={domainApi} workspace={workspace} />);

    // O card mostra o vínculo feito na tela de Departamentos.
    expect(await screen.findByText("Vendas")).toBeTruthy();

    // O menu de ações NÃO tem seletor de departamento.
    fireEvent.click(await screen.findByLabelText("Ações da sessão Atendimento"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(domainApi.saveSettings).not.toHaveBeenCalled();
  });

  it("sem vínculo, o card indica 'Todos (triagem)' e o menu segue sem checkboxes", async () => {
    const { api, domainApi, workspace } = harness();
    render(<Devices api={api} domainApi={domainApi} workspace={workspace} />);

    expect(await screen.findByText("Todos (triagem)")).toBeTruthy();

    fireEvent.click(await screen.findByLabelText("Ações da sessão Atendimento"));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
