'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  FileCheck2,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Send,
  Square,
  XCircle,
} from 'lucide-react';
import { subscribeLiveEvents } from '@/lib/live-events';
import { confirmDialog } from '@/components/confirm-dialog';
import { HarnessGrantPanel } from '@/components/harness-grant-panel';
import { TaskTeamPanel } from '@/components/task-team-panel';
import { CheckpointPanel } from '@/components/checkpoint-panel';
import { EvidenceRecorder } from '@/components/evidence-recorder';
import { ArtifactStudioPanel } from '@/components/artifact-studio-panel';
import type {
  AttentionItem,
  CompletionEvaluation,
  RequirementEvaluation,
  TaskCommandKind,
  TaskDetails,
  TaskEvidence,
  TaskRecord,
  TaskStatus,
} from '@/lib/task-types';

interface TaskDetailPageProps {
  taskId: string;
  onBack?: () => void;
}

const CANCELLABLE_STATUSES = new Set<TaskStatus>([
  'queued',
  'running',
  'paused',
  'waiting_for_input',
  'waiting_for_approval',
  'blocked',
]);

function formatDate(value?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function statusTone(status: TaskStatus): string {
  if (status === 'succeeded') return 'text-success';
  if (status === 'failed' || status === 'lost' || status === 'cancelled') return 'text-error';
  if (status === 'blocked' || status.startsWith('waiting_')) return 'text-warning';
  return 'text-muted';
}

function evaluationTone(status: RequirementEvaluation['status']): string {
  if (status === 'proven') return 'text-success';
  if (status === 'failed') return 'text-error';
  return 'text-warning';
}

function evidenceTone(status: TaskEvidence['status']): string {
  if (status === 'passed') return 'text-success';
  if (status === 'failed') return 'text-error';
  return 'text-muted';
}

function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status-pill ${statusTone(status)}`}>{status.replaceAll('_', ' ')}</span>;
}

function ProgressBar({ progress }: { progress: number }) {
  const percentage = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-dim mb-1.5">
        <span>Progress</span>
        <span>{percentage}%</span>
      </div>
      <div className="h-2 rounded-full bg-[var(--bg-hover)] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
        <div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function EvaluationSummary({ completion }: { completion?: CompletionEvaluation }) {
  if (!completion) return <span className="text-xs text-dim">Evidence has not been evaluated yet.</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${completion.complete ? 'text-success' : 'text-warning'}`}>
      {completion.complete ? <CheckCircle2 size={13} aria-hidden="true" /> : <AlertCircle size={13} aria-hidden="true" />}
      {completion.complete ? 'Completion contract proven' : 'Completion contract is not yet proven'}
    </span>
  );
}

