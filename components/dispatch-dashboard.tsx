'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Code2,
  Loader2,
  MessageCircle,
  RefreshCw,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { subscribeLiveEvents } from '@/lib/live-events';
import type { CreateTaskInput, TaskKind, TaskRecord, TaskWorkspaceRoot } from '@/lib/task-types';

type DispatchMode = 'quick' | 'work' | 'code' | 'routine';
type ModeChoice = 'auto' | DispatchMode;

interface DispatchRecommendation {
  recommendedMode: DispatchMode;
  reason: string;
  confidence: number;
  recommendationVersion: 'v1';
  signals: string[];
}

interface DispatchDashboardProps {
  initialWorkspacePath?: string;
  /** Shell-compatible alias for the currently configured workspace. */
  defaultWorkspace?: string;
}

const MODE_OPTIONS: Array<{
  value: ModeChoice;
  label: string;
  description: string;
  icon: typeof Sparkles;
}> = [
  { value: 'auto', label: 'Auto', description: 'Let Shiba choose from the outcome.', icon: Sparkles },
  { value: 'quick', label: 'Quick', description: 'A focused conversational task.', icon: MessageCircle },
  { value: 'work', label: 'Work', description: 'Research, analysis, or a deliverable.', icon: Workflow },
  { value: 'code', label: 'Code', description: 'Repository-aware implementation.', icon: Code2 },
  { value: 'routine', label: 'Routine', description: 'A draft to configure with a trigger.', icon: Clock3 },
];

const KIND_BY_MODE: Record<DispatchMode, TaskKind> = {
  quick: 'chat',
  work: 'work',
  code: 'code',
  routine: 'routine',
};

function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function parseWorkspaceRoots(value: string): TaskWorkspaceRoot[] {
  return lines(value).slice(0, 20).map((entry, index) => {
    const readOnly = /^(read|ro):/i.test(entry);
    const rootPath = entry.replace(/^(read|ro|write|rw):\s*/i, '').trim();
    return {
      id: `workspace-${index + 1}`,
      path: rootPath,
      permission: readOnly ? 'read' as const : 'write' as const,
      label: `${readOnly ? 'Read-only' : 'Writable'} workspace ${index + 1}`,
    };
  }).filter((root) => Boolean(root.path));
}

