import type { SqlitePipelineRepository, SqliteStageRepository } from './repositories.js';

/** Creates an initial CRM pipeline only when the caller explicitly provisions a workspace. */
export function initializeWorkspaceCrm(workspaceId: string, pipelines: SqlitePipelineRepository, stages: SqliteStageRepository) {
  const pipeline = pipelines.insert(workspaceId, { name: 'Sales' });
  return ['New', 'Qualified', 'Proposal', 'Won', 'Lost'].map((name, position) => stages.insert(workspaceId, { pipelineId: pipeline.id, name, position }));
}
