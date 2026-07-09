import type { ChatAttachment } from './chat-types';

export interface ProjectFileMeta {
  id: string;
  name: string;
  storedName: string;
  size: number;
  uploadedAt: string;
  checksum: string;
  mimeType?: string;
}

export interface ProjectChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  attachments?: ChatAttachment[];
  model?: string;
  agentId?: string;
  agentName?: string;
  perspectives?: Array<{ agentId: string; name: string; content: string }>;
  /** Token usage reported by the xAI API for this reply. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** True while a background session turn is still generating this message. */
  streaming?: boolean;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  workspacePath?: string;
  defaultAgentId?: string;
  files: ProjectFileMeta[];
  messages: ProjectChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export function normalizeProject(raw: Project): Project {
  return {
    ...raw,
    instructions: raw.instructions ?? '',
    workspacePath: raw.workspacePath ?? '',
    defaultAgentId: raw.defaultAgentId ?? '',
    files: raw.files ?? [],
    messages: raw.messages ?? [],
  };
}

export function resolveProjectWorkspace(project: Project, defaultWorkspace: string): string {
  const p = project.workspacePath?.trim();
  return p || defaultWorkspace;
}

export function buildProjectContextHeader(project: Project, workspaceResolved?: string): string {
  const lines: string[] = [`Project: ${project.name}`];
  if (project.description?.trim()) {
    lines.push(`Description: ${project.description.trim()}`);
  }
  if (project.instructions?.trim()) {
    lines.push(`Project instructions:\n${project.instructions.trim()}`);
  }
  const ws = workspaceResolved || project.workspacePath?.trim();
  if (ws) {
    lines.push(`Project workspace folder: ${ws}`);
  }
  return lines.join('\n');
}

export function buildProjectAgentPrompt(project: Project, taskPrompt: string): string {
  const task = taskPrompt.trim() || 'Explore the project workspace and implement the next steps toward the project goals.';
  if (project.instructions?.trim()) {
    return `Follow these project instructions:\n${project.instructions.trim()}\n\nTask:\n${task}`;
  }
  return task;
}