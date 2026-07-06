'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { GitCompare, RotateCcw, FileDiff } from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/confirm-dialog';

interface DiffFile {
  path: string;
  status: string;
}

interface WorkspaceDiffPanelProps {
  workspaceDir?: string;
  runId?: string;
}

export default function WorkspaceDiffPanel({ workspaceDir, runId }: WorkspaceDiffPanelProps) {
  const [loading, setLoading] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [diff, setDiff] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const loadDiff = useCallback(async () => {
    if (!workspaceDir) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/workspace/diff?dir=${encodeURIComponent(workspaceDir)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setIsGitRepo(!!data.isGitRepo);
      setFiles(data.files || []);
      setDiff(data.diff || '');
      setSelectedFile((data.files || [])[0]?.path || null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load diff';
      toast.error(msg);
    }
    setLoading(false);
  }, [workspaceDir]);

  useEffect(() => {
    if (!workspaceDir) {
      setFiles([]);
      setDiff('');
      setIsGitRepo(false);
      return;
    }
    void loadDiff();
  }, [workspaceDir, runId, loadDiff]);

  async function discardSelected() {
    if (!workspaceDir || !selectedFile) return;
    const ok = await confirmDialog({
      title: `Discard changes to ${selectedFile}?`,
      message: 'Uncommitted edits to this file are reverted permanently.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    setDiscarding(true);
    try {
      const res = await fetch('/api/workspace/diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'discard', dir: workspaceDir, paths: [selectedFile] }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setIsGitRepo(!!data.isGitRepo);
      setFiles(data.files || []);
      setDiff(data.diff || '');
      setSelectedFile((data.files || [])[0]?.path || null);
      toast.success('Changes discarded');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Discard failed');
    }
    setDiscarding(false);
  }

  if (!workspaceDir) return null;

  const fileDiff = selectedFile && diff
    ? diff.split(/^diff --git/m).filter(Boolean).find((chunk) => chunk.includes(selectedFile))
      ? `diff --git${diff.split(/^diff --git/m).filter(Boolean).find((chunk) => chunk.includes(selectedFile))}`
      : diff
    : diff;

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <GitCompare size={16} />
        <div className="font-medium">Pending Changes</div>
        {loading && <span className="badge">loading…</span>}
        {!loading && files.length > 0 && <span className="badge badge-accent">{files.length} file(s)</span>}
      </div>

      {!isGitRepo ? (
        <div className="grok-card p-4 text-xs text-dim">
          Workspace is not a git repository — diff review requires git.
        </div>
      ) : files.length === 0 && !loading ? (
        <div className="grok-card p-4 text-xs text-dim">
          No pending changes in workspace after this run.
        </div>
      ) : (
        <div className="workspace-diff-grid grok-card overflow-hidden">
          <div className="workspace-diff-files border-r border-default">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelectedFile(f.path)}
                className={`workspace-diff-file ${selectedFile === f.path ? 'active' : ''}`}
              >
                <span className="workspace-diff-status">{f.status}</span>
                <span className="truncate font-mono text-xs">{f.path}</span>
              </button>
            ))}
          </div>
          <div className="workspace-diff-viewer">
            <div className="workspace-diff-toolbar">
              <FileDiff size={14} className="text-dim" />
              <span className="font-mono text-xs truncate flex-1">{selectedFile || '—'}</span>
              {selectedFile && (
                <button
                  type="button"
                  onClick={() => void discardSelected()}
                  disabled={discarding}
                  className="grok-btn grok-btn-ghost text-xs"
                >
                  <RotateCcw size={12} /> Discard
                </button>
              )}
            </div>
            <pre className="workspace-diff-pre">{fileDiff || '(no diff text)'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}