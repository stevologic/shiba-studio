'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Braces,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Code2,
  Download,
  FileJson,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Webhook,
  Workflow,
} from 'lucide-react';
import { confirmDialog } from '@/components/confirm-dialog';
import { emptyRoutineInput, RoutineEditor, routineToInput } from '@/components/routine-editor';
import { subscribeLiveEvents } from '@/lib/live-events';
import { toast } from '@/lib/toast';
import type { Agent } from '@/lib/types';
import type { CreateRoutineInput, RoutineDefinition, RoutineInvocation, RoutineTrigger } from '@/lib/routine-types';
import type { TaskDetails } from '@/lib/task-types';

interface RoutinesPanelProps {
  agents: Agent[];
}

interface RoutineEditorState {
  key: string;
  routine?: RoutineDefinition;
  sourceTaskId?: string;
  initial: CreateRoutineInput;
}

interface RoutineDetailResponse {
  ok?: boolean;
  routine?: RoutineDefinition;
  invocations?: RoutineInvocation[];
  error?: string;
}

function formatDate(value?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function triggerLabel(trigger: RoutineTrigger): string {
  if (trigger.type === 'schedule') return trigger.cron;
  if (trigger.type === 'one_time') return `once ${formatDate(trigger.at)}`;
  if (trigger.type === 'webhook') return 'signed webhook';
  if (trigger.type === 'health') return trigger.url ? `health ${trigger.url}` : `process ${trigger.processPid}`;
  if (trigger.type === 'filesystem') return `watch ${trigger.path}`;
  if (trigger.type === 'integration_event') return `${trigger.integration}:${trigger.event}`;
  return 'manual';
}

function triggerIcon(trigger: RoutineTrigger) {
  if (trigger.type === 'webhook') return Webhook;
  if (trigger.type === 'schedule' || trigger.type === 'one_time') return CalendarClock;
  if (trigger.type === 'integration_event') return Braces;
  if (trigger.type === 'filesystem') return Code2;
  return Workflow;
}

function invocationTone(status: RoutineInvocation['status']): string {
  if (status === 'succeeded') return 'text-success';
  if (status === 'failed') return 'text-error';
  if (status === 'skipped') return 'text-warning';
  return 'text-muted';
}

function RoutineCard({
  routine,
  agentName,
  selected,
  onSelect,
}: {
  routine: RoutineDefinition;
  agentName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="grok-card grok-card-interactive p-4 w-full text-left"
      style={selected ? { borderColor: 'var(--accent)' } : undefined}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md p-2 bg-[var(--bg-elev)] text-muted"><Workflow size={16} aria-hidden="true" /></div>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium truncate">{routine.name}</span>
            <span className={`status-pill ${routine.enabled ? 'text-success' : 'text-dim'}`}>{routine.enabled ? 'active' : 'paused'}</span>
            {routine.circuitState === 'open' && <span className="status-pill text-error">breaker open</span>}
          </span>
          <span className="block text-xs text-dim mt-1">{agentName} · {routine.triggers.length} trigger{routine.triggers.length === 1 ? '' : 's'} · {routine.steps.length || 1} step{routine.steps.length === 1 ? '' : 's'}</span>
          <span className="flex flex-wrap gap-1.5 mt-2">
            {routine.triggers.filter((trigger) => trigger.enabled).slice(0, 4).map((trigger) => <span key={trigger.id} className="status-pill text-muted font-mono max-w-full truncate">{triggerLabel(trigger)}</span>)}
          </span>
        </span>
        <ChevronRight size={15} className="text-dim shrink-0 mt-1" aria-hidden="true" />
      </div>
    </button>
  );
}

export function RoutinesPanel({ agents }: RoutinesPanelProps) {
  const router = useRouter();
  const [routines, setRoutines] = useState<RoutineDefinition[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<RoutineDefinition | null>(null);
  const [invocations, setInvocations] = useState<RoutineInvocation[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editor, setEditor] = useState<RoutineEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deepLinkHandled = useRef(false);
  const detailRequest = useRef(0);

  const loadRoutines = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/routines?limit=500', { cache: 'no-store', signal });
      const data = await response.json() as { ok?: boolean; routines?: RoutineDefinition[]; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load automations');
      setRoutines(data.routines || []);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setRoutines([]);
      setError(loadError instanceof Error ? loadError.message : 'Could not load automations');
    }
  }, []);

  const loadDetail = useCallback(async (routineId: string, signal?: AbortSignal) => {
    const requestId = ++detailRequest.current;
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/routines/${encodeURIComponent(routineId)}`, { cache: 'no-store', signal });
      const data = await response.json() as RoutineDetailResponse;
      if (!response.ok || !data.ok || !data.routine) throw new Error(data.error || 'Could not load automation details');
      if (requestId !== detailRequest.current) return;
      setSelectedId(routineId);
      setSelected(data.routine);
      setInvocations(data.invocations || []);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      if (requestId !== detailRequest.current) return;
      setError(loadError instanceof Error ? loadError.message : 'Could not load automation details');
    } finally {
      if (!signal?.aborted && requestId === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void loadRoutines(controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [loadRoutines]);

  useEffect(() => subscribeLiveEvents(['routines'], () => {
    void loadRoutines();
    if (selectedId) void loadDetail(selectedId);
  }), [loadDetail, loadRoutines, selectedId]);

  useEffect(() => {
    if (deepLinkHandled.current || typeof window === 'undefined') return;
    deepLinkHandled.current = true;
    const query = new URLSearchParams(window.location.search);
    const routineTaskId = query.get('routineTask');
    const routineId = query.get('routine');
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (routineId) {
        await loadDetail(routineId, controller.signal);
        return;
      }
      if (!routineTaskId) return;
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(routineTaskId)}`, { cache: 'no-store', signal: controller.signal });
        const data = await response.json() as { ok?: boolean; task?: TaskDetails; error?: string };
        if (!response.ok || !data.ok || !data.task) throw new Error(data.error || 'Could not load the automation draft');
        const linkedRoutine = typeof data.task.metadata.routineId === 'string' ? data.task.metadata.routineId : '';
        if (linkedRoutine) {
          router.replace(`/automations?routine=${encodeURIComponent(linkedRoutine)}`);
          await loadDetail(linkedRoutine, controller.signal);
          return;
        }
        setEditor({
          key: `task:${data.task.id}`,
          sourceTaskId: data.task.id,
          initial: {
            ...emptyRoutineInput(data.task.agentId || agents[0]?.id || '', { name: data.task.title, prompt: data.task.description }),
            description: `Configured from task ${data.task.id}`,
          },
        });
      } catch (draftError) {
        if (draftError instanceof DOMException && draftError.name === 'AbortError') return;
        setError(draftError instanceof Error ? draftError.message : 'Could not load the automation draft');
      }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [agents, loadDetail, router]);

  function newRoutine() {
    setEditor({ key: `new:${crypto.randomUUID()}`, initial: emptyRoutineInput(agents[0]?.id || '') });
  }

  function editRoutine(routine: RoutineDefinition) {
    setEditor({ key: `edit:${routine.id}:${routine.version}`, routine, initial: routineToInput(routine) });
  }

  async function linkSourceTask(taskId: string, routineId: string) {
    const currentResponse = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
    const currentData = await currentResponse.json() as { ok?: boolean; task?: TaskDetails; error?: string };
    if (!currentResponse.ok || !currentData.ok || !currentData.task) throw new Error(currentData.error || 'Automation was saved, but its source task could not be loaded');
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: currentData.task.version,
        status: currentData.task.status,
        currentStep: 'Automation configured',
        nextAction: 'Waiting for a configured trigger or manual run',
        metadata: { routineId, routineConfiguredAt: new Date().toISOString(), routineUrl: `/automations?routine=${encodeURIComponent(routineId)}` },
      }),
    });
    const data = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !data.ok) throw new Error(data.error || 'Automation was saved, but the source task could not be linked');
  }

  async function saveRoutine(input: CreateRoutineInput) {
    if (!editor || saving) return;
    setSaving(true);
    setError(null);
    try {
      const editing = editor.routine;
      const response = await fetch(editing ? `/api/routines/${encodeURIComponent(editing.id)}` : '/api/routines', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing ? { ...input, expectedVersion: editing.version } : input),
      });
      const data = await response.json() as { ok?: boolean; routine?: RoutineDefinition; error?: string };
      if (!response.ok || !data.ok || !data.routine) throw new Error(data.error || 'Could not save the automation');
      if (editor.sourceTaskId) {
        try { await linkSourceTask(editor.sourceTaskId, data.routine.id); }
        catch (linkError) { toast.warning(linkError instanceof Error ? linkError.message : 'Automation saved, but the source task was not linked'); }
      }
      setEditor(null);
      await loadRoutines();
      await loadDetail(data.routine.id);
      router.replace(`/automations?routine=${encodeURIComponent(data.routine.id)}`);
      toast.success(editing ? 'Automation updated' : 'Automation created');
    } finally {
      setSaving(false);
    }
  }

  async function runRoutine(routine: RoutineDefinition) {
    setAction(`run:${routine.id}`);
    try {
      const response = await fetch(`/api/routines/${encodeURIComponent(routine.id)}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json() as { ok?: boolean; invocation?: RoutineInvocation; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not queue the automation');
      if (data.invocation?.status === 'skipped') toast.warning(data.invocation.error || 'Automation run was skipped');
      else toast.success('Automation queued');
      await loadDetail(routine.id);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Could not queue the automation');
    } finally {
      setAction(null);
    }
  }

  async function resetCircuit(routine: RoutineDefinition) {
    setAction(`reset:${routine.id}`);
    try {
      const response = await fetch(`/api/routines/${encodeURIComponent(routine.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset_circuit', expectedVersion: routine.version }),
      });
      const data = await response.json() as { ok?: boolean; routine?: RoutineDefinition; error?: string };
      if (!response.ok || !data.ok || !data.routine) throw new Error(data.error || 'Could not reset the circuit breaker');
      toast.success('Circuit breaker reset');
      await loadRoutines();
      await loadDetail(routine.id);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Could not reset the circuit breaker');
    } finally {
      setAction(null);
    }
  }

  async function deleteRoutine(routine: RoutineDefinition) {
    const confirmed = await confirmDialog({ title: `Delete ${routine.name}?`, message: 'The definition is disabled and removed. Invocation history remains durable.', confirmLabel: 'Delete automation', danger: true });
    if (!confirmed) return;
    setAction(`delete:${routine.id}`);
    try {
      const response = await fetch(`/api/routines/${encodeURIComponent(routine.id)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: routine.version }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not delete the automation');
      setSelected(null);
      setSelectedId(null);
      setInvocations([]);
      await loadRoutines();
      router.replace('/automations');
      toast.success('Automation deleted');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete the automation');
    } finally {
      setAction(null);
    }
  }

  return (
    <section className="space-y-5" aria-labelledby="durable-automations-heading">
      <header className="page-head-row mb-0">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.16em] text-dim mb-1">Event-driven automation</div>
          <h1 id="durable-automations-heading" className="page-title">Automations</h1>
          <p className="page-subtitle">Run the same governed workflow manually, on a schedule, from a signed webhook, or when local and connected systems change.</p>
        </div>
        <button type="button" className="grok-btn grok-btn-primary shrink-0" onClick={newRoutine}><Plus size={14} /> New automation</button>
      </header>

      {error && <div className="grok-card p-3 text-sm text-error" role="alert">{error}</div>}

      {routines === null ? (
        <div className="grok-card p-8 text-center text-sm text-dim" aria-busy="true"><Loader2 size={18} className="animate-spin mx-auto mb-2" /> Loading automations…</div>
      ) : routines.length === 0 ? (
        <div className="grok-card p-10 text-center">
          <Workflow size={30} className="mx-auto text-muted mb-3" aria-hidden="true" />
          <div className="font-medium">Create your first automation</div>
          <p className="text-sm text-dim mt-1 max-w-lg mx-auto">Triggers are deduplicated, retries survive restarts, and repeated failures open one visible circuit breaker.</p>
          <button type="button" className="grok-btn grok-btn-primary mt-4" onClick={newRoutine} disabled={agents.length === 0}><Plus size={14} /> New automation</button>
          {agents.length === 0 && <p className="text-xs text-warning mt-3">Create an agent first so the automation has an execution owner.</p>}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.5fr)] items-start">
          <div className="space-y-3">
            {routines.map((routine) => (
              <RoutineCard key={routine.id} routine={routine} agentName={agents.find((agent) => agent.id === routine.agentId)?.name || routine.agentId} selected={selectedId === routine.id} onSelect={() => void loadDetail(routine.id)} />
            ))}
          </div>
          <div className="grok-card p-5 min-h-64 lg:sticky lg:top-4">
            {detailLoading && !selected ? (
              <div className="text-sm text-dim flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading automation…</div>
            ) : !selected ? (
              <div className="text-center text-sm text-dim py-12"><CircleDashed size={24} className="mx-auto mb-3 opacity-50" />Select an automation to inspect its contract and invocation state.</div>
            ) : (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">{selected.name}</h2><span className={`status-pill ${selected.enabled ? 'text-success' : 'text-dim'}`}>{selected.enabled ? 'active' : 'paused'}</span></div><p className="text-xs text-dim mt-1">Revision {selected.version} · updated {formatDate(selected.updatedAt)}</p></div>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className="grok-btn grok-btn-primary" onClick={() => void runRoutine(selected)} disabled={Boolean(action)}>{action === `run:${selected.id}` ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Run now</button>
                    <button type="button" className="grok-btn grok-btn-secondary" onClick={() => editRoutine(selected)}><Pencil size={13} /> Edit</button>
                    <a className="grok-btn grok-btn-ghost" href={`/api/routines/${encodeURIComponent(selected.id)}/export?format=json`}><FileJson size={13} /> JSON</a>
                    <a className="grok-btn grok-btn-ghost" href={`/api/routines/${encodeURIComponent(selected.id)}/export?format=yaml`}><Download size={13} /> YAML</a>
                    <button type="button" className="grok-btn grok-btn-ghost text-error" onClick={() => void deleteRoutine(selected)} disabled={Boolean(action)} aria-label={`Delete ${selected.name}`}><Trash2 size={13} /></button>
                  </div>
                </div>

                {selected.circuitState === 'open' && (
                  <div className="border border-[var(--error)] rounded-md p-3 text-sm text-error">
                    <div className="flex items-center gap-2 font-medium"><ShieldAlert size={15} /> Circuit breaker open</div>
                    <p className="text-xs mt-1">{selected.failureStreak} consecutive failures. Automatic claims pause until {formatDate(selected.circuitOpenUntil)}.</p>
                    <button type="button" className="grok-btn grok-btn-secondary mt-2" onClick={() => void resetCircuit(selected)} disabled={Boolean(action)}>{action === `reset:${selected.id}` ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Reset breaker</button>
                  </div>
                )}

                <div>
                  <h3 className="text-xs uppercase tracking-wider text-dim mb-2">Triggers</h3>
                  <ul className="space-y-2">
                    {selected.triggers.map((trigger) => {
                      const Icon = triggerIcon(trigger);
                      return <li key={trigger.id} className="flex items-center gap-2 text-sm"><Icon size={14} className="text-muted shrink-0" /><span className="font-mono text-xs break-all">{trigger.type === 'webhook' ? `/api/routines/${selected.id}/webhook` : triggerLabel(trigger)}</span><span className="status-pill text-dim font-mono">{trigger.id}</span><span className={`status-pill ml-auto ${trigger.enabled ? 'text-success' : 'text-dim'}`}>{trigger.enabled ? 'on' : 'off'}</span></li>;
                    })}
                  </ul>
                </div>

                <dl className="grid gap-3 sm:grid-cols-2 text-xs">
                  <div><dt className="text-dim">Concurrency</dt><dd className="font-mono mt-0.5 break-all">{selected.concurrencyKey}</dd></div>
                  <div><dt className="text-dim">Retry</dt><dd className="mt-0.5">{selected.retryPolicy.maxAttempts} attempts · {selected.retryPolicy.baseDelayMs} ms × {selected.retryPolicy.multiplier}</dd></div>
                  <div><dt className="text-dim">Timeout</dt><dd className="mt-0.5">{Math.round(selected.timeoutMs / 1_000)} seconds total</dd></div>
                  <div><dt className="text-dim">Catch-up</dt><dd className="mt-0.5">{selected.catchUpPolicy === 'run_once' ? 'Run once after missed trigger' : 'Skip missed triggers'}</dd></div>
                </dl>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-2"><h3 className="text-xs uppercase tracking-wider text-dim">Recent invocations</h3><button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={() => void loadDetail(selected.id)} aria-label="Refresh invocation state"><RefreshCw size={12} /></button></div>
                  {invocations.length === 0 ? <p className="text-sm text-dim">No invocations yet. Run it manually or wait for a trigger.</p> : (
                    <div className="border border-default rounded-md divide-y divide-default max-h-80 overflow-y-auto">
                      {invocations.slice(0, 30).map((invocation) => (
                        <div key={invocation.id} className="p-3 text-xs">
                          <div className="flex flex-wrap items-center gap-2"><span className={`status-pill ${invocationTone(invocation.status)}`}>{invocation.status}</span><span className="font-mono">{invocation.triggerType}</span><span className="text-dim">attempt {invocation.attempt}/{invocation.maxAttempts}</span><span className="text-dim ml-auto">{formatDate(invocation.updatedAt)}</span></div>
                          {invocation.error && <p className="text-error mt-1.5 whitespace-pre-wrap">{invocation.error}</p>}
                          {invocation.taskId && <button type="button" className="inline-flex items-center gap-1 text-muted underline mt-1.5" onClick={() => router.push(`/tasks/${encodeURIComponent(invocation.taskId!)}`)}>Open task <ChevronRight size={11} /></button>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <details className="grok-card p-4 text-xs text-dim">
        <summary className="cursor-pointer inline-flex items-center gap-2 font-medium text-muted"><ChevronDown size={13} /> Signed webhook headers</summary>
        <div className="mt-3 space-y-1 font-mono"><div>x-shiba-timestamp: Unix seconds</div><div>x-shiba-signature: sha256=HMAC(secret, timestamp + &quot;.&quot; + rawBody)</div><div>x-shiba-delivery: stable provider delivery ID</div><div>x-shiba-trigger: trigger ID (optional when there is one webhook)</div></div>
      </details>

      {editor && <RoutineEditor key={editor.key} agents={agents} initial={editor.initial} title={editor.routine ? `Edit ${editor.routine.name}` : editor.sourceTaskId ? 'Configure automation draft' : 'New automation'} saving={saving} onCancel={() => !saving && setEditor(null)} onSave={saveRoutine} />}
    </section>
  );
}

export default RoutinesPanel;
