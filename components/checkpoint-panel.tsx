'use client';

import { useCallback, useEffect, useState } from 'react';
import { History, Loader2, RotateCcw } from 'lucide-react';
import { confirmDialog } from '@/components/confirm-dialog';
import type { TaskCheckpoint } from '@/lib/task-types';

export function CheckpointPanel({ taskId, onRestored }: { taskId: string; onRestored?: () => void }) {
  const [checkpoints, setCheckpoints] = useState<TaskCheckpoint[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/checkpoints`, { cache: 'no-store', signal });
    const data = await response.json() as { ok?: boolean; checkpoints?: TaskCheckpoint[]; error?: string };
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load checkpoints');
    setCheckpoints(data.checkpoints || []);
  }, [taskId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void load(controller.signal).catch(() => {}); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function restore(checkpoint: TaskCheckpoint) {
    const confirmed = await confirmDialog({
      title: 'Rewind this task?',
      message: `Restore ${checkpoint.files.length} task-owned file${checkpoint.files.length === 1 ? '' : 's'}, the task plan, and its linked conversation cursor to the state before “${checkpoint.reason}”. Unrelated files are never touched; conflicts abort the entire rewind.`,
      confirmLabel: 'Rewind exact checkpoint',
      danger: true,
    });
    if (!confirmed) return;
    setPending(checkpoint.id);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/checkpoints/${encodeURIComponent(checkpoint.id)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmCheckpointId: checkpoint.id }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Checkpoint rewind failed');
      await load();
      onRestored?.();
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'Checkpoint rewind failed');
    } finally {
      setPending(null);
    }
  }

  if (!checkpoints.length && !error) return null;
  return (
    <section className="grok-card p-5 space-y-3" aria-labelledby="checkpoint-heading">
      <div>
        <h2 id="checkpoint-heading" className="text-base font-semibold flex items-center gap-2"><History size={16} /> Checkpoints</h2>
        <p className="text-xs text-dim mt-1">Immutable task-owned pre/post snapshots. Rewind is conflict-checked and synchronized with task and chat state.</p>
      </div>
      {error && <div className="text-xs text-error" role="alert">{error}</div>}
      <ul className="space-y-2">
        {checkpoints.map((checkpoint) => (
          <li key={checkpoint.id} className="border border-default rounded-md p-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{checkpoint.reason}</span>
            <span className="status-pill text-dim">{checkpoint.state}</span>
            <span className="text-dim">{checkpoint.files.length} file{checkpoint.files.length === 1 ? '' : 's'} · {new Date(checkpoint.createdAt).toLocaleString()}</span>
            {checkpoint.state === 'ready' && (
              <button type="button" className="grok-btn grok-btn-ghost text-warning ml-auto" disabled={!!pending} onClick={() => void restore(checkpoint)}>
                {pending === checkpoint.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Rewind
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default CheckpointPanel;
