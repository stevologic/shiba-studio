'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2, X } from 'lucide-react';
import type { Agent } from '@/lib/types';
import type {
  CreateRoutineInput,
  RoutineCondition,
  RoutineDefinition,
  RoutineStep,
  RoutineTrigger,
  RoutineTriggerType,
} from '@/lib/routine-types';

interface RoutineEditorProps {
  agents: Agent[];
  initial: CreateRoutineInput;
  title: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: CreateRoutineInput) => Promise<void>;
}

const TRIGGER_LABELS: Record<RoutineTriggerType, string> = {
  schedule: 'Schedule',
  one_time: 'One time',
  webhook: 'Signed webhook',
  manual: 'Manual',
  health: 'Health check',
  filesystem: 'Filesystem change',
  integration_event: 'Integration event',
};

const TRIGGER_TYPES = Object.keys(TRIGGER_LABELS) as RoutineTriggerType[];

function triggerId(): string {
  return `trigger-${crypto.randomUUID().slice(0, 8)}`;
}

function newTrigger(type: RoutineTriggerType): RoutineTrigger {
  const base = { id: triggerId(), enabled: true };
  if (type === 'schedule') return { ...base, type, cron: '0 9 * * 1-5' };
  if (type === 'one_time') return { ...base, type, at: new Date(Date.now() + 60 * 60_000).toISOString() };
  if (type === 'webhook') return { ...base, type, secret: '' };
  if (type === 'health') {
    const origin = typeof window === 'undefined' ? 'http://127.0.0.1:3000' : window.location.origin;
    return { ...base, type, intervalSeconds: 60, timeoutMs: 10_000, url: `${origin}/api/health` };
  }
  if (type === 'filesystem') return { ...base, type, path: '', intervalSeconds: 30 };
  if (type === 'integration_event') return { ...base, type, integration: 'github', event: 'push' };
  return { ...base, type: 'manual' };
}

function toLocalDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromLocalDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function parseLooseValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

function displayLooseValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}

function replaceAt<T>(items: T[], index: number, value: T): T[] {
  return items.map((item, current) => current === index ? value : item);
}

function moveAt<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const destination = index + direction;
  if (destination < 0 || destination >= items.length) return items;
  const next = [...items];
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}

