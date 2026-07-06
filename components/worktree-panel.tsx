'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { GitBranch, Plus, Trash2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/confirm-dialog';
import type { Agent } from '@/lib/types';

interface WorktreeEntry {
  agentId: string;
  path: string;
  branch?: string;
  exists: boolean;
}

interface WorktreePanelProps {
  workspace: string;
  agents: Agent[];
}

export default function WorktreePanel({ workspace, agents }: WorktreePanelProps) {
  const [loading, setLoading] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);

  const load = useCallback(async () => {
    if (!workspace?.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/workspace/worktrees?workspace=${encodeURIComponent(workspace)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setIsGitRepo(!!data.isGitRepo);
      setWorktrees(data.worktrees || []);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to load worktrees');
    }
    setLoading(false);
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createForAgent(agentId: string) {
    try {
      const res = await fetch('/api/workspace/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', workspace, agentId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setWorktrees(data.worktrees || []);
      toast.success('Worktree created');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Create failed');
    }
  }

  async function removeWorktree(agentId: string) {
    const ok = await confirmDialog({
      title: `Remove worktree for agent ${agentId}?`,
      message: 'The isolated working copy is deleted. Committed work in the main repository is kept.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/workspace/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', workspace, agentId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setWorktrees(data.worktrees || []);
      toast.success('Worktree removed');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Remove failed');
    }
  }

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name || id.slice(0, 8);

  return (
    <div className="grok-card p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="font-semibold flex items-center gap-2">
          <GitBranch size={16} /> Git Worktrees
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="grok-btn grok-btn-ghost text-xs p-1">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {!isGitRepo ? (
        <div className="text-xs text-dim">Workspace is not a git repository.</div>
      ) : worktrees.length === 0 ? (
        <div className="text-xs text-dim">No agent worktrees yet. Enable worktree on an agent and run it, or create below.</div>
      ) : (
        <div className="space-y-2">
          {worktrees.map((wt) => (
            <div key={wt.agentId} className="worktree-row flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="font-medium truncate">{agentName(wt.agentId)}</div>
                <div className="text-dim font-mono truncate">{wt.exists ? wt.path : 'not created'}</div>
                {wt.branch && <div className="text-dim">branch: {wt.branch}</div>}
              </div>
              <div className="flex gap-1 shrink-0">
                {!wt.exists && (
                  <button type="button" onClick={() => void createForAgent(wt.agentId)} className="grok-btn grok-btn-secondary text-xs p-1" title="Create worktree">
                    <Plus size={12} />
                  </button>
                )}
                {wt.exists && (
                  <button type="button" onClick={() => void removeWorktree(wt.agentId)} className="grok-btn grok-btn-ghost text-xs text-error p-1" title="Remove worktree">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {isGitRepo && agents.filter((a) => a.workspace.useWorktree).length > 0 && (
        <div className="mt-3 pt-3 border-t border-default">
          <div className="text-[10px] text-dim mb-2">Agents with worktree enabled</div>
          <div className="flex flex-wrap gap-1">
            {agents.filter((a) => a.workspace.useWorktree).map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => void createForAgent(a.id)}
                className="badge badge-accent cursor-pointer"
              >
                <Plus size={10} className="inline mr-0.5" /> {a.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}