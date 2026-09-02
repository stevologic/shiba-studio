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
  /** Per-chat automatic model tool calls. Missing on older sessions means enabled. */
  toolsEnabled?: boolean;
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

/** System log threads (Grok Bot / phone) — not user 1:1 or group rooms. */
export const RESERVED_CHAT_SESSION_IDS = ['grok-bot', 'phone-assistant'] as const;

export function isReservedChatSessionId(id: string | null | undefined): boolean {
  return id === 'grok-bot' || id === 'phone-assistant';
}

export function isCanonicalChatThread(
  session: Pick<ChatSession, 'ephemeral' | 'branch'> & { id?: string },
): boolean {
  return !session.ephemeral && !session.branch && !isReservedChatSessionId(session.id);
}

export function isGenericChatTitle(title: string | null | undefined): boolean {
  const value = String(title || '').trim();
  return !value || value === 'New chat';
}

export function normalizeChatTarget(target: string | null | undefined): string {
  const value = String(target || '').trim();
  return value || 'grok';
}

export function canonicalTitleForTarget(target: string, agentName?: string): string {
  const value = normalizeChatTarget(target);
  if (value === 'all') return 'All agents';
  if (value === 'grok') return 'Grok';
  return agentName?.trim() || 'Agent';
}

export interface ChatRailGroup {
  id: string;
  label: string;
  sessions: ChatSession[];
  unreadCount: number;
}

function unreadCountFor(sessions: ChatSession[]): number {
  return sessions.reduce((sum, session) => sum + Math.max(0, Number(session.unreadCount) || 0), 0);
}

function railSection(id: string, label: string, sessions: ChatSession[]): ChatRailGroup {
  return { id, label, sessions, unreadCount: unreadCountFor(sessions) };
}

/**
 * Rail grouping: one durable Grok thread, one durable thread per agent,
 * one All-agents group room, then ephemeral chats, forks, archived, and leftovers.
 */
export function groupChatSessionsForRail(sessions: ChatSession[]): ChatRailGroup[] {
  const grok: ChatSession[] = [];
  const agents: ChatSession[] = [];
  const group: ChatSession[] = [];
  const ephemeral: ChatSession[] = [];
  const forks: ChatSession[] = [];
  const archived: ChatSession[] = [];
  const other: ChatSession[] = [];
  const claimed = new Set<string>();
  const placed = new Set<string>();
  const durables = sessions
    .filter((session) => isCanonicalChatThread(session) && !session.archived)
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const session of durables) {
    const target = normalizeChatTarget(session.chatTarget);
    if (claimed.has(target)) {
      other.push(session);
      placed.add(session.id);
      continue;
    }
    claimed.add(target);
    placed.add(session.id);
    if (target === 'grok') grok.push(session);
    else if (target === 'all') group.push(session);
    else agents.push(session);
  }
  for (const session of sessions) {
    if (placed.has(session.id)) continue;
    if (session.ephemeral) ephemeral.push(session);
    else if (session.branch) forks.push(session);
    else if (session.archived) archived.push(session);
    else other.push(session);
  }
  const sections: ChatRailGroup[] = [];
  if (grok.length) sections.push(railSection('grok', 'Grok', grok));
  if (agents.length) sections.push(railSection('agents', 'Agents', agents));
  if (group.length) sections.push(railSection('group', 'Group', group));
  if (ephemeral.length) sections.push(railSection('ephemeral', 'Ephemeral', ephemeral));
  if (forks.length) sections.push(railSection('forks', 'Forks', forks));
  if (archived.length) sections.push(railSection('archived', 'Archived', archived));
  if (other.length) sections.push(railSection('other', 'Other chats', other));
  return sections;
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