function titleFromOutcome(outcome: string): string {
  const firstLine = outcome.split('\n').find((line) => line.trim())?.trim() || 'Untitled task';
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}…`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function modeLabel(mode: DispatchMode): string {
  return MODE_OPTIONS.find((option) => option.value === mode)?.label || mode;
}

function StatusPill({ status }: { status: TaskRecord['status'] }) {
  const tone = status === 'succeeded'
    ? 'text-success'
    : status === 'failed' || status === 'lost'
      ? 'text-error'
      : status === 'blocked' || status.startsWith('waiting_')
        ? 'text-warning'
        : 'text-muted';
  return <span className={`status-pill ${tone}`}>{status.replaceAll('_', ' ')}</span>;
}

export function DispatchDashboard({ initialWorkspacePath, defaultWorkspace = '' }: DispatchDashboardProps) {
  const router = useRouter();
  const modeLegendId = useId();
  const outcomeId = useId();
  const workspaceId = useId();
  const constraintsId = useId();
  const artifactsId = useId();
  const requirementsId = useId();
  const [outcome, setOutcome] = useState('');
  const [mode, setMode] = useState<ModeChoice>('auto');
  const [workspaceRootsText, setWorkspaceRootsText] = useState(initialWorkspacePath ?? defaultWorkspace);
  const [includeContract, setIncludeContract] = useState(false);
  const [constraints, setConstraints] = useState('');
  const [requiredArtifacts, setRequiredArtifacts] = useState('');
  const [requirements, setRequirements] = useState('');
  const [recommendation, setRecommendation] = useState<DispatchRecommendation | null>(null);
  const [recommendationPending, setRecommendationPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentTasks, setRecentTasks] = useState<TaskRecord[] | null>(null);

  const loadRecentTasks = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/tasks?limit=8', { cache: 'no-store', signal });
      const data = await response.json() as { ok?: boolean; tasks?: TaskRecord[]; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load recent tasks');
      setRecentTasks(data.tasks || []);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setRecentTasks([]);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void loadRecentTasks(controller.signal); }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadRecentTasks]);

  useEffect(() => subscribeLiveEvents(['tasks'], () => { void loadRecentTasks(); }), [loadRecentTasks]);

  useEffect(() => {
    const trimmed = outcome.trim();
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setRecommendationPending(true);
      try {
        const response = await fetch('/api/tasks/recommend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome: trimmed, hasWorkspace: parseWorkspaceRoots(workspaceRootsText).length > 0 }),
          signal: controller.signal,
        });
        const data = await response.json() as {
          ok?: boolean;
          recommendation?: DispatchRecommendation;
          error?: string;
        };
        if (!response.ok || !data.ok || !data.recommendation) {
          throw new Error(data.error || 'Could not recommend a task mode');
        }
        setRecommendation(data.recommendation);
      } catch (recommendationError) {
        if (recommendationError instanceof DOMException && recommendationError.name === 'AbortError') return;
        setRecommendation(null);
      } finally {
        if (!controller.signal.aborted) setRecommendationPending(false);
      }
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [outcome, workspaceRootsText]);

  const effectiveMode = mode === 'auto' ? recommendation?.recommendedMode : mode;
  const actionLabel = effectiveMode === 'routine' ? 'Create routine draft' : 'Dispatch task';
  const contractRequirements = useMemo(() => lines(requirements), [requirements]);

  async function getCurrentRecommendation(): Promise<DispatchRecommendation> {
    if (recommendation) return recommendation;
    const response = await fetch('/api/tasks/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: outcome.trim(), hasWorkspace: parseWorkspaceRoots(workspaceRootsText).length > 0 }),
    });
    const data = await response.json() as {
      ok?: boolean;
      recommendation?: DispatchRecommendation;
      error?: string;
    };
    if (!response.ok || !data.ok || !data.recommendation) {
      throw new Error(data.error || 'Could not recommend a task mode');
    }
    setRecommendation(data.recommendation);
    return data.recommendation;
  }

  async function submitTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedOutcome = outcome.trim();
    if (!trimmedOutcome || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const currentRecommendation = await getCurrentRecommendation();
      const selectedMode = mode === 'auto' ? currentRecommendation.recommendedMode : mode;
      const input: CreateTaskInput = {
        kind: KIND_BY_MODE[selectedMode],
        title: titleFromOutcome(trimmedOutcome),
        description: trimmedOutcome,
        status: 'queued',
        originType: 'manual',
        workspaceRoots: parseWorkspaceRoots(workspaceRootsText),
        contract: includeContract
          ? {
              outcome: trimmedOutcome,
              constraints: lines(constraints),
              requiredArtifacts: lines(requiredArtifacts),
              requirements: contractRequirements.map((label, index) => ({
                id: `requirement-${index + 1}`,
                label,
                required: true,
              })),
            }
          : undefined,
        metadata: {
          dispatch: {
            selectedMode: mode,
            effectiveMode: selectedMode,
            overridden: mode !== 'auto' && mode !== currentRecommendation.recommendedMode,
            recommendation: currentRecommendation,
          },
        },
      };
      const createResponse = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const createData = await createResponse.json() as { ok?: boolean; task?: TaskRecord; error?: string };
      if (!createResponse.ok || !createData.ok || !createData.task) {
        throw new Error(createData.error || 'Could not create the task');
      }
      if (selectedMode !== 'routine') {
        const dispatchResponse = await fetch(`/api/tasks/${encodeURIComponent(createData.task.id)}/dispatch`, {
          method: 'POST',
        });
        const dispatchData = await dispatchResponse.json() as { ok?: boolean; error?: string };
        if (!dispatchResponse.ok || !dispatchData.ok) {
          throw new Error(dispatchData.error || 'The task was created but could not be dispatched');
        }
      }
      router.push(`/tasks/${encodeURIComponent(createData.task.id)}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not dispatch the task');
      setSubmitting(false);
    }
  }

  return (
    <section className="dispatch-dashboard space-y-6" aria-labelledby="dispatch-heading">
      <header>
        <div className="text-[11px] uppercase tracking-[0.16em] text-dim mb-1">Task control plane</div>
        <h1 id="dispatch-heading" className="text-2xl font-semibold">Dispatch</h1>
        <p className="text-sm text-muted mt-1 max-w-2xl">
          Describe the outcome. Shiba will recommend the right execution mode, and you can always override it.
        </p>
      </header>

      <form className="grok-card p-5 space-y-5" onSubmit={submitTask}>
        <div>
          <label htmlFor={outcomeId} className="block text-sm font-medium mb-2">What outcome do you want?</label>
          <textarea
            id={outcomeId}
            className="grok-input w-full min-h-32 resize-y"
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value);
              setRecommendation(null);
              setRecommendationPending(false);
            }}
            placeholder="For example: Audit the checkout flow, fix the bugs, and verify it end to end."
            required
            maxLength={20_000}
          />
        </div>

        <fieldset aria-describedby={modeLegendId}>
          <legend className="text-sm font-medium mb-1">Execution mode</legend>
          <p id={modeLegendId} className="text-xs text-dim mb-3">Auto is recommended; every decision is recorded on the task.</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {MODE_OPTIONS.map((option) => {
              const Icon = option.icon;
              const selected = mode === option.value;
              return (
                <label
                  key={option.value}
                  className="grok-card grok-card-interactive p-3 cursor-pointer flex gap-3"
                  style={selected ? { borderColor: 'var(--accent)' } : undefined}
                >
                  <input
                    type="radio"
                    name="dispatch-mode"
                    value={option.value}
                    checked={selected}
                    onChange={() => setMode(option.value)}
                    className="mt-1 shrink-0 accent-[var(--accent)]"
                  />
                  <Icon size={17} className="shrink-0 mt-0.5 text-muted" aria-hidden="true" />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-[11px] text-dim leading-snug mt-0.5">{option.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="min-h-12 text-sm" aria-live="polite" aria-atomic="true">
          {recommendationPending ? (
            <div className="flex items-center gap-2 text-dim"><Loader2 size={14} className="animate-spin" /> Choosing a mode…</div>
          ) : recommendation ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="status-pill text-muted">Auto recommends {modeLabel(recommendation.recommendedMode)}</span>
              <span className="text-dim">{recommendation.reason}</span>
              <span className="text-[11px] text-dim">{Math.round(recommendation.confidence * 100)}% confidence</span>
            </div>
          ) : outcome.trim() ? (
            <span className="text-dim">Mode recommendation is temporarily unavailable. It will be retried when you dispatch.</span>
          ) : null}
        </div>

        <div>
          <label htmlFor={workspaceId} className="block text-sm font-medium mb-2">
            Workspace roots <span className="text-dim font-normal">(optional, one per line)</span>
          </label>
          <textarea
            id={workspaceId}
            className="grok-input w-full min-h-20 font-mono text-xs resize-y"
            value={workspaceRootsText}
            onChange={(event) => {
              setWorkspaceRootsText(event.target.value);
              setRecommendation(null);
              setRecommendationPending(false);
            }}
            placeholder={'C:\\path\\to\\primary\nread:C:\\path\\to\\reference-repo'}
            maxLength={20_000}
          />
          <p className="text-[11px] text-dim mt-1.5">Prefix a root with <span className="font-mono">read:</span> for read-only access. Every other root is writable and recorded separately.</p>
        </div>

        <div className="border-t border-default pt-4">
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={includeContract}
              onChange={(event) => setIncludeContract(event.target.checked)}
            />
            Define completion evidence
          </label>
          <p className="text-[11px] text-dim mt-1">A contract prevents the task from being marked complete without recorded proof.</p>
          {includeContract && (
            <div className="grid gap-4 mt-4 lg:grid-cols-3">
              <div>
                <label htmlFor={constraintsId} className="block text-xs font-medium mb-1.5">Constraints</label>
                <textarea id={constraintsId} className="grok-input w-full min-h-24 resize-y text-xs" value={constraints} onChange={(event) => setConstraints(event.target.value)} placeholder="One constraint per line" />
              </div>
              <div>
                <label htmlFor={artifactsId} className="block text-xs font-medium mb-1.5">Required artifacts</label>
                <textarea id={artifactsId} className="grok-input w-full min-h-24 resize-y text-xs" value={requiredArtifacts} onChange={(event) => setRequiredArtifacts(event.target.value)} placeholder="One artifact path or URI per line" />
              </div>
              <div>
                <label htmlFor={requirementsId} className="block text-xs font-medium mb-1.5">Evidence requirements</label>
                <textarea id={requirementsId} className="grok-input w-full min-h-24 resize-y text-xs" value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="For example: Typecheck passes" required={includeContract} />
              </div>
            </div>
          )}
        </div>

        {effectiveMode === 'routine' && (
          <div className="grok-card p-3 text-sm text-warning" role="status">
            Routine mode creates a durable draft. It will not run until a trigger and schedule are configured.
          </div>
        )}
        {error && <div className="grok-card p-3 text-sm text-error" role="alert">{error}</div>}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-dim">
            {effectiveMode && effectiveMode !== 'routine' ? `${modeLabel(effectiveMode)} will start after creation.` : 'The task is saved durably before any execution starts.'}
          </span>
          <button type="submit" className="grok-btn grok-btn-primary" disabled={!outcome.trim() || submitting || (includeContract && contractRequirements.length === 0)}>
            {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
            {submitting ? 'Dispatching…' : actionLabel}
          </button>
        </div>
      </form>

      <section aria-labelledby="recent-tasks-heading">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 id="recent-tasks-heading" className="text-base font-semibold">Recent tasks</h2>
          <button type="button" className="grok-btn grok-btn-ghost" onClick={() => void loadRecentTasks()}>
            <RefreshCw size={13} aria-hidden="true" /> Refresh
          </button>
        </div>
        {recentTasks === null ? (
          <div className="grok-card p-6 text-sm text-dim" aria-live="polite">Loading recent tasks…</div>
        ) : recentTasks.length === 0 ? (
          <div className="grok-card p-8 text-center text-sm text-dim">Your dispatched tasks will appear here.</div>
        ) : (
          <div className="grok-card overflow-hidden divide-y divide-default">
            {recentTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className="w-full text-left p-4 flex items-center gap-3 hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                onClick={() => router.push(`/tasks/${encodeURIComponent(task.id)}`)}
              >
                {task.status === 'succeeded' ? <CheckCircle2 size={16} className="text-success shrink-0" aria-hidden="true" /> : <Workflow size={16} className="text-muted shrink-0" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate">{task.title}</span>
                  <span className="block text-[11px] text-dim mt-0.5">{task.kind} · updated {formatTime(task.updatedAt)}</span>
                </span>
                <StatusPill status={task.status} />
              </button>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

export default DispatchDashboard;
