'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { createClientId } from '@/lib/client-id';
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

const SCHEDULE_CHOICES = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Daily at 9:00 AM', cron: '0 9 * * *' },
  { label: 'Weekdays at 9:00 AM', cron: '0 9 * * 1-5' },
] as const;

function triggerId(): string {
  return `trigger-${createClientId().slice(0, 8)}`;
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

function hasConfiguredAdvancedOptions(input: CreateRoutineInput): boolean {
  const retry = input.retryPolicy;
  const breaker = input.circuitBreaker;
  const customConcurrency = Boolean(input.concurrencyKey && !input.concurrencyKey.startsWith('routine:'));
  return Boolean(
    input.conditions?.length
    || Object.keys(input.parameters || {}).length
    || input.steps?.length
    || customConcurrency
    || input.catchUpPolicy === 'skip'
    || input.timeoutMs !== 15 * 60_000
    || retry?.maxAttempts !== 3
    || retry?.baseDelayMs !== 1_000
    || retry?.multiplier !== 2
    || retry?.maxDelayMs !== 60_000
    || breaker?.failureThreshold !== 3
    || breaker?.cooldownSeconds !== 900
  );
}

function hasConfiguredParameters(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length);
  } catch {
    return value.trim() !== '{}';
  }
}

function triggerIsReady(trigger: RoutineTrigger): boolean {
  if (!trigger.id.trim()) return false;
  if (trigger.type === 'schedule') return Boolean(trigger.cron.trim());
  if (trigger.type === 'one_time') return !Number.isNaN(new Date(trigger.at).getTime());
  if (trigger.type === 'webhook') return Boolean(trigger.secret?.trim());
  if (trigger.type === 'health') {
    return Boolean((trigger.url?.trim() || trigger.processPid) && trigger.intervalSeconds >= 5 && (trigger.timeoutMs || 0) >= 250);
  }
  if (trigger.type === 'filesystem') return Boolean(trigger.path.trim() && trigger.intervalSeconds >= 2);
  if (trigger.type === 'integration_event') return Boolean(trigger.integration.trim() && trigger.event.trim());
  return true;
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

function ScheduleTriggerFields({
  trigger,
  inputPrefix,
  onChange,
}: {
  trigger: Extract<RoutineTrigger, { type: 'schedule' }>;
  inputPrefix: string;
  onChange: (trigger: RoutineTrigger) => void;
}) {
  const [customSchedule, setCustomSchedule] = useState(() => !SCHEDULE_CHOICES.some((choice) => choice.cron === trigger.cron));
  useEffect(() => {
    setCustomSchedule(!SCHEDULE_CHOICES.some((choice) => choice.cron === trigger.cron));
  }, [trigger.cron]);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block" htmlFor={`${inputPrefix}-schedule`}>
        <span className="grok-label">Schedule</span>
        <select id={`${inputPrefix}-schedule`} className="grok-select text-xs w-full" value={customSchedule ? 'custom' : trigger.cron} onChange={(event) => {
          if (event.target.value === 'custom') {
            setCustomSchedule(true);
            return;
          }
          setCustomSchedule(false);
          onChange({ ...trigger, cron: event.target.value });
        }}>
          {SCHEDULE_CHOICES.map((choice) => <option key={choice.cron} value={choice.cron}>{choice.label}</option>)}
          <option value="custom">Custom cron expression</option>
        </select>
      </label>
      <label className="block" htmlFor={`${inputPrefix}-timezone`}>
        <span className="grok-label">Timezone <span className="normal-case tracking-normal font-normal text-dim">(optional IANA name)</span></span>
        <input id={`${inputPrefix}-timezone`} className="grok-input text-xs w-full" value={trigger.timezone || ''} onChange={(event) => onChange({ ...trigger, timezone: event.target.value || undefined })} placeholder="America/Phoenix" />
      </label>
      {customSchedule && (
        <label className="block sm:col-span-2" htmlFor={`${inputPrefix}-cron`}>
          <span className="grok-label">Cron expression</span>
          <input id={`${inputPrefix}-cron`} className="grok-input font-mono text-xs w-full" value={trigger.cron} onChange={(event) => onChange({ ...trigger, cron: event.target.value })} required />
        </label>
      )}
    </div>
  );
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
    return <ScheduleTriggerFields trigger={trigger} inputPrefix={inputPrefix} onChange={onChange} />;
  }
  if (trigger.type === 'one_time') {
    return (
      <label className="block" htmlFor={`${inputPrefix}-at`}>
        <span className="grok-label">Run at</span>
        <input id={`${inputPrefix}-at`} type="datetime-local" className="grok-input text-xs w-full sm:w-auto" value={toLocalDateTime(trigger.at)} onChange={(event) => onChange({ ...trigger, at: fromLocalDateTime(event.target.value) })} required />
      </label>
    );
  }
  if (trigger.type === 'webhook') {
    return (
      <div>
        <label className="block" htmlFor={`${inputPrefix}-secret`}>
          <span className="grok-label">HMAC secret</span>
          <input id={`${inputPrefix}-secret`} type="password" className="grok-input text-xs w-full" value={trigger.secret || ''} onChange={(event) => onChange({ ...trigger, secret: event.target.value })} minLength={trigger.secret === '••••••••' ? undefined : 16} required autoComplete="new-password" />
        </label>
        <p className="text-[11px] text-dim mt-1">Send timestamp, delivery id, and SHA-256 signature headers. Saved secrets remain encrypted and are never exported.</p>
      </div>
    );
  }
  if (trigger.type === 'health') {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block sm:col-span-2" htmlFor={`${inputPrefix}-url`}>
          <span className="grok-label">URL <span className="normal-case tracking-normal font-normal text-dim">(or use a process ID)</span></span>
          <input id={`${inputPrefix}-url`} className="grok-input text-xs w-full" value={trigger.url || ''} onChange={(event) => onChange({ ...trigger, url: event.target.value || undefined })} placeholder="http://127.0.0.1:3000/api/health" />
        </label>
        <label className="block" htmlFor={`${inputPrefix}-pid`}>
          <span className="grok-label">Process ID</span>
          <input id={`${inputPrefix}-pid`} type="number" min={1} className="grok-input text-xs w-full" value={trigger.processPid || ''} onChange={(event) => onChange({ ...trigger, processPid: event.target.value ? Number(event.target.value) : undefined })} />
        </label>
        <label className="block" htmlFor={`${inputPrefix}-status`}>
          <span className="grok-label">Expected status</span>
          <input id={`${inputPrefix}-status`} type="number" min={100} max={599} className="grok-input text-xs w-full" value={trigger.expectedStatus || ''} onChange={(event) => onChange({ ...trigger, expectedStatus: event.target.value ? Number(event.target.value) : undefined })} placeholder="Any 2xx" />
        </label>
        <label className="block" htmlFor={`${inputPrefix}-interval`}>
          <span className="grok-label">Check every</span>
          <input id={`${inputPrefix}-interval`} type="number" min={5} className="grok-input text-xs w-full" value={trigger.intervalSeconds} onChange={(event) => onChange({ ...trigger, intervalSeconds: Number(event.target.value) })} required />
          <span className="block text-[10px] text-dim mt-1">Seconds</span>
        </label>
        <label className="block" htmlFor={`${inputPrefix}-timeout`}>
          <span className="grok-label">Probe timeout</span>
          <input id={`${inputPrefix}-timeout`} type="number" min={250} className="grok-input text-xs w-full" value={trigger.timeoutMs || 10_000} onChange={(event) => onChange({ ...trigger, timeoutMs: Number(event.target.value) })} required />
          <span className="block text-[10px] text-dim mt-1">Milliseconds</span>
        </label>
      </div>
    );
  }
  if (trigger.type === 'filesystem') {
    return (
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <label className="block" htmlFor={`${inputPrefix}-path`}>
          <span className="grok-label">File or directory path</span>
          <input id={`${inputPrefix}-path`} className="grok-input font-mono text-xs w-full" value={trigger.path} onChange={(event) => onChange({ ...trigger, path: event.target.value })} required />
        </label>
        <label className="block" htmlFor={`${inputPrefix}-interval`}>
          <span className="grok-label">Check every</span>
          <input id={`${inputPrefix}-interval`} type="number" min={2} className="grok-input text-xs w-full" value={trigger.intervalSeconds} onChange={(event) => onChange({ ...trigger, intervalSeconds: Number(event.target.value) })} required />
          <span className="block text-[10px] text-dim mt-1">Seconds</span>
        </label>
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block" htmlFor={`${inputPrefix}-integration`}>
        <span className="grok-label">Integration</span>
        <input id={`${inputPrefix}-integration`} className="grok-input text-xs w-full" value={trigger.integration} onChange={(event) => onChange({ ...trigger, integration: event.target.value })} placeholder="github, slack, discord, linear, jira" required />
      </label>
      <label className="block" htmlFor={`${inputPrefix}-event`}>
        <span className="grok-label">Event name</span>
        <input id={`${inputPrefix}-event`} className="grok-input text-xs w-full" value={trigger.event} onChange={(event) => onChange({ ...trigger, event: event.target.value })} placeholder="push, mention, issue.updated" required />
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
    triggers: [newTrigger('schedule')],
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
  const [advancedOpen, setAdvancedOpen] = useState(() => hasConfiguredAdvancedOptions(initial));
  const [error, setError] = useState<string | null>(null);

  let parametersValid = false;
  try {
    const parsed = JSON.parse(parametersText) as unknown;
    parametersValid = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    parametersValid = false;
  }
  const triggerIds = draft.triggers.map((trigger) => trigger.id.trim());
  const steps = draft.steps || [];
  const stepIds = steps.map((step) => step.id.trim());
  const retry = draft.retryPolicy;
  const breaker = draft.circuitBreaker;
  const formIsReady = Boolean(
    draft.name.trim()
    && draft.prompt.trim()
    && draft.agentId
    && agents.some((agent) => agent.id === draft.agentId)
    && draft.triggers.length
    && draft.triggers.every(triggerIsReady)
    && new Set(triggerIds).size === triggerIds.length
    && (draft.conditions || []).every((condition) => condition.path.trim())
    && steps.every((step) => step.id.trim() && step.name.trim() && step.prompt.trim())
    && new Set(stepIds).size === stepIds.length
    && parametersValid
    && (draft.timeoutMs || 0) > 0
    && (retry?.maxAttempts || 0) >= 1
    && (retry?.baseDelayMs || 0) >= 100
    && (retry?.multiplier || 0) >= 1
    && (retry?.maxDelayMs || 0) >= 100
    && (breaker?.failureThreshold || 0) >= 1
    && (breaker?.cooldownSeconds || 0) >= 5
  );
  const advancedConfigured = hasConfiguredAdvancedOptions({ ...draft, parameters: {} }) || hasConfiguredParameters(parametersText);

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
      if (!formIsReady) throw new Error('Complete the required automation fields before saving.');
      const parameters = JSON.parse(parametersText) as unknown;
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Template parameters must be a JSON object.');
      if (!draft.triggers.length) throw new Error('Add at least one trigger.');
      await onSave({ ...draft, parameters: parameters as Record<string, unknown>, concurrencyKey: draft.concurrencyKey || `routine:${draft.id || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'work'}` });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not save the automation.');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-[80] flex items-center justify-center p-2 sm:p-5" role="presentation">
      <form
        ref={dialogRef}
        className="modal modal-pop w-full max-w-4xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2.5rem)] flex flex-col overflow-hidden"
        onSubmit={submit}
        aria-labelledby={`${prefix}-title`}
        aria-describedby={`${prefix}-description-copy`}
        aria-busy={saving}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-start justify-between gap-3 border-b border-default bg-[var(--bg-card)] p-4 sm:p-5 shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <span className="confirm-dialog-icon mt-0.5" aria-hidden="true"><Workflow size={17} /></span>
            <div className="min-w-0">
              <h2 id={`${prefix}-title`} className="text-lg sm:text-xl font-semibold tracking-tight">{title}</h2>
              <p id={`${prefix}-description-copy`} className="text-xs text-dim mt-1 max-w-2xl">Set the outcome and timing first. Everything else can stay on its safe defaults.</p>
            </div>
          </div>
          <button type="button" className="grok-btn grok-btn-ghost p-1.5 shrink-0" onClick={onCancel} disabled={saving} aria-label="Close automation editor"><X size={16} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">

        <fieldset className="agent-form-section">
          <legend className="sr-only">Automation outcome and owner</legend>
          <div className="agent-form-section-head flex items-start justify-between gap-3">
            <div>
              <div className="agent-form-section-title"><Sparkles size={15} aria-hidden="true" /> Outcome</div>
              <div className="agent-form-section-sub">Give the work a clear name, owner, and definition of done.</div>
            </div>
            <label className={`status-pill inline-flex items-center gap-2 cursor-pointer ${draft.enabled !== false ? 'text-success' : 'text-dim'}`}>
              <input type="checkbox" checked={draft.enabled !== false} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
              {draft.enabled !== false ? 'Active' : 'Paused'}
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block" htmlFor={`${prefix}-name`}>
              <span className="grok-label">Name</span>
              <input id={`${prefix}-name`} className="grok-input text-sm" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} maxLength={300} placeholder="Weekly project pulse" required autoFocus />
            </label>
            <label className="block" htmlFor={`${prefix}-agent`}>
              <span className="grok-label">Agent</span>
              <select id={`${prefix}-agent`} className="grok-select text-sm w-full" value={draft.agentId} onChange={(event) => setDraft((current) => ({ ...current, agentId: event.target.value }))} required>
                <option value="" disabled>Select an agent</option>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            <label className="block sm:col-span-2" htmlFor={`${prefix}-prompt`}>
              <span className="grok-label">Instructions</span>
              <textarea id={`${prefix}-prompt`} className="grok-input text-sm w-full min-h-32 resize-y leading-relaxed" value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} maxLength={20_000} placeholder="Describe the outcome, useful context, and what a successful run should produce." required />
              <span className="block text-[11px] text-dim mt-1.5">These instructions are used for every run unless a workflow step overrides them.</span>
            </label>
            <label className="block sm:col-span-2" htmlFor={`${prefix}-description`}>
              <span className="grok-label">Description <span className="normal-case tracking-normal font-normal text-dim">(optional)</span></span>
              <input id={`${prefix}-description`} className="grok-input text-sm w-full" value={draft.description || ''} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} maxLength={5_000} placeholder="A short note shown in the Automations list" />
            </label>
          </div>
        </fieldset>

        <fieldset className="agent-form-section">
          <legend className="sr-only">Automation triggers</legend>
          <div className="agent-form-section-head">
            <div className="agent-form-section-title"><CalendarClock size={15} aria-hidden="true" /> Triggers</div>
            <div className="agent-form-section-sub">Choose when work starts. You can still run this automation manually at any time.</div>
          </div>
          <div className="space-y-3">
          {draft.triggers.map((trigger, index) => (
            <div key={`${trigger.type}-${index}`} className="border border-default rounded-md bg-[var(--bg-card)] p-3 sm:p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-default bg-[var(--bg-elev)] text-[11px] font-semibold text-muted" aria-hidden="true">{index + 1}</span>
                <div className="flex-1 min-w-40 text-sm font-medium">{TRIGGER_LABELS[trigger.type]}</div>
                <label className={`status-pill inline-flex items-center gap-2 cursor-pointer ${trigger.enabled ? 'text-success' : 'text-dim'}`}><input type="checkbox" checked={trigger.enabled} onChange={(event) => updateTrigger(index, { ...trigger, enabled: event.target.checked })} /> {trigger.enabled ? 'Enabled' : 'Off'}</label>
                <button type="button" className="grok-btn grok-btn-ghost p-1.5 text-error" onClick={() => setDraft((current) => ({ ...current, triggers: current.triggers.filter((_, currentIndex) => currentIndex !== index) }))} aria-label={`Remove ${TRIGGER_LABELS[trigger.type]} trigger`}><Trash2 size={14} /></button>
              </div>
              <TriggerFields trigger={trigger} inputPrefix={`${prefix}-trigger-${index}`} onChange={(next) => updateTrigger(index, next)} />
              <details className="text-xs text-dim border-t border-default pt-2">
                <summary className="cursor-pointer font-medium text-muted">Technical options</summary>
                <label className="block mt-3" htmlFor={`${prefix}-trigger-${index}-id`}>
                  <span className="grok-label">Stable trigger ID</span>
                  <input id={`${prefix}-trigger-${index}-id`} className="grok-input font-mono text-xs w-full" value={trigger.id} onChange={(event) => updateTrigger(index, { ...trigger, id: event.target.value })} required />
                </label>
              </details>
            </div>
          ))}
          <div className="rounded-md border border-dashed border-default bg-[var(--bg-elev)] p-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium">Add another way to start</div>
              <div className="text-[11px] text-dim mt-0.5">Combine schedules, events, webhooks, or health checks.</div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="sr-only" htmlFor={`${prefix}-trigger-type`}>Trigger type to add</label>
              <select id={`${prefix}-trigger-type`} className="grok-select text-xs w-full sm:w-auto" value={addingTrigger} onChange={(event) => setAddingTrigger(event.target.value as RoutineTriggerType)}>
                {TRIGGER_TYPES.map((type) => <option key={type} value={type}>{TRIGGER_LABELS[type]}</option>)}
              </select>
              <button type="button" className="grok-btn grok-btn-secondary whitespace-nowrap" onClick={() => setDraft((current) => ({ ...current, triggers: [...current.triggers, newTrigger(addingTrigger)] }))}><Plus size={13} /> Add trigger</button>
            </div>
          </div>
          </div>
        </fieldset>

        <details className="agent-form-section group" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
            <span className="flex items-start gap-2.5 min-w-0">
              <SlidersHorizontal size={15} className="text-muted mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">Advanced options</span>
                <span className="block text-xs text-dim mt-0.5">Filters, data, retries, concurrency, and multi-step workflows</span>
              </span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <span className={`status-pill ${advancedConfigured ? 'text-muted' : 'text-dim'}`}>{advancedConfigured ? 'Configured' : 'Using defaults'}</span>
              <ChevronDown size={15} className={`text-dim transition-transform ${advancedOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </span>
          </summary>
          <div className="mt-4 space-y-4 border-t border-default pt-4">
        <fieldset className="rounded-md border border-default bg-[var(--bg-card)] p-4 space-y-3">
          <legend className="px-2 text-sm font-semibold">Filters and data</legend>
          <p className="text-xs text-dim">Every condition must match before an event creates work. Use dot paths such as <span className="font-mono">pull_request.state</span>.</p>
          {(draft.conditions || []).map((condition, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_10rem_1fr_auto] items-end">
              <label className="block" htmlFor={`${prefix}-condition-${index}-path`}><span className="grok-label">Payload path</span><input id={`${prefix}-condition-${index}-path`} className="grok-input text-xs w-full" value={condition.path} onChange={(event) => updateCondition(index, { ...condition, path: event.target.value })} required /></label>
              <label className="block" htmlFor={`${prefix}-condition-${index}-operator`}><span className="grok-label">Operator</span><select id={`${prefix}-condition-${index}-operator`} className="grok-select text-xs w-full" value={condition.operator} onChange={(event) => updateCondition(index, { ...condition, operator: event.target.value as RoutineCondition['operator'] })}>{['exists', 'equals', 'not_equals', 'contains', 'matches'].map((operator) => <option key={operator}>{operator}</option>)}</select></label>
              <label className="block" htmlFor={`${prefix}-condition-${index}-value`}><span className="grok-label">Value <span className="normal-case tracking-normal font-normal text-dim">(JSON or text)</span></span><input id={`${prefix}-condition-${index}-value`} className="grok-input text-xs w-full" value={displayLooseValue(condition.value)} onChange={(event) => updateCondition(index, { ...condition, value: parseLooseValue(event.target.value) })} disabled={condition.operator === 'exists'} /></label>
              <button type="button" className="grok-btn grok-btn-ghost p-2 text-error" onClick={() => setDraft((current) => ({ ...current, conditions: (current.conditions || []).filter((_, currentIndex) => currentIndex !== index) }))} aria-label="Remove condition"><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="grok-btn grok-btn-secondary" onClick={() => setDraft((current) => ({ ...current, conditions: [...(current.conditions || []), { path: '', operator: 'exists' }] }))}><Plus size={13} /> Add condition</button>
          <label className="block" htmlFor={`${prefix}-parameters`}>
            <span className="grok-label">Template parameters <span className="normal-case tracking-normal font-normal text-dim">(JSON object)</span></span>
            <textarea id={`${prefix}-parameters`} className="grok-input font-mono text-xs w-full min-h-24 resize-y" value={parametersText} onChange={(event) => setParametersText(event.target.value)} spellCheck={false} aria-invalid={!parametersValid} />
          </label>
          <p className="text-[11px] text-dim">Reference parameters or event payload fields with <span className="font-mono">{'{{name}}'}</span>.</p>
        </fieldset>

        <fieldset className="rounded-md border border-default bg-[var(--bg-card)] p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="px-2 text-sm font-semibold">Reliability and concurrency</legend>
          <label className="block" htmlFor={`${prefix}-attempts`}><span className="grok-label">Max attempts</span><input id={`${prefix}-attempts`} type="number" min={1} max={20} className="grok-input text-xs w-full" value={draft.retryPolicy?.maxAttempts || 3} onChange={(event) => setDraft((current) => ({ ...current, retryPolicy: { ...current.retryPolicy, maxAttempts: Number(event.target.value) } }))} /></label>
          <label className="block" htmlFor={`${prefix}-base-delay`}><span className="grok-label">First retry delay</span><input id={`${prefix}-base-delay`} type="number" min={0.1} step="any" className="grok-input text-xs w-full" value={(draft.retryPolicy?.baseDelayMs || 1_000) / 1_000} onChange={(event) => setDraft((current) => ({ ...current, retryPolicy: { ...current.retryPolicy, baseDelayMs: Number(event.target.value) * 1_000 } }))} /><span className="block text-[10px] text-dim mt-1">Seconds</span></label>
          <label className="block" htmlFor={`${prefix}-multiplier`}><span className="grok-label">Backoff multiplier</span><input id={`${prefix}-multiplier`} type="number" min={1} max={10} step="any" className="grok-input text-xs w-full" value={draft.retryPolicy?.multiplier || 2} onChange={(event) => setDraft((current) => ({ ...current, retryPolicy: { ...current.retryPolicy, multiplier: Number(event.target.value) } }))} /></label>
          <label className="block" htmlFor={`${prefix}-max-delay`}><span className="grok-label">Longest retry delay</span><input id={`${prefix}-max-delay`} type="number" min={0.1} step="any" className="grok-input text-xs w-full" value={(draft.retryPolicy?.maxDelayMs || 60_000) / 1_000} onChange={(event) => setDraft((current) => ({ ...current, retryPolicy: { ...current.retryPolicy, maxDelayMs: Number(event.target.value) * 1_000 } }))} /><span className="block text-[10px] text-dim mt-1">Seconds</span></label>
          <label className="block" htmlFor={`${prefix}-timeout`}><span className="grok-label">Active-run timeout</span><input id={`${prefix}-timeout`} type="number" min={1} step="any" className="grok-input text-xs w-full" value={(draft.timeoutMs || 900_000) / 1_000} onChange={(event) => setDraft((current) => ({ ...current, timeoutMs: Number(event.target.value) * 1_000 }))} /><span className="block text-[10px] text-dim mt-1">Seconds</span></label>
          <label className="block lg:col-span-2" htmlFor={`${prefix}-concurrency`}><span className="grok-label">Concurrency key</span><input id={`${prefix}-concurrency`} className="grok-input font-mono text-xs w-full" value={draft.concurrencyKey || ''} onChange={(event) => setDraft((current) => ({ ...current, concurrencyKey: event.target.value }))} placeholder="automation:daily-report or team:{{teamId}}" /></label>
          <label className="block" htmlFor={`${prefix}-catch-up`}><span className="grok-label">Missed trigger policy</span><select id={`${prefix}-catch-up`} className="grok-select text-xs w-full" value={draft.catchUpPolicy || 'run_once'} onChange={(event) => setDraft((current) => ({ ...current, catchUpPolicy: event.target.value as 'run_once' | 'skip' }))}><option value="run_once">Run once</option><option value="skip">Skip</option></select></label>
          <label className="block" htmlFor={`${prefix}-threshold`}><span className="grok-label">Breaker failures</span><input id={`${prefix}-threshold`} type="number" min={1} max={100} className="grok-input text-xs w-full" value={draft.circuitBreaker?.failureThreshold || 3} onChange={(event) => setDraft((current) => ({ ...current, circuitBreaker: { ...current.circuitBreaker, failureThreshold: Number(event.target.value) } }))} /></label>
          <label className="block" htmlFor={`${prefix}-cooldown`}><span className="grok-label">Failure pause</span><input id={`${prefix}-cooldown`} type="number" min={5 / 60} step="any" className="grok-input text-xs w-full" value={(draft.circuitBreaker?.cooldownSeconds || 900) / 60} onChange={(event) => setDraft((current) => ({ ...current, circuitBreaker: { ...current.circuitBreaker, cooldownSeconds: Number(event.target.value) * 60 } }))} /><span className="block text-[10px] text-dim mt-1">Minutes</span></label>
          <p className="text-[11px] text-dim sm:col-span-2 lg:col-span-4">The active-run timeout pauses while a task waits for your input, approval, or a manual resume.</p>
        </fieldset>

        <fieldset className="rounded-md border border-default bg-[var(--bg-card)] p-4 space-y-3">
          <legend className="px-2 text-sm font-semibold">Workflow steps</legend>
          <p className="text-xs text-dim">Leave this empty to run the main instructions as one step. For multi-step work, successful steps are checkpointed so retries resume without repeating completed side effects.</p>
          {(draft.steps || []).map((step, index) => (
            <div key={index} className="border border-default rounded-md bg-[var(--bg-elev)] p-3 space-y-3">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1.5fr_8rem_1fr_auto] items-end">
                <label className="block" htmlFor={`${prefix}-step-${index}-id`}><span className="grok-label">Step ID</span><input id={`${prefix}-step-${index}-id`} className="grok-input font-mono text-xs w-full" value={step.id} onChange={(event) => updateStep(index, { ...step, id: event.target.value })} required /></label>
                <label className="block" htmlFor={`${prefix}-step-${index}-name`}><span className="grok-label">Name</span><input id={`${prefix}-step-${index}-name`} className="grok-input text-xs w-full" value={step.name} onChange={(event) => updateStep(index, { ...step, name: event.target.value })} required /></label>
                <label className="block" htmlFor={`${prefix}-step-${index}-kind`}><span className="grok-label">Mode</span><select id={`${prefix}-step-${index}-kind`} className="grok-select text-xs w-full" value={step.kind || 'work'} onChange={(event) => updateStep(index, { ...step, kind: event.target.value as 'work' | 'code' })}><option value="work">Work</option><option value="code">Code</option></select></label>
                <label className="block" htmlFor={`${prefix}-step-${index}-depends`}><span className="grok-label">Depends on IDs</span><input id={`${prefix}-step-${index}-depends`} className="grok-input font-mono text-xs w-full" value={(step.dependsOn || []).join(', ')} onChange={(event) => updateStep(index, { ...step, dependsOn: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></label>
                <div className="flex">
                  <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={() => setDraft((current) => ({ ...current, steps: moveAt(current.steps || [], index, -1) }))} disabled={index === 0} aria-label="Move step up"><ChevronUp size={13} /></button>
                  <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={() => setDraft((current) => ({ ...current, steps: moveAt(current.steps || [], index, 1) }))} disabled={index === (draft.steps || []).length - 1} aria-label="Move step down"><ChevronDown size={13} /></button>
                  <button type="button" className="grok-btn grok-btn-ghost p-1.5 text-error" onClick={() => setDraft((current) => ({ ...current, steps: (current.steps || []).filter((_, currentIndex) => currentIndex !== index) }))} aria-label="Remove step"><Trash2 size={13} /></button>
                </div>
              </div>
              <label className="block" htmlFor={`${prefix}-step-${index}-prompt`}><span className="grok-label">Step instructions</span><textarea id={`${prefix}-step-${index}-prompt`} className="grok-input text-xs w-full min-h-20 resize-y" value={step.prompt} onChange={(event) => updateStep(index, { ...step, prompt: event.target.value })} required /></label>
            </div>
          ))}
          <button type="button" className="grok-btn grok-btn-secondary" onClick={() => setDraft((current) => ({ ...current, steps: [...(current.steps || []), { id: `step-${(current.steps || []).length + 1}`, name: `Step ${(current.steps || []).length + 1}`, prompt: '', kind: 'work', dependsOn: [] }] }))}><Plus size={13} /> Add step</button>
        </fieldset>
          </div>
        </details>

        {error && <div className="grok-card p-3 text-sm text-error" role="alert">{error}</div>}
        {agents.length === 0 && <div className="grok-card p-3 text-sm text-warning" role="alert">Create an agent before saving an automation.</div>}
        </div>

        <footer className="shrink-0 border-t border-default bg-[var(--bg-card)] p-4 sm:px-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <p id={`${prefix}-save-hint`} className="text-[11px] text-dim sm:mr-auto" aria-live="polite">
            {agents.length === 0
              ? 'Create an agent before saving.'
              : !formIsReady
                ? 'Complete the required fields to save.'
                : draft.enabled !== false
                  ? 'Ready to save and activate.'
                  : 'Ready to save as paused.'}
          </p>
          <button type="button" className="grok-btn grok-btn-secondary w-full sm:w-auto" onClick={onCancel} disabled={saving}>Cancel</button>
          <button type="submit" className="grok-btn grok-btn-primary w-full sm:w-auto" disabled={saving || !formIsReady} aria-describedby={`${prefix}-save-hint`}>
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {saving ? 'Saving…' : 'Save automation'}
          </button>
        </footer>
      </form>
    </div>
  );
}

export default RoutineEditor;
