import type { ReasoningEffort } from './chat-types';
import type { ProjectChatMessage } from './projects';

export interface ChatSession {
  id: string;
  title: string;
  chatTarget: string;
  chatModel: string;
  projectId: string | null;
  useGrokCli: boolean;
  /** Model used when routing through the local Grok CLI (limited to the CLI's own model list). */
  cliModel?: string;
  reasoningEffort: ReasoningEffort;
  messages: ProjectChatMessage[];
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  archivedAt?: string;
}

export function deriveSessionTitle(messages: ProjectChatMessage[], fallback = 'New chat'): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content?.trim());
  if (!firstUser?.content) return fallback;
  const t = firstUser.content.trim();
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}