function EvidenceUri({ uri }: { uri?: string }) {
  if (!uri) return null;
  if (/^https?:\/\//i.test(uri)) {
    return (
      <a href={uri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline mt-1 break-all">
        Open evidence <ExternalLink size={11} aria-hidden="true" />
      </a>
    );
  }
  return <div className="text-[11px] font-mono text-dim mt-1 break-all">{uri}</div>;
}

export function TaskDetailPage({ taskId, onBack }: TaskDetailPageProps) {
  const router = useRouter();
  const [task, setTask] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState<TaskCommandKind | null>(null);
  const [dispatchPending, setDispatchPending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resolvingAttentionId, setResolvingAttentionId] = useState<string | null>(null);
  const [steeringInstruction, setSteeringInstruction] = useState('');

  const loadTask = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store', signal });
      const data = await response.json() as { ok?: boolean; task?: TaskDetails; error?: string };
      if (!response.ok || !data.ok || !data.task) throw new Error(data.error || 'Could not load the task');
      setTask(data.task);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError(loadError instanceof Error ? loadError.message : 'Could not load the task');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void loadTask(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadTask]);

  useEffect(() => subscribeLiveEvents(['tasks', 'attention'], () => { void loadTask(); }), [loadTask]);

  async function sendCommand(kind: Extract<TaskCommandKind, 'pause' | 'resume' | 'cancel' | 'retry' | 'steer'>) {
    if (!task || commandPending) return;
    if (kind === 'cancel') {
      const confirmed = await confirmDialog({
        title: `Cancel ${task.title}?`,
        message: 'Cancellation is terminal for this task and cannot be retried from this view.',
        confirmLabel: 'Cancel task',
        danger: true,
      });
      if (!confirmed) return;
    }
    setCommandPending(kind);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: kind,
          payload: kind === 'steer' ? { instruction: steeringInstruction.trim() } : {},
          idempotencyKey: `${kind}:${crypto.randomUUID()}`,
          expectedVersion: task.version,
        }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || `Could not ${kind} the task`);
      if (kind === 'steer') setSteeringInstruction('');
      await loadTask();
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : `Could not ${kind} the task`);
      await loadTask();
    } finally {
      setCommandPending(null);
    }
  }

  async function dispatchQueuedTask() {
    if (!task || dispatchPending) return;
    setDispatchPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/dispatch`, { method: 'POST' });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not dispatch the task');
      await loadTask();
    } catch (dispatchError) {
      setError(dispatchError instanceof Error ? dispatchError.message : 'Could not dispatch the task');
    } finally {
      setDispatchPending(false);
    }
  }

  async function evaluateEvidence() {
    if (!task || verifying) return;
    setVerifying(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/verify`, { method: 'POST' });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not evaluate the evidence');
      await loadTask();
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'Could not evaluate the evidence');
    } finally {
      setVerifying(false);
    }
  }

  async function resolveAttention(item: AttentionItem) {
    if (resolvingAttentionId) return;
    setResolvingAttentionId(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/attention/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not resolve the attention item');
      await loadTask();
    } catch (attentionError) {
      setError(attentionError instanceof Error ? attentionError.message : 'Could not resolve the attention item');
    } finally {
      setResolvingAttentionId(null);
    }
  }

  async function decideApproval(item: AttentionItem, approved: boolean) {
    if (!task || resolvingAttentionId) return;
    const approvalId = typeof item.action.approvalId === 'string' ? item.action.approvalId : '';
    if (!approvalId) return;
    setResolvingAttentionId(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: approved ? 'approve' : 'deny',
          payload: { approvalId },
          idempotencyKey: `task-detail:${item.id}:${approved ? 'approve' : 'deny'}`,
          expectedVersion: task.version,
        }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not apply the approval decision');
      await loadTask();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Could not apply the approval decision');
      await loadTask();
    } finally {
      setResolvingAttentionId(null);
    }
  }

  const back = () => onBack ? onBack() : router.push('/');

  if (loading && !task) {
    return (
      <section className="grok-card p-10 text-center text-sm text-dim" aria-busy="true">
        <Loader2 size={20} className="animate-spin mx-auto mb-3" aria-hidden="true" />
        Loading task…
      </section>
    );
  }

  if (!task) {
    return (
      <section className="space-y-4">
        <button type="button" className="grok-btn grok-btn-ghost" onClick={back}><ArrowLeft size={14} aria-hidden="true" /> Back to Dispatch</button>
        <div className="grok-card p-8 text-center">
          <XCircle size={28} className="mx-auto text-error mb-3" aria-hidden="true" />
          <h1 className="font-semibold">Task unavailable</h1>
          <p className="text-sm text-dim mt-1" role="alert">{error || 'This task could not be found.'}</p>
        </div>
      </section>
    );
  }

  const canCancel = CANCELLABLE_STATUSES.has(task.status);
  const canRetry = (task.status === 'failed' || task.status === 'lost') && task.retryCount < task.maxRetries;
  const canPause = task.status === 'running';
  const canResume = task.status === 'paused';
  const canSteer = ['running', 'paused', 'waiting_for_input', 'waiting_for_approval'].includes(task.status);
  const openAttention = task.attention.filter((item) => item.status === 'open');
  const linkedRoutineId = typeof task.metadata.routineId === 'string' ? task.metadata.routineId : '';

  return (
    <article className="task-detail-page space-y-5" aria-labelledby="task-title">
      <header>
        <button type="button" className="grok-btn grok-btn-ghost mb-3" onClick={back}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to Dispatch
        </button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <TaskStatusBadge status={task.status} />
              <span className="status-pill text-dim">{task.kind}</span>
              <span className="text-[11px] text-dim font-mono">{task.id}</span>
            </div>
            <h1 id="task-title" className="text-2xl font-semibold break-words">{task.title}</h1>
            {task.description && <p className="text-sm text-muted mt-2 whitespace-pre-wrap max-w-4xl">{task.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="grok-btn grok-btn-ghost" onClick={() => void loadTask()}>
              <RefreshCw size={14} aria-hidden="true" /> Refresh
            </button>
            {task.kind === 'routine' && (
              <button
                type="button"
                className="grok-btn grok-btn-primary"
                onClick={() => router.push(linkedRoutineId
                  ? `/automations?routine=${encodeURIComponent(linkedRoutineId)}`
                  : `/automations?routineTask=${encodeURIComponent(task.id)}`)}
              >
                <CalendarClock size={14} aria-hidden="true" />
                {linkedRoutineId ? 'Open configured routine' : 'Configure routine'}
              </button>
            )}
            {canRetry && (
              <button type="button" className="grok-btn grok-btn-secondary" disabled={Boolean(commandPending)} onClick={() => void sendCommand('retry')}>
                {commandPending === 'retry' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
                Retry ({task.retryCount}/{task.maxRetries})
              </button>
            )}
            {task.status === 'queued' && task.kind !== 'routine' && (
              <button type="button" className="grok-btn grok-btn-primary" disabled={dispatchPending} onClick={() => void dispatchQueuedTask()}>
                {dispatchPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                Dispatch task
              </button>
            )}
            {canPause && (
              <button type="button" className="grok-btn grok-btn-secondary" disabled={Boolean(commandPending)} onClick={() => void sendCommand('pause')}>
                {commandPending === 'pause' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                Pause
              </button>
            )}
            {canResume && (
              <button type="button" className="grok-btn grok-btn-primary" disabled={Boolean(commandPending)} onClick={() => void sendCommand('resume')}>
                {commandPending === 'resume' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                Resume
              </button>
            )}
            {canCancel && (
              <button type="button" className="grok-btn grok-btn-danger" disabled={Boolean(commandPending)} onClick={() => void sendCommand('cancel')}>
                {commandPending === 'cancel' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
                Cancel task
              </button>
            )}
          </div>
        </div>
      </header>

      {error && <div className="grok-card p-3 text-sm text-error" role="alert">{error}</div>}

      {canSteer && (
        <form
          className="grok-card p-4 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (steeringInstruction.trim()) void sendCommand('steer');
          }}
        >
          <label className="text-xs flex-1">
            Append an instruction
            <textarea
              className="grok-input w-full min-h-16 mt-1 resize-y"
              value={steeringInstruction}
              maxLength={4_000}
              onChange={(event) => setSteeringInstruction(event.target.value)}
              placeholder="Clarify the outcome or redirect the active worker without starting over."
            />
          </label>
          <button type="submit" className="grok-btn grok-btn-secondary" disabled={!steeringInstruction.trim() || Boolean(commandPending)}>
            {commandPending === 'steer' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
            Steer task
          </button>
        </form>
      )}

      <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]" aria-label="Task status">
        <div className="grok-card p-5 space-y-4">
          <ProgressBar progress={task.progress} />
          <dl className="grid gap-4 sm:grid-cols-2 text-sm">
            <div><dt className="text-xs text-dim">Current step</dt><dd className="mt-1">{task.currentStep || 'No active step reported'}</dd></div>
            <div><dt className="text-xs text-dim">Next action</dt><dd className="mt-1">{task.nextAction || 'No next action reported'}</dd></div>
            <div><dt className="text-xs text-dim">Started</dt><dd className="mt-1">{formatDate(task.startedAt)}</dd></div>
            <div><dt className="text-xs text-dim">Last update</dt><dd className="mt-1">{formatDate(task.updatedAt)}</dd></div>
          </dl>
        </div>
        <div className="grok-card p-5">
          <h2 className="text-sm font-semibold mb-3">Provenance</h2>
          <dl className="space-y-3 text-xs">
            <div><dt className="text-dim">Origin</dt><dd className="mt-0.5">{task.originType}{task.originId ? ` · ${task.originId}` : ''}</dd></div>
            <div><dt className="text-dim">Run</dt><dd className="mt-0.5 font-mono break-all">{task.runId || 'Not assigned'}</dd></div>
            <div><dt className="text-dim">Created</dt><dd className="mt-0.5">{formatDate(task.createdAt)}</dd></div>
            <div><dt className="text-dim">Revision</dt><dd className="mt-0.5 font-mono">{task.version}</dd></div>
          </dl>
        </div>
      </section>

      {openAttention.length > 0 && (
        <section className="grok-card p-5" aria-labelledby="task-attention-heading">
          <h2 id="task-attention-heading" className="text-base font-semibold mb-3">Needs attention</h2>
          <ul className="space-y-3">
            {openAttention.map((item) => (
              <li key={item.id} className="p-3 rounded-md border border-default flex flex-wrap items-start gap-3">
                <AlertCircle size={16} className={item.severity === 'critical' ? 'text-error' : 'text-warning'} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{item.title}</div>
                  <p className="text-xs text-muted mt-1 whitespace-pre-wrap">{item.body}</p>
                </div>
                {item.kind === 'approval' && typeof item.action.approvalId === 'string' ? (
                  <span className="flex gap-1">
                    <button type="button" className="grok-btn grok-btn-primary" disabled={Boolean(resolvingAttentionId)} onClick={() => void decideApproval(item, true)}>
                      {resolvingAttentionId === item.id ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} Approve exact action
                    </button>
                    <button type="button" className="grok-btn grok-btn-danger" disabled={Boolean(resolvingAttentionId)} onClick={() => void decideApproval(item, false)}><XCircle size={13} /> Deny</button>
                  </span>
                ) : (
                  <button type="button" className="grok-btn grok-btn-secondary" disabled={Boolean(resolvingAttentionId)} onClick={() => void resolveAttention(item)}>
                    {resolvingAttentionId === item.id ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                    Resolve
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.plan.length > 0 && (
        <section className="grok-card p-5" aria-labelledby="task-plan-heading">
          <h2 id="task-plan-heading" className="text-base font-semibold mb-3">Plan</h2>
          <ol className="space-y-2">
            {task.plan.map((step, index) => (
              <li key={step.id} className="flex items-center gap-3 text-sm">
                {step.status === 'completed' ? <CheckCircle2 size={15} className="text-success shrink-0" aria-hidden="true" /> : <CircleDashed size={15} className="text-dim shrink-0" aria-hidden="true" />}
                <span className="text-dim tabular-nums">{index + 1}.</span>
                <span className={step.status === 'completed' ? 'text-muted' : ''}>{step.title}</span>
                <span className="status-pill text-dim ml-auto">{step.status.replaceAll('_', ' ')}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {task.contract && (
        <section className="grok-card p-5" aria-labelledby="completion-contract-heading">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 id="completion-contract-heading" className="text-base font-semibold">Completion contract</h2>
              <div className="mt-1"><EvaluationSummary completion={task.completion} /></div>
            </div>
            <button type="button" className="grok-btn grok-btn-secondary" disabled={verifying} onClick={() => void evaluateEvidence()}>
              {verifying ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
              Evaluate recorded evidence
            </button>
          </div>
          <div className="text-sm mb-4"><span className="text-dim">Outcome:</span> {task.contract.outcome}</div>
          {task.contract.constraints.length > 0 && (
            <div className="mb-4"><h3 className="text-xs font-medium mb-2">Constraints</h3><ul className="list-disc pl-5 text-sm text-muted space-y-1">{task.contract.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul></div>
          )}
          {task.contract.requiredArtifacts.length > 0 && (
            <div className="mb-4"><h3 className="text-xs font-medium mb-2">Required artifacts</h3><ul className="space-y-1 text-xs font-mono text-muted">{task.contract.requiredArtifacts.map((artifact) => <li key={artifact}>{artifact}</li>)}</ul></div>
          )}
          <div className="space-y-2">
            {task.contract.requirements.map((requirement) => {
              const evaluation = task.completion?.requirements.find((item) => item.requirementId === requirement.id);
              return (
                <div key={requirement.id} className="border border-default rounded-md p-3 flex items-start gap-3">
                  <FileCheck2 size={15} className={`shrink-0 mt-0.5 ${evaluation ? evaluationTone(evaluation.status) : 'text-dim'}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{requirement.label}</div>
                    {requirement.description && <p className="text-xs text-muted mt-1">{requirement.description}</p>}
                    {evaluation?.detail && <p className="text-xs text-dim mt-1">{evaluation.detail}</p>}
                  </div>
                  <span className={`status-pill ${evaluation ? evaluationTone(evaluation.status) : 'text-dim'}`}>{evaluation?.status || 'not evaluated'}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="grok-card p-5" aria-labelledby="evidence-heading">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 id="evidence-heading" className="text-base font-semibold">Evidence ledger</h2>
          <span className="text-xs text-dim">{task.evidence.length} record{task.evidence.length === 1 ? '' : 's'}</span>
        </div>
        {task.evidence.length === 0 ? (
          <p className="text-sm text-dim">No evidence has been recorded for this task.</p>
        ) : (
          <ul className="space-y-3">
            {task.evidence.map((evidence) => (
              <li key={evidence.id} className="border border-default rounded-md p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`status-pill ${evidenceTone(evidence.status)}`}>{evidence.status}</span>
                  <span className="status-pill text-dim">{evidence.kind}</span>
                  {evidence.scope && <span className="status-pill text-dim">scope: {evidence.scope}</span>}
                  <span className="text-[11px] text-dim ml-auto">{formatDate(evidence.recordedAt)}</span>
                </div>
                <div className="text-sm font-medium mt-2">{evidence.label}</div>
                <p className="text-xs text-muted mt-1 whitespace-pre-wrap">{evidence.summary}</p>
                {evidence.command && <pre className="text-[11px] font-mono text-dim mt-2 overflow-x-auto">{evidence.command}{evidence.exitCode != null ? `\nexit ${evidence.exitCode}` : ''}</pre>}
                <EvidenceUri uri={evidence.uri} />
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 pt-4 border-t border-default"><EvidenceRecorder task={task} onRecorded={() => void loadTask()} /></div>
      </section>

      {task.workspaceRoots.length > 0 && (
        <section className="grok-card p-5" aria-labelledby="workspace-roots-heading">
          <h2 id="workspace-roots-heading" className="text-base font-semibold mb-3">Workspace scope</h2>
          <ul className="space-y-2">
            {task.workspaceRoots.map((root) => (
              <li key={root.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono break-all">{root.path}</span>
                <span className="status-pill text-dim">{root.permission}</span>
                {root.gitRef && <span className="status-pill text-dim">{root.gitRef}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(task.result || task.error) && (
        <section className="grok-card p-5" aria-labelledby="task-output-heading">
          <h2 id="task-output-heading" className="text-base font-semibold mb-3">{task.error ? 'Failure' : 'Result'}</h2>
          <pre className={`text-sm whitespace-pre-wrap break-words max-h-[32rem] overflow-auto ${task.error ? 'text-error' : 'text-muted'}`}>{task.error || task.result}</pre>
        </section>
      )}

      <HarnessGrantPanel task={task} />
      <TaskTeamPanel task={task} />
      <CheckpointPanel taskId={task.id} onRestored={() => void loadTask()} />
      <ArtifactStudioPanel task={task} onEvidenceChanged={() => void loadTask()} />

      {task.children.length > 0 && (
        <section className="grok-card overflow-hidden" aria-labelledby="child-tasks-heading">
          <h2 id="child-tasks-heading" className="text-base font-semibold p-5 pb-3">Child tasks</h2>
          <div className="divide-y divide-default">
            {task.children.map((child: TaskRecord) => (
              <button key={child.id} type="button" className="w-full p-4 text-left flex items-center gap-3 hover:bg-[var(--bg-hover)]" onClick={() => router.push(`/tasks/${encodeURIComponent(child.id)}`)}>
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium truncate">{child.title}</span><span className="block text-[11px] text-dim mt-0.5">{child.kind}</span></span>
                <TaskStatusBadge status={child.status} />
                <ChevronRight size={14} className="text-dim" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

export default TaskDetailPage;