function TriggerFields({
  trigger,
  inputPrefix,
  onChange,
}: {
  trigger: RoutineTrigger;
  inputPrefix: string;
  onChange: (trigger: RoutineTrigger) => void;
}) {
  if (trigger.type === 'manual') {
    return <p className="text-xs text-dim">Manual runs are started explicitly from this page or the API.</p>;
  }
  if (trigger.type === 'schedule') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs" htmlFor={`${inputPrefix}-cron`}>Cron expression
          <input id={`${inputPrefix}-cron`} className="grok-input font-mono text-xs mt-1 w-full" value={trigger.cron} onChange={(event) => onChange({ ...trigger, cron: event.target.value })} required />
        </label>
        <label className="text-xs" htmlFor={`${inputPrefix}-timezone`}>Timezone <span className="text-dim">(optional IANA name)</span>
          <input id={`${inputPrefix}-timezone`} className="grok-input text-xs mt-1 w-full" value={trigger.timezone || ''} onChange={(event) => onChange({ ...trigger, timezone: event.target.value || undefined })} placeholder="America/Phoenix" />
        </label>
      </div>
    );
  }
  if (trigger.type === 'one_time') {
    return (
      <label className="text-xs" htmlFor={`${inputPrefix}-at`}>Run at
        <input id={`${inputPrefix}-at`} type="datetime-local" className="grok-input text-xs mt-1 w-full sm:w-auto" value={toLocalDateTime(trigger.at)} onChange={(event) => onChange({ ...trigger, at: fromLocalDateTime(event.target.value) })} required />
      </label>
    );
  }
  if (trigger.type === 'webhook') {
    return (
      <div>
        <label className="text-xs" htmlFor={`${inputPrefix}-secret`}>HMAC secret
          <input id={`${inputPrefix}-secret`} type="password" className="grok-input text-xs mt-1 w-full" value={trigger.secret || ''} onChange={(event) => onChange({ ...trigger, secret: event.target.value })} minLength={trigger.secret === '••••••••' ? undefined : 16} required autoComplete="new-password" />
        </label>
        <p className="text-[11px] text-dim mt-1">Send timestamp, delivery id, and SHA-256 signature headers. Saved secrets remain encrypted and are never exported.</p>
      </div>
    );
  }
  if (trigger.type === 'health') {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs sm:col-span-2" htmlFor={`${inputPrefix}-url`}>URL <span className="text-dim">(URL or process ID is required)</span>
          <input id={`${inputPrefix}-url`} className="grok-input text-xs mt-1 w-full" value={trigger.url || ''} onChange={(event) => onChange({ ...trigger, url: event.target.value || undefined })} placeholder="http://127.0.0.1:3000/api/health" />
        </label>
        <label className="text-xs" htmlFor={`${inputPrefix}-pid`}>Process ID
          <input id={`${inputPrefix}-pid`} type="number" min={1} className="grok-input text-xs mt-1 w-full" value={trigger.processPid || ''} onChange={(event) => onChange({ ...trigger, processPid: event.target.value ? Number(event.target.value) : undefined })} />
        </label>
        <label className="text-xs" htmlFor={`${inputPrefix}-status`}>Expected HTTP status
          <input id={`${inputPrefix}-status`} type="number" min={100} max={599} className="grok-input text-xs mt-1 w-full" value={trigger.expectedStatus || ''} onChange={(event) => onChange({ ...trigger, expectedStatus: event.target.value ? Number(event.target.value) : undefined })} placeholder="Any 2xx" />
        </label>
        <label className="text-xs" htmlFor={`${inputPrefix}-interval`}>Check every (seconds)
          <input id={`${inputPrefix}-interval`} type="number" min={5} className="grok-input text-xs mt-1 w-full" value={trigger.intervalSeconds} onChange={(event) => onChange({ ...trigger, intervalSeconds: Number(event.target.value) })} required />
        </label>
        <label className="text-xs" htmlFor={`${inputPrefix}-timeout`}>Probe timeout (ms)
          <input id={`${inputPrefix}-timeout`} type="number" min={250} className="grok-input text-xs mt-1 w-full" value={trigger.timeoutMs || 10_000} onChange={(event) => onChange({ ...trigger, timeoutMs: Number(event.target.value) })} required />
        </label>
      </div>
    );
  }
  if (trigger.type === 'filesystem') {
    return (
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <label className="text-xs" htmlFor={`${inputPrefix}-path`}>File or directory path
          <input id={`${inputPrefix}-path`} className="grok-input font-mono text-xs mt-1 w-full" value={trigger.path} onChange={(event) => onChange({ ...trigger, path: event.target.value })} required />
        </label>
        <label className="text-xs" htmlFor={`${inputPrefix}-interval`}>Check every (seconds)
          <input id={`${inputPrefix}-interval`} type="number" min={2} className="grok-input text-xs mt-1 w-full" value={trigger.intervalSeconds} onChange={(event) => onChange({ ...trigger, intervalSeconds: Number(event.target.value) })} required />
        </label>
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs" htmlFor={`${inputPrefix}-integration`}>Integration
        <input id={`${inputPrefix}-integration`} className="grok-input text-xs mt-1 w-full" value={trigger.integration} onChange={(event) => onChange({ ...trigger, integration: event.target.value })} placeholder="github, slack, discord, linear, jira" required />
      </label>
      <label className="text-xs" htmlFor={`${inputPrefix}-event`}>Event name
        <input id={`${inputPrefix}-event`} className="grok-input text-xs mt-1 w-full" value={trigger.event} onChange={(event) => onChange({ ...trigger, event: event.target.value })} placeholder="push, mention, issue.updated" required />
      </label>
    </div>
  );
}

export function emptyRoutineInput(agentId = '', prefill?: { name?: string; prompt?: string }): CreateRoutineInput {
  return {
    name: prefill?.name || '',
    description: '',
    enabled: true,
    agentId,
    prompt: prefill?.prompt || '',
    triggers: [newTrigger('manual')],
    conditions: [],
    parameters: {},
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, multiplier: 2, maxDelayMs: 60_000 },
    timeoutMs: 15 * 60_000,
    concurrencyKey: '',
    catchUpPolicy: 'run_once',
    circuitBreaker: { failureThreshold: 3, cooldownSeconds: 900 },
    steps: [],
  };
}

export function routineToInput(routine: RoutineDefinition): CreateRoutineInput {
  return {
    id: routine.id,
    name: routine.name,
    description: routine.description,
    enabled: routine.enabled,
    agentId: routine.agentId,
    prompt: routine.prompt,
    triggers: routine.triggers,
    conditions: routine.conditions,
    parameters: routine.parameters,
    retryPolicy: routine.retryPolicy,
    timeoutMs: routine.timeoutMs,
    concurrencyKey: routine.concurrencyKey,
    catchUpPolicy: routine.catchUpPolicy,
    circuitBreaker: routine.circuitBreaker,
    steps: routine.steps,
  };
}

export function RoutineEditor({ agents, initial, title, saving, onCancel, onSave }: RoutineEditorProps) {
  const prefix = useId().replaceAll(':', '');
  const dialogRef = useRef<HTMLFormElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef(onCancel);
  const savingRef = useRef(saving);
  const [draft, setDraft] = useState<CreateRoutineInput>(initial);
  const [parametersText, setParametersText] = useState(() => JSON.stringify(initial.parameters || {}, null, 2));
  const [addingTrigger, setAddingTrigger] = useState<RoutineTriggerType>('schedule');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cancelRef.current = onCancel;
    savingRef.current = saving;
  }, [onCancel, saving]);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, []);

  function updateTrigger(index: number, trigger: RoutineTrigger) {
    setDraft((current) => ({ ...current, triggers: replaceAt(current.triggers, index, trigger) }));
  }

  function updateCondition(index: number, condition: RoutineCondition) {
    setDraft((current) => ({ ...current, conditions: replaceAt(current.conditions || [], index, condition) }));
  }

  function updateStep(index: number, step: RoutineStep) {
    setDraft((current) => ({ ...current, steps: replaceAt(current.steps || [], index, step) }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const parameters = JSON.parse(parametersText) as unknown;
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Template parameters must be a JSON object.');
      if (!draft.triggers.length) throw new Error('Add at least one trigger.');
      await onSave({ ...draft, parameters: parameters as Record<string, unknown>, concurrencyKey: draft.concurrencyKey || `routine:${draft.id || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'work'}` });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not save the automation.');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-[80] p-3 sm:p-6 overflow-y-auto" role="presentation">
      <form ref={dialogRef} className="modal modal-pop w-full max-w-5xl mx-auto p-5 sm:p-6 space-y-6" onSubmit={submit} aria-labelledby={`${prefix}-title`} role="dialog" aria-modal="true">
        <header className="flex items-start justify-between gap-3">
          <div><h2 id={`${prefix}-title`} className="text-xl font-semibold">{title}</h2><p className="text-xs text-dim mt-1">The saved definition is durable, versioned, and executed through the universal task ledger.</p></div>
          <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={onCancel} disabled={saving} aria-label="Close automation editor"><X size={16} /></button>
        </header>

        <fieldset className="grok-card p-4 grid gap-4 sm:grid-cols-2">
          <legend className="px-2 text-sm font-semibold">Outcome and owner</legend>
          <label className="text-xs" htmlFor={`${prefix}-name`}>Name
            <input id={`${prefix}-name`} className="grok-input text-sm mt-1 w-full" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} maxLength={300} required autoFocus />
          </label>
          <label className="text-xs" htmlFor={`${prefix}-agent`}>Agent
            <select id={`${prefix}-agent`} className="grok-select text-sm mt-1 w-full" value={draft.agentId} onChange={(event) => setDraft((current) => ({ ...current, agentId: event.target.value }))} required>
              <option value="" disabled>Select an agent</option>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <label className="text-xs sm:col-span-2" htmlFor={`${prefix}-description`}>Description
            <input id={`${prefix}-description`} className="grok-input text-sm mt-1 w-full" value={draft.description || ''} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} maxLength={5_000} />
          </label>
          <label className="text-xs sm:col-span-2" htmlFor={`${prefix}-prompt`}>Instructions
            <textarea id={`${prefix}-prompt`} className="grok-input text-sm mt-1 w-full min-h-28 resize-y" value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} maxLength={20_000} required />
          </label>
          <label className="inline-flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /> Active</label>
        </fieldset>

        <fieldset className="grok-card p-4 space-y-3">
          <legend className="px-2 text-sm font-semibold">Triggers</legend>
          {draft.triggers.map((trigger, index) => (
            <div key={index} className="border border-default rounded-md p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs flex-1 min-w-40" htmlFor={`${prefix}-trigger-${index}-id`}>{TRIGGER_LABELS[trigger.type]} trigger ID
                  <input id={`${prefix}-trigger-${index}-id`} className="grok-input font-mono text-xs mt-1 w-full" value={trigger.id} onChange={(event) => updateTrigger(index, { ...trigger, id: event.target.value })} required />
                </label>
                <label className="inline-flex items-center gap-2 text-xs mt-5"><input type="checkbox" checked={trigger.enabled} onChange={(event) => updateTrigger(index, { ...trigger, enabled: event.target.checked })} /> Enabled</label>
                <button type="button" className="grok-btn grok-btn-ghost p-1.5 text-error mt-5" onClick={() => setDraft((current) => ({ ...current, triggers: current.triggers.filter((_, currentIndex) => currentIndex !== index) }))} aria-label={`Remove ${TRIGGER_LABELS[trigger.type]} trigger`}><Trash2 size={14} /></button>
              </div>
              <TriggerFields trigger={trigger} inputPrefix={`${prefix}-trigger-${index}`} onChange={(next) => updateTrigger(index, next)} />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <select className="grok-select text-xs" value={addingTrigger} onChange={(event) => setAddingTrigger(event.target.value as RoutineTriggerType)} aria-label="Trigger type to add">
              {TRIGGER_TYPES.map((type) => <option key={type} value={type}>{TRIGGER_LABELS[type]}</option>)}
            </select>
            <button type="button" className="grok-btn grok-btn-secondary" onClick={() => setDraft((current) => ({ ...current, triggers: [...current.triggers, newTrigger(addingTrigger)] }))}><Plus size={13} /> Add trigger</button>
          </div>
        </fieldset>

        <fieldset className="grok-card p-4 space-y-3">
          <legend className="px-2 text-sm font-semibold">Conditions and template parameters</legend>
          <p className="text-xs text-dim">Every condition must match before an event creates work. Use dot paths such as <span className="font-mono">pull_request.state</span>.</p>
          {(draft.conditions || []).map((condition, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_10rem_1fr_auto] items-end">
              <label className="text-xs" htmlFor={`${prefix}-condition-${index}-path`}>Payload path<input id={`${prefix}-condition-${index}-path`} className="grok-input text-xs mt-1 w-full" value={condition.path} onChange={(event) => updateCondition(index, { ...condition, path: event.target.value })} required /></label>
              <label className="text-xs" htmlFor={`${prefix}-condition-${index}-operator`}>Operator<select id={`${prefix}-condition-${index}-operator`} className="grok-select text-xs mt-1 w-full" value={condition.operator} onChange={(event) => updateCondition(index, { ...condition, operator: event.target.value as RoutineCondition['operator'] })}>{['exists', 'equals', 'not_equals', 'contains', 'matches'].map((operator) => <option key={operator}>{operator}</option>)}</select></label>
              <label className="text-xs" htmlFor={`${prefix}-condition-${index}-value`}>Value <span className="text-dim">(JSON or text)</span><input id={`${prefix}-condition-${index}-value`} className="grok-input text-xs mt-1 w-full" value={displayLooseValue(condition.value)} onChange={(event) => updateCondition(index, { ...condition, value: parseLooseValue(event.target.value) })} disabled={condition.operator === 'exists'} /></label>
              <button type="button" className="grok-btn grok-btn-ghost p-2 text-error" onClick={() => setDraft((current) => ({ ...current, conditions: (current.conditions || []).filter((_, currentIndex) => currentIndex !== index) }))} aria-label="Remove condition"><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="grok-btn grok-btn-secondary" onClick={() => setDraft((current) => ({ ...current, conditions: [...(current.conditions || []), { path: '', operator: 'exists' }] }))}><Plus size={13} /> Add condition</button>
          <label className="block text-xs" htmlFor={`${prefix}-parameters`}>Template parameters (JSON object)
            <textarea id={`${prefix}-parameters`} className="grok-input font-mono text-xs mt-1 w-full min-h-24 resize-y" value={parametersText} onChange={(event) => setParametersText(event.target.value)} spellCheck={false} />
          </label>
          <p className="text-[11px] text-dim">Reference parameters or event payload fields with <span className="font-mono">{'{{name}}'}</span>.</p>
        </fieldset>

        <fieldset className="grok-card p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="px-2 text-sm font-semibold">Reliability and concurrency</legend>
          <label className="text-xs" htmlFor={`${prefix}-attempts`}>Max attempts<input id={`${prefix}-attempts`} type="number" min={1} max={20} className="grok-input text-xs mt-1 w-full" value={draft.retryPolicy?.maxAttempts || 3} onChange={(event) => setDraft((current) => ({ ...current, retryPolicy: { ...current.retryPolicy, maxAttempts: Number(event.target.value) } }))} /></label>
          <label className="text-xs" htmlFor={`${prefix}-base-delay`}>Base backoff (ms)<input id={`${prefix}-base-delay`} type="number" min={100} className="grok-input text-xs mt-1 w-full" value={draft.retryPolicy?.baseDelayMs || 1_000} onChange={(event) => setDraft((current) => ({ ...current, retryPolicy: { ...current.retryPolicy, baseDelayMs: Number(event.target.value) } }))} /></label>
          <label className="text-xs" htmlFor={`${prefix}-multiplier`}>Backoff multiplier<input id={`${prefix}-multiplier`} type="number" min={1} max={10} step={0.1} className="grok-input text-xs mt-1 w-full" value={draft.retryPolicy?.multiplier || 2} onChange={(event) => setDraft((current) => ({ ...current, retryPolicy: { ...current.retryPolicy, multiplier: Number(event.target.value) } }))} /></label>
          <label className="text-xs" htmlFor={`${prefix}-max-delay`}>Max backoff (ms)<input id={`${prefix}-max-delay`} type="number" min={100} className="grok-input text-xs mt-1 w-full" value={draft.retryPolicy?.maxDelayMs || 60_000} onChange={(event) => setDraft((current) => ({ ...current, retryPolicy: { ...current.retryPolicy, maxDelayMs: Number(event.target.value) } }))} /></label>
          <label className="text-xs" htmlFor={`${prefix}-timeout`}>Automation timeout (seconds)<input id={`${prefix}-timeout`} type="number" min={1} className="grok-input text-xs mt-1 w-full" value={Math.round((draft.timeoutMs || 900_000) / 1_000)} onChange={(event) => setDraft((current) => ({ ...current, timeoutMs: Number(event.target.value) * 1_000 }))} /></label>
          <label className="text-xs lg:col-span-2" htmlFor={`${prefix}-concurrency`}>Concurrency key<input id={`${prefix}-concurrency`} className="grok-input font-mono text-xs mt-1 w-full" value={draft.concurrencyKey || ''} onChange={(event) => setDraft((current) => ({ ...current, concurrencyKey: event.target.value }))} placeholder="automation:daily-report or team:{{teamId}}" /></label>
          <label className="text-xs" htmlFor={`${prefix}-catch-up`}>Missed trigger policy<select id={`${prefix}-catch-up`} className="grok-select text-xs mt-1 w-full" value={draft.catchUpPolicy || 'run_once'} onChange={(event) => setDraft((current) => ({ ...current, catchUpPolicy: event.target.value as 'run_once' | 'skip' }))}><option value="run_once">Run once</option><option value="skip">Skip</option></select></label>
          <label className="text-xs" htmlFor={`${prefix}-threshold`}>Breaker failures<input id={`${prefix}-threshold`} type="number" min={1} max={100} className="grok-input text-xs mt-1 w-full" value={draft.circuitBreaker?.failureThreshold || 3} onChange={(event) => setDraft((current) => ({ ...current, circuitBreaker: { ...current.circuitBreaker, failureThreshold: Number(event.target.value) } }))} /></label>
          <label className="text-xs" htmlFor={`${prefix}-cooldown`}>Breaker cooldown (seconds)<input id={`${prefix}-cooldown`} type="number" min={5} className="grok-input text-xs mt-1 w-full" value={draft.circuitBreaker?.cooldownSeconds || 900} onChange={(event) => setDraft((current) => ({ ...current, circuitBreaker: { ...current.circuitBreaker, cooldownSeconds: Number(event.target.value) } }))} /></label>
        </fieldset>

        <fieldset className="grok-card p-4 space-y-3">
          <legend className="px-2 text-sm font-semibold">Dependent steps</legend>
          <p className="text-xs text-dim">Successful steps are checkpointed. A retry resumes at the failed step instead of repeating completed side effects.</p>
          {(draft.steps || []).map((step, index) => (
            <div key={index} className="border border-default rounded-md p-3 space-y-2">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1.5fr_8rem_1fr_auto] items-end">
                <label className="text-xs" htmlFor={`${prefix}-step-${index}-id`}>Step ID<input id={`${prefix}-step-${index}-id`} className="grok-input font-mono text-xs mt-1 w-full" value={step.id} onChange={(event) => updateStep(index, { ...step, id: event.target.value })} required /></label>
                <label className="text-xs" htmlFor={`${prefix}-step-${index}-name`}>Name<input id={`${prefix}-step-${index}-name`} className="grok-input text-xs mt-1 w-full" value={step.name} onChange={(event) => updateStep(index, { ...step, name: event.target.value })} required /></label>
                <label className="text-xs" htmlFor={`${prefix}-step-${index}-kind`}>Mode<select id={`${prefix}-step-${index}-kind`} className="grok-select text-xs mt-1 w-full" value={step.kind || 'work'} onChange={(event) => updateStep(index, { ...step, kind: event.target.value as 'work' | 'code' })}><option value="work">Work</option><option value="code">Code</option></select></label>
                <label className="text-xs" htmlFor={`${prefix}-step-${index}-depends`}>Depends on IDs<input id={`${prefix}-step-${index}-depends`} className="grok-input font-mono text-xs mt-1 w-full" value={(step.dependsOn || []).join(', ')} onChange={(event) => updateStep(index, { ...step, dependsOn: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></label>
                <div className="flex">
                  <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={() => setDraft((current) => ({ ...current, steps: moveAt(current.steps || [], index, -1) }))} disabled={index === 0} aria-label="Move step up"><ChevronUp size={13} /></button>
                  <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={() => setDraft((current) => ({ ...current, steps: moveAt(current.steps || [], index, 1) }))} disabled={index === (draft.steps || []).length - 1} aria-label="Move step down"><ChevronDown size={13} /></button>
                  <button type="button" className="grok-btn grok-btn-ghost p-1.5 text-error" onClick={() => setDraft((current) => ({ ...current, steps: (current.steps || []).filter((_, currentIndex) => currentIndex !== index) }))} aria-label="Remove step"><Trash2 size={13} /></button>
                </div>
              </div>
              <label className="text-xs block" htmlFor={`${prefix}-step-${index}-prompt`}>Step instructions<textarea id={`${prefix}-step-${index}-prompt`} className="grok-input text-xs mt-1 w-full min-h-20 resize-y" value={step.prompt} onChange={(event) => updateStep(index, { ...step, prompt: event.target.value })} required /></label>
            </div>
          ))}
          <button type="button" className="grok-btn grok-btn-secondary" onClick={() => setDraft((current) => ({ ...current, steps: [...(current.steps || []), { id: `step-${(current.steps || []).length + 1}`, name: `Step ${(current.steps || []).length + 1}`, prompt: '', kind: 'work', dependsOn: [] }] }))}><Plus size={13} /> Add step</button>
        </fieldset>

        {error && <div className="grok-card p-3 text-sm text-error" role="alert">{error}</div>}
        {agents.length === 0 && <div className="grok-card p-3 text-sm text-warning" role="alert">Create an agent before saving an automation.</div>}
        <footer className="flex flex-wrap justify-end gap-2 sticky bottom-0 bg-[var(--bg)] py-3 border-t border-default">
          <button type="button" className="grok-btn grok-btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
          <button type="submit" className="grok-btn grok-btn-primary" disabled={saving || agents.length === 0}>
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {saving ? 'Saving…' : 'Save automation'}
          </button>
        </footer>
      </form>
    </div>
  );
}

export default RoutineEditor;
