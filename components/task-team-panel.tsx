'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Loader2, Pause, Play, Plus, RefreshCw, Send, Square, Trash2, Users } from 'lucide-react';
import { confirmDialog } from '@/components/confirm-dialog';
import type { TeamGraphNode, TeamWorkerSpec } from '@/lib/task-teams';
import type { TaskRecord } from '@/lib/task-types';

interface AgentOption { id: string; name: string }

function emptyWorker(index: number, task: TaskRecord, agentId = ''): TeamWorkerSpec {
  return {
    key: `worker-${index}`,
    title: '',
    instructions: '',
    agentId,
    workspaceRootIds: task.workspaceRoots.length ? [task.workspaceRoots[0].id] : [],
    readOnly: true,
    required: true,
    maxTurns: 12,
    timeoutSeconds: 900,
  };
}

export function TaskTeamPanel({ task }: { task: TaskRecord }) {
  const [graph, setGraph] = useState<TeamGraphNode[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [workers, setWorkers] = useState<TeamWorkerSpec[]>([]);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [workerPending, setWorkerPending] = useState<string | null>(null);
  const [workerInstructions, setWorkerInstructions] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const [teamResponse, agentsResponse] = await Promise.all([
      fetch(`/api/tasks/${encodeURIComponent(task.id)}/team`, { cache: 'no-store', signal }),
      fetch('/api/agents', { cache: 'no-store', signal }),
    ]);
    const teamData = await teamResponse.json() as { ok?: boolean; workers?: TeamGraphNode[]; error?: string };
    const agentData = await agentsResponse.json() as { agents?: AgentOption[]; error?: string };
    if (!teamResponse.ok || !teamData.ok) throw new Error(teamData.error || 'Could not load the specialist team');
    if (!agentsResponse.ok) throw new Error(agentData.error || 'Could not load agents');
    setGraph(teamData.workers || []);
    setAgents(agentData.agents || []);
    setError(null);
  }, [task.id]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(controller.signal).catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load the specialist team');
      });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  function startEditing() {
    const firstAgent = agents[0]?.id || '';
    setWorkers([emptyWorker(1, task, firstAgent), emptyWorker(2, task, firstAgent)]);
    setEditing(true);
  }

  function patchWorker(index: number, patch: Partial<TeamWorkerSpec>) {
    setWorkers((current) => current.map((worker, position) => position === index ? { ...worker, ...patch } : worker));
  }

  async function createTeam() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workers, start: true }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not create the worker team');
      setEditing(false);
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create the worker team');
    } finally {
      setPending(false);
    }
  }

  async function commandWorker(node: TeamGraphNode, kind: 'pause' | 'resume' | 'cancel' | 'steer') {
    if (workerPending) return;
    if (kind === 'cancel') {
      const confirmed = await confirmDialog({
        title: `Cancel ${node.task.title}?`,
        message: 'This stops the selected specialist only. Downstream dependencies will remain blocked until you retry or replace it.',
        confirmLabel: 'Cancel specialist',
        danger: true,
      });
      if (!confirmed) return;
    }
    const instruction = workerInstructions[node.task.id]?.trim() || '';
    if (kind === 'steer' && !instruction) return;
    setWorkerPending(`${kind}:${node.task.id}`);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(node.task.id)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: kind,
          payload: kind === 'steer' ? { instruction } : {},
          expectedVersion: node.task.version,
          idempotencyKey: `team:${task.id}:${node.task.id}:${kind}:${crypto.randomUUID()}`,
        }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || `Could not ${kind} the specialist`);
      if (kind === 'steer') setWorkerInstructions((current) => ({ ...current, [node.task.id]: '' }));
      await load();
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : `Could not ${kind} the specialist`);
      await load();
    } finally {
      setWorkerPending(null);
    }
  }

  if (!task.workspaceRoots.length || (!agents.length && !graph.length && !error)) return null;
  return (
    <section className="grok-card p-5 space-y-4" aria-labelledby="team-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="team-heading" className="text-base font-semibold flex items-center gap-2"><Users size={16} /> Specialist team</h2>
          <p className="text-xs text-dim mt-1">Workers are child tasks with dependencies, leases, budgets, evidence, and isolated writer worktrees.</p>
        </div>
        <div className="flex gap-1">
          {(graph.length > 0 || !!error) && <button type="button" className="grok-btn grok-btn-ghost" onClick={() => void load()}><RefreshCw size={13} /> Refresh</button>}
          {!editing && graph.length === 0 && agents.length > 0 && <button type="button" className="grok-btn grok-btn-secondary" onClick={startEditing}><Plus size={13} /> Build team</button>}
        </div>
      </div>

      {graph.length > 0 && (
        <ol className="grid gap-3 md:grid-cols-2" aria-label="Worker dependency graph">
          {graph.map((node) => (
            <li key={node.task.id} className="border border-default rounded-md p-3">
              <div className="flex items-center gap-2"><span className="text-sm font-medium">{node.task.title}</span><span className="status-pill text-dim">{node.task.status}</span></div>
              <div className="text-[11px] text-dim mt-1">{node.task.metadata.readOnly ? 'read-only researcher' : 'isolated writer'} · attempt {node.claim?.attempt || node.task.retryCount + 1}</div>
              {node.dependencies.length > 0 && <div className="text-[11px] text-dim mt-2">Depends on {node.dependencies.map((id) => graph.find((item) => item.task.id === id)?.key || id).join(', ')}</div>}
              {['running', 'paused', 'waiting_for_input', 'waiting_for_approval'].includes(node.task.status) && (
                <form className="flex gap-2 mt-3" onSubmit={(event) => { event.preventDefault(); void commandWorker(node, 'steer'); }}>
                  <input
                    className="grok-input min-w-0 flex-1 text-xs"
                    aria-label={`Steer ${node.task.title}`}
                    value={workerInstructions[node.task.id] || ''}
                    maxLength={4_000}
                    placeholder="Append an instruction"
                    onChange={(event) => setWorkerInstructions((current) => ({ ...current, [node.task.id]: event.target.value }))}
                  />
                  <button type="submit" className="grok-btn grok-btn-ghost" title="Steer specialist" disabled={!workerInstructions[node.task.id]?.trim() || !!workerPending}>
                    {workerPending === `steer:${node.task.id}` ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    <span className="sr-only">Steer specialist</span>
                  </button>
                </form>
              )}
              <div className="flex flex-wrap items-center gap-1 mt-3">
                <a href={`/tasks/${encodeURIComponent(node.task.id)}`} className="link-accent inline-flex items-center gap-1 text-xs mr-auto">Inspect worker <ChevronRight size={11} /></a>
                {node.task.status === 'running' && <button type="button" className="grok-btn grok-btn-ghost" disabled={!!workerPending} onClick={() => void commandWorker(node, 'pause')}><Pause size={12} /> Pause</button>}
                {node.task.status === 'paused' && <button type="button" className="grok-btn grok-btn-ghost" disabled={!!workerPending} onClick={() => void commandWorker(node, 'resume')}><Play size={12} /> Resume</button>}
                {['queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked'].includes(node.task.status) && <button type="button" className="grok-btn grok-btn-ghost text-error" disabled={!!workerPending} onClick={() => void commandWorker(node, 'cancel')}><Square size={11} /> Cancel</button>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {editing && (
        <div className="space-y-3">
          {workers.map((worker, index) => (
            <fieldset key={`${worker.key}-${index}`} className="border border-default rounded-md p-3 grid gap-3 md:grid-cols-2">
              <legend className="text-xs font-medium px-1">Specialist {index + 1}</legend>
              <label className="text-xs">Key<input className="grok-input w-full mt-1" value={worker.key} onChange={(event) => patchWorker(index, { key: event.target.value })} /></label>
              <label className="text-xs">Agent<select className="grok-select w-full mt-1" value={worker.agentId} onChange={(event) => patchWorker(index, { agentId: event.target.value })}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
              <label className="text-xs md:col-span-2">Outcome<input className="grok-input w-full mt-1" value={worker.title} onChange={(event) => patchWorker(index, { title: event.target.value })} /></label>
              <label className="text-xs md:col-span-2">Instructions<textarea className="grok-input w-full min-h-20 mt-1" value={worker.instructions} onChange={(event) => patchWorker(index, { instructions: event.target.value })} /></label>
              <label className="text-xs">Workspace<select className="grok-select w-full mt-1" value={worker.workspaceRootIds[0] || ''} onChange={(event) => patchWorker(index, { workspaceRootIds: [event.target.value] })}>{task.workspaceRoots.map((root) => <option key={root.id} value={root.id} disabled={!worker.readOnly && root.permission !== 'write'}>{root.label || root.path}</option>)}</select></label>
              <label className="text-xs">Depends on<input className="grok-input w-full mt-1" placeholder="worker-1, worker-2" value={(worker.dependsOn || []).join(', ')} onChange={(event) => patchWorker(index, { dependsOn: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></label>
              <label className="inline-flex items-center gap-2 text-xs"><input type="checkbox" checked={!!worker.readOnly} onChange={(event) => patchWorker(index, { readOnly: event.target.checked })} /> Read-only researcher</label>
              <button type="button" className="grok-btn grok-btn-ghost text-error justify-self-start" disabled={workers.length === 1} onClick={() => setWorkers((current) => current.filter((_, position) => position !== index))}><Trash2 size={12} /> Remove</button>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="grok-btn grok-btn-ghost" disabled={workers.length >= 12} onClick={() => setWorkers((current) => [...current, emptyWorker(current.length + 1, task, agents[0]?.id || '')])}><Plus size={12} /> Add specialist</button>
            <button type="button" className="grok-btn grok-btn-primary" disabled={pending} onClick={() => void createTeam()}>{pending ? <Loader2 size={13} className="animate-spin" /> : <Users size={13} />} Create and start</button>
            <button type="button" className="grok-btn grok-btn-ghost" disabled={pending} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <div className="text-xs text-error" role="alert">{error}</div>}
    </section>
  );
}

export default TaskTeamPanel;
