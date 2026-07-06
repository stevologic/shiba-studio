import { loadConfig } from './persistence';
import {
  buildProjectAgentPrompt,
  buildProjectChatContext,
  getProject,
  resolveProjectWorkspace,
} from './projects';

export interface ResolvedProjectRun {
  projectId: string;
  effectivePrompt: string;
  projectContext: string;
  workspacePathOverride: string;
}

/** Shared resolution for /api/execute/stream and tests — always reads fresh project from persistence. */
export async function resolveProjectRunScope(
  projectId: string,
  prompt: string,
): Promise<ResolvedProjectRun | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const cfg = await loadConfig();
  return {
    projectId,
    effectivePrompt: buildProjectAgentPrompt(project, prompt),
    projectContext: await buildProjectChatContext(project, cfg.defaultWorkspace),
    workspacePathOverride: resolveProjectWorkspace(project, cfg.defaultWorkspace),
  };
}