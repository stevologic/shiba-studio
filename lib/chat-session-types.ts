import type { ReasoningEffort } from './chat-types';
import type { ProjectChatMessage } from './projects';

/** Immutable ancestry cursor shared by every non-destructive session fork. */
export interface ChatSessionBranch {
  kind: 'checkpoint-branch-v1';
  parentSessionId: string;
  rootSessionId: string;
  sourceMessageId: string;
  sourceMessageOrdinal: number;
  depth: number;
  createdAt: string;
}

export interface ChatSessionGroup {
  projectId: string | null;
  sessions: ChatSession[];
  unreadCount: number;
}

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
  /** Folder this chat is bound to (e.g. a cloned repo) — fs tools and /git
   *  commands operate here. null/absent = no workspace. */
  workspaceDir?: string | null;
  messages: ProjectChatMessage[];
  /** Incognito lifecycle: no Shiba memories are read or written. */
  ephemeral?: boolean;
  /** Immutable fork ancestry; absent on root sessions. */
  branch?: ChatSessionBranch;
  /** Completed assistant messages not yet marked read by a client. */
  unreadCount?: number;
  lastReadMessageId?: string;
  lastReadAt?: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  archivedAt?: string;
  /**
   * True while a chat turn is running for this session (server-persisted so
   * lists can show “working…” even after a full page reload mid-turn).
   */
  running?: boolean;
}

export function deriveSessionTitle(messages: ProjectChatMessage[], fallback = 'New chat'): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content?.trim());
  if (!firstUser?.content) return fallback;
  const t = String(firstUser.content).trim();
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}

export function groupChatSessionsByProject(sessions: ChatSession[]): ChatSessionGroup[] {
  const groups = new Map<string, ChatSessionGroup>();
  for (const session of sessions) {
    const key = session.projectId || '';
    const group = groups.get(key) || {
      projectId: session.projectId || null,
      sessions: [],
      unreadCount: 0,
    };
    group.sessions.push(session);
    group.unreadCount += Math.max(0, Number(session.unreadCount) || 0);
    groups.set(key, group);
  }
  return [...groups.values()];
}
