'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Braces,
  CalendarClock,
  ChevronDown,
  ChevronRight,
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

const SCHEDULE_LABELS: Record<string, string> = {
  '0 * * * *': 'Every hour',
  '0 9 * * *': 'Daily at 9:00 AM',
  '0 9 * * 1-5': 'Weekdays at 9:00 AM',
  '*/15 * * * *': 'Every 15 minutes',
};

function formatDate(value?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function triggerLabel(trigger: RoutineTrigger): string {
  if (trigger.type === 'schedule') {
    return SCHEDULE_LABELS[trigger.cron] || `Schedule: ${trigger.cron}`;
  }
  if (trigger.type === 'one_time') return `Once on ${formatDate(trigger.at)}`;
  if (trigger.type === 'webhook') return 'When its signed webhook is called';
  if (trigger.type === 'health') return trigger.url ? `Watch ${trigger.url}` : `Watch process ${trigger.processPid}`;
  if (trigger.type === 'filesystem') return `When ${trigger.path} changes`;
  if (trigger.type === 'integration_event') return `When ${trigger.integration} sends ${trigger.event}`;
  return 'Only when you run it';
}

function triggerIcon(trigger: RoutineTrigger) {
  if (trigger.type === 'webhook') return Webhook;
  if (trigger.type === 'schedule' || trigger.type === 'one_time') return CalendarClock;
  if (trigger.type === 'integration_event') return Braces;
  if (trigger.type === 'filesystem') return Code2;
  return Workflow;
}

function triggerTypeLabel(type: RoutineInvocation['triggerType']): string {
  if (type === 'one_time') return 'One-time';
  if (type === 'integration_event') return 'Integration event';
  if (type === 'filesystem') return 'File change';
  if (type === 'health') return 'Health check';
  if (type === 'webhook') return 'Webhook';
  if (type === 'schedule') return 'Schedule';
  return 'Manual';
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
  const activeTriggers = routine.triggers.filter((trigger) => trigger.enabled);
  return (
    <button
      type="button"
      className="grok-card grok-card-interactive p-4 w-full text-left"
      style={selected ? { borderColor: 'var(--accent)' } : undefined}
      onClick={onSelect}
      aria-expanded={selected}
      aria-controls={`automation-${routine.id}-details`}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md p-2 bg-[var(--bg-elev)] text-muted"><Workflow size={16} aria-hidden="true" /></div>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium truncate">{routine.name}</span>
            <span className={`status-pill ${routine.enabled ? 'text-success' : 'text-dim'}`}>{routine.enabled ? 'active' : 'paused'}</span>
            {routine.circuitState === 'open' && <span className="status-pill text-error">breaker open</span>}
          </span>
          <span className="block text-xs text-dim mt-1">{routine.description || `Runs with ${agentName}`}</span>
          <span className="flex flex-wrap gap-1.5 mt-2">
            {activeTriggers.slice(0, 2).map((trigger) => <span key={trigger.id} className="status-pill text-muted max-w-full truncate">{triggerLabel(trigger)}</span>)}
            {activeTriggers.length > 2 && <span className="status-pill text-dim">+{activeTriggers.length - 2} more</span>}
            {activeTriggers.length === 0 && <span className="status-pill text-dim">No active triggers</span>}
          </span>
        </span>
        <ChevronDown size={15} className={`text-dim shrink-0 mt-1 transition-transform ${selected ? 'rotate-180' : ''}`} aria-hidden="true" />
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

  function toggleRoutine(routineId: string) {
    if (selectedId === routineId) {
      detailRequest.current += 1;
      setSelectedId(null);
      setSelected(null);
      setInvocations([]);
      setDetailLoading(false);
      router.replace('/automations');
      return;
    }
    setSelectedId(routineId);
    setSelected(null);
    setInvocations([]);
    void loadDetail(routineId);
    router.replace(`/automations?routine=${encodeURIComponent(routineId)}`);
  }

  return (
    <section className="space-y-5" aria-labelledby="durable-automations-heading">
      <header className="page-head-row mb-0">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.16em] text-dim mb-1">Repeatable work</div>
          <h1 id="durable-automations-heading" className="page-title">Automations</h1>
          <p className="page-subtitle">Choose what should happen and when. Shiba handles the runs, retries, and recovery.</p>
        </div>
        <button type="button" className="grok-btn grok-btn-primary shrink-0" onClick={newRoutine} disabled={agents.length === 0}><Plus size={14} /> New automation</button>
      </header>

      {error && <div className="grok-card p-3 text-sm text-error" role="alert">{error}</div>}

      {routines === null ? (
        <div className="grok-card p-8 text-center text-sm text-dim" aria-busy="true"><Loader2 size={18} className="animate-spin mx-auto mb-2" /> Loading automations…</div>
      ) : routines.length === 0 ? (
        <div className="grok-card p-10 text-center">
          <Workflow size={30} className="mx-auto text-muted mb-3" aria-hidden="true" />
          <div className="font-medium">Create your first automation</div>
          <p className="text-sm text-dim mt-1 max-w-lg mx-auto">Tell Shiba what to do, then choose whether it runs manually, on a schedule, or when something changes.</p>
          <button type="button" className="grok-btn grok-btn-primary mt-4" onClick={newRoutine} disabled={agents.length === 0}><Plus size={14} /> New automation</button>
          {agents.length === 0 && <p className="text-xs text-warning mt-3">Create an agent first so the automation has an execution owner.</p>}
        </div>
      ) : (
        <div className="max-w-5xl space-y-3">
          <div className="flex items-center justify-between gap-3 text-xs text-dim">
            <span>{routines.filter((routine) => routine.enabled).length} active · {routines.length} total</span>
            <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={() => void loadRoutines()} aria-label="Refresh automations"><RefreshCw size={13} aria-hidden="true" /></button>
          </div>
          {routines.map((routine) => {
            const agentName = agents.find((agent) => agent.id === routine.agentId)?.name || routine.agentId;
            const details = selected?.id === routine.id ? selected : null;
            return (
              <div key={routine.id} className="space-y-2">
                <RoutineCard routine={routine} agentName={agentName} selected={selectedId === routine.id} onSelect={() => toggleRoutine(routine.id)} />
                {selectedId === routine.id && (
                  <section id={`automation-${routine.id}-details`} className="rounded-lg border border-default bg-[var(--bg-elev)] p-4 sm:p-5" aria-label={`${routine.name} details`}>
                    {detailLoading && !details ? (
                      <div className="text-sm text-dim flex items-center gap-2 py-4"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading automation…</div>
                    ) : !details ? (
                      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-error"><span>Could not load this automation.</span><button type="button" className="grok-btn grok-btn-secondary" onClick={() => void loadDetail(routine.id)}>Try again</button></div>
                    ) : (
                      <div className="space-y-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm text-muted">Runs with {agentName} · updated {formatDate(details.updatedAt)}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button type="button" className="grok-btn grok-btn-primary" onClick={() => void runRoutine(details)} disabled={Boolean(action)}>{action === `run:${details.id}` ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />} Run now</button>
                            <button type="button" className="grok-btn grok-btn-secondary" onClick={() => editRoutine(details)}><Pencil size={13} aria-hidden="true" /> Edit</button>
                            <details className="relative">
                              <summary className="grok-btn grok-btn-ghost cursor-pointer list-none">More <ChevronDown size={13} aria-hidden="true" /></summary>
                              <div className="absolute right-0 top-full z-20 mt-1 min-w-44 rounded-lg border border-default bg-[var(--bg-elev)] p-1.5 shadow-xl">
                                <a className="grok-btn grok-btn-ghost w-full justify-start" href={`/api/routines/${encodeURIComponent(details.id)}/export?format=json`}><FileJson size={13} aria-hidden="true" /> Export JSON</a>
                                <a className="grok-btn grok-btn-ghost w-full justify-start" href={`/api/routines/${encodeURIComponent(details.id)}/export?format=yaml`}><Download size={13} aria-hidden="true" /> Export YAML</a>
                                <button type="button" className="grok-btn grok-btn-ghost text-error w-full justify-start" onClick={() => void deleteRoutine(details)} disabled={Boolean(action)}><Trash2 size={13} aria-hidden="true" /> Delete</button>
                              </div>
                            </details>
                          </div>
                        </div>

                        {details.circuitState === 'open' && (
                          <div className="border border-[var(--error)] rounded-md p-3 text-sm text-error">
                            <div className="flex items-center gap-2 font-medium"><ShieldAlert size={15} aria-hidden="true" /> Runs paused after repeated failures</div>
                            <p className="text-xs mt-1">{details.failureStreak} consecutive failures. Automatic runs resume after {formatDate(details.circuitOpenUntil)}.</p>
                            <button type="button" className="grok-btn grok-btn-secondary mt-2" onClick={() => void resetCircuit(details)} disabled={Boolean(action)}>{action === `reset:${details.id}` ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />} Resume now</button>
                          </div>
                        )}

                        <div>
                          <h3 className="text-xs uppercase tracking-wider text-dim mb-2">What it does</h3>
                          <p className="text-sm whitespace-pre-wrap max-h-32 overflow-y-auto">{details.prompt}</p>
                        </div>

                        <div>
                          <div className="flex items-center justify-between gap-2 mb-2"><h3 className="text-xs uppercase tracking-wider text-dim">Recent runs</h3><button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={() => void loadDetail(details.id)} aria-label="Refresh recent runs"><RefreshCw size={12} aria-hidden="true" /></button></div>
                          {invocations.length === 0 ? <p className="text-sm text-dim">No runs yet. Start one now or wait for a trigger.</p> : (
                            <div className="border border-default rounded-md divide-y divide-default max-h-80 overflow-y-auto">
                              {invocations.slice(0, 30).map((invocation) => (
                                <div key={invocation.id} className="p-3 text-xs">
                                  <div className="flex flex-wrap items-center gap-2"><span className={`status-pill ${invocationTone(invocation.status)}`}>{invocation.status}</span><span>{triggerTypeLabel(invocation.triggerType)}</span><span className="text-dim">attempt {invocation.attempt}/{invocation.maxAttempts}</span><span className="text-dim ml-auto">{formatDate(invocation.updatedAt)}</span></div>
                                  {invocation.error && <p className="text-error mt-1.5 whitespace-pre-wrap">{invocation.error}</p>}
                                  {invocation.taskId && <button type="button" className="inline-flex items-center gap-1 text-muted underline mt-1.5" onClick={() => router.push(`/tasks/${encodeURIComponent(invocation.taskId!)}`)}>Open task <ChevronRight size={11} aria-hidden="true" /></button>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <details className="border-t border-default pt-4">
                          <summary className="cursor-pointer inline-flex items-center gap-2 text-sm font-medium text-muted"><ChevronDown size={13} aria-hidden="true" /> Advanced details</summary>
                          <div className="mt-4 space-y-4">
                            <div>
                              <h3 className="text-xs uppercase tracking-wider text-dim mb-2">When it runs</h3>
                              <ul className="space-y-2">
                                {details.triggers.map((trigger) => {
                                  const Icon = triggerIcon(trigger);
                                  return <li key={trigger.id} className="flex flex-wrap items-center gap-2 text-sm"><Icon size={14} className="text-muted shrink-0" aria-hidden="true" /><span>{trigger.type === 'webhook' ? `Webhook: /api/routines/${details.id}/webhook` : triggerLabel(trigger)}</span><span className="status-pill text-dim font-mono">{trigger.id}</span><span className={`status-pill ml-auto ${trigger.enabled ? 'text-success' : 'text-dim'}`}>{trigger.enabled ? 'on' : 'off'}</span></li>;
                                })}
                              </ul>
                            </div>
                            <dl className="grid gap-3 sm:grid-cols-2 text-xs">
                              <div><dt className="text-dim">Workflow</dt><dd className="mt-0.5">{details.steps.length ? `${details.steps.length} configured step${details.steps.length === 1 ? '' : 's'}` : 'Main instructions run as one step'}</dd></div>
                              <div><dt className="text-dim">Retries</dt><dd className="mt-0.5">Up to {details.retryPolicy.maxAttempts} attempts with backoff</dd></div>
                              <div><dt className="text-dim">Active-run timeout</dt><dd className="mt-0.5">{Math.round(details.timeoutMs / 1_000)} seconds (pauses while waiting for you)</dd></div>
                              <div><dt className="text-dim">Missed schedules</dt><dd className="mt-0.5">{details.catchUpPolicy === 'run_once' ? 'Run once after a missed trigger' : 'Skip missed triggers'}</dd></div>
                              <div className="sm:col-span-2"><dt className="text-dim">Concurrency key</dt><dd className="font-mono mt-0.5 break-all">{details.concurrencyKey}</dd></div>
                            </dl>
                            {details.triggers.some((trigger) => trigger.type === 'webhook') && (
                              <div className="rounded-md border border-default p-3 text-xs text-dim">
                                <div className="font-medium text-muted mb-2">Signed webhook headers</div>
                                <div className="space-y-1 font-mono"><div>x-shiba-timestamp: Unix seconds</div><div>x-shiba-signature: sha256=HMAC(secret, timestamp + &quot;.&quot; + rawBody)</div><div>x-shiba-delivery: stable provider delivery ID</div><div>x-shiba-trigger: trigger ID (only needed with multiple webhooks)</div></div>
                              </div>
                            )}
                          </div>
                        </details>
                      </div>
                    )}
                  </section>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editor && <RoutineEditor key={editor.key} agents={agents} initial={editor.initial} title={editor.routine ? `Edit ${editor.routine.name}` : editor.sourceTaskId ? 'Configure automation draft' : 'New automation'} saving={saving} onCancel={() => !saving && setEditor(null)} onSave={saveRoutine} />}
    </section>
  );
}

export default RoutinesPanel;
