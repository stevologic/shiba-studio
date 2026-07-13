'use client';

import { Archive, ArchiveRestore, EyeOff, GitBranch, MessageSquare, Pencil, X } from 'lucide-react';
import type { ChatSession } from '@/lib/chat-session-types';

interface ChatSessionRailItemProps {
  session: ChatSession;
  active: boolean;
  isRunning: boolean;
  agentName: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, event: React.MouseEvent<HTMLButtonElement>) => void;
  onArchive: (id: string, event: React.MouseEvent<HTMLButtonElement>) => void;
  onRestore: (id: string, event: React.MouseEvent<HTMLButtonElement>) => void;
  onDelete: (id: string, event: React.MouseEvent<HTMLButtonElement>) => void;
}

export function ChatSessionRailItem({
  session,
  active,
  isRunning,
  agentName,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}: ChatSessionRailItemProps) {
  const label = session.title || 'New chat';
  const unread = active ? 0 : Math.max(0, Number(session.unreadCount) || 0);
  const title = isRunning
    ? `${label} · working…`
    : (agentName ? `${label} · ${agentName}` : label);

  return (
    <div
      className={`chat-session-item ${active ? 'chat-session-item-active' : ''} ${isRunning ? 'chat-session-item-running' : ''}`}
      aria-current={active ? 'true' : undefined}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 bg-transparent text-left"
        onClick={() => onSelect(session.id)}
        title={title}
      >
        {session.ephemeral
          ? <EyeOff size={13} className="shrink-0 text-accent" aria-label="Ephemeral chat" />
          : session.branch
            ? <GitBranch size={13} className="shrink-0 opacity-70" aria-label="Forked chat" />
            : <MessageSquare size={13} className={`shrink-0 ${isRunning ? 'opacity-90 text-accent' : 'opacity-50'}`} />}
        <span className="chat-session-item-body">
          <span className="chat-session-item-title">
            {label}
            {isRunning && <span className="chat-session-item-live"> · working</span>}
          </span>
          <span className="chat-session-item-meta">
            {[agentName, session.branch ? `fork ${session.branch.depth}` : '', session.ephemeral ? 'ephemeral' : '']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        {unread > 0 && (
          <span
            className="min-w-5 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-center text-[10px] font-semibold text-black"
            aria-label={`${unread} unread message${unread === 1 ? '' : 's'}`}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <span className="chat-session-item-actions">
        <button
          type="button"
          className="chat-session-item-action"
          onClick={(event) => onRename(session.id, event)}
          title="Rename chat"
          aria-label={`Rename ${label}`}
        >
          <Pencil size={12} />
        </button>
        {!session.ephemeral && (session.archived ? (
          <button
            type="button"
            className="chat-session-item-action"
            onClick={(event) => onRestore(session.id, event)}
            title="Restore session"
            aria-label={`Restore ${label}`}
          >
            <ArchiveRestore size={12} />
          </button>
        ) : (
          <button
            type="button"
            className="chat-session-item-action"
            onClick={(event) => onArchive(session.id, event)}
            title="Archive session"
            aria-label={`Archive ${label}`}
          >
            <Archive size={12} />
          </button>
        ))}
        <button
          type="button"
          className="chat-session-item-action chat-session-item-action-danger"
          onClick={(event) => onDelete(session.id, event)}
          title="Delete session"
          aria-label={`Delete ${label}`}
        >
          <X size={12} />
        </button>
      </span>
    </div>
  );
}
