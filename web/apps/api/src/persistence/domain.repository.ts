/**
 * Asynchronous domain persistence boundary.  It deliberately exposes domain
 * operations (including compound writes) instead of a generic SQL-shaped API.
 */
export interface DomainRepository {
  contacts(workspaceId: string, query: Record<string, unknown>): Promise<unknown>;
  contact(workspaceId: string, id: string): Promise<unknown>;
  createContact(workspaceId: string, body: unknown): Promise<unknown>;
  updateContact(workspaceId: string, id: string, body: unknown): Promise<unknown>;
  deleteContact(workspaceId: string, id: string): Promise<void>;
  importContacts(workspaceId: string, body: unknown): Promise<unknown>;
  exportContacts(workspaceId: string): Promise<string>;
  tags(workspaceId: string): Promise<unknown>; createTag(workspaceId: string, body: unknown): Promise<unknown>; updateTag(workspaceId: string, id: string, body: unknown): Promise<unknown>; deleteTag(workspaceId: string, id: string): Promise<unknown>;
  templates(workspaceId: string): Promise<unknown>; template(workspaceId: string, id: string): Promise<unknown>; saveTemplate(workspaceId: string, id: string | undefined, body: unknown): Promise<unknown>; templateActive(workspaceId: string, id: string, active: boolean): Promise<unknown>; deleteTemplate(workspaceId: string, id: string): Promise<void>; preview(workspaceId: string, id: string, body: unknown): Promise<unknown>;
  pipelines(workspaceId: string): Promise<unknown>; savePipeline(workspaceId: string, id: string | undefined, body: unknown): Promise<unknown>; deletePipeline(workspaceId: string, id: string): Promise<void>; initPipeline(workspaceId: string, body: unknown): Promise<unknown>;
  stages(workspaceId: string, pipelineId: string): Promise<unknown>; saveStage(workspaceId: string, id: string | undefined, body: unknown): Promise<unknown>; reorderStages(workspaceId: string, pipelineId: string, body: unknown): Promise<unknown>; deleteStage(workspaceId: string, id: string): Promise<void>;
  leads(workspaceId: string, query: Record<string, unknown>): Promise<unknown>; saveLead(workspaceId: string, id: string | undefined, body: unknown): Promise<unknown>; deleteLead(workspaceId: string, id: string): Promise<void>; moveLead(workspaceId: string, id: string, body: unknown): Promise<unknown>; leadTag(workspaceId: string, id: string, tagId: string, add: boolean): Promise<unknown>; note(workspaceId: string, id: string, body: unknown): Promise<unknown>; notes(workspaceId: string, id: string): Promise<unknown>; activities(workspaceId: string, id: string): Promise<unknown>; funnel(workspaceId: string): Promise<unknown>;
  optOut(workspaceId: string, contactId: string, body: unknown): Promise<unknown>; optOutStatus(workspaceId: string, contactId: string): Promise<unknown>; removeOptOut(workspaceId: string, contactId: string): Promise<unknown>; optOutContacts(workspaceId: string, query: Record<string, unknown>): Promise<unknown>;
  campaigns(workspaceId: string, query: Record<string, unknown>): Promise<unknown>; campaign(workspaceId: string, id: string): Promise<unknown>; saveCampaign(workspaceId: string, id: string | undefined, body: unknown): Promise<unknown>; deleteCampaign(workspaceId: string, id: string): Promise<void>; validateCampaign(workspaceId: string, id: string): Promise<unknown>; prepareCampaign(workspaceId: string, id: string): Promise<unknown>; scheduleCampaign(workspaceId: string, id: string, body: unknown): Promise<unknown>; cancelCampaign(workspaceId: string, id: string): Promise<unknown>;
  settings(workspaceId: string): Promise<unknown>; saveSettings(workspaceId: string, body: unknown): Promise<unknown>; dashboard(workspaceId: string, sessions: unknown[]): Promise<unknown>;
}
