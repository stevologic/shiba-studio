'use client';

import { useId, useState } from 'react';
import { FileCheck2, Loader2, Plus } from 'lucide-react';
import type { EvidenceKind, EvidenceStatus, TaskRecord } from '@/lib/task-types';

const KINDS: EvidenceKind[] = ['human_approval', 'test', 'build', 'command', 'diff', 'artifact', 'screenshot', 'deployment', 'integration', 'assertion', 'other'];

export function EvidenceRecorder({ task, onRecorded }: { task: TaskRecord; onRecorded: () => void }) {
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [requirementId, setRequirementId] = useState(task.contract?.requirements[0]?.id || '');
  const [kind, setKind] = useState<EvidenceKind>('human_approval');
  const [status, setStatus] = useState<EvidenceStatus>('passed');
  const [label, setLabel] = useState('Human review');
  const [summary, setSummary] = useState('');
  const [scope, setScope] = useState('');
  const [uri, setUri] = useState('');
  const [command, setCommand] = useState('');
  const [exitCode, setExitCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirementId: requirementId || undefined,
          kind,
          status,
          label,
          summary,
          scope: scope || undefined,
          uri: uri || undefined,
          command: command || undefined,
          exitCode: exitCode.trim() ? Number(exitCode) : undefined,
          metadata: { recordedBy: 'user', surface: 'task-detail' },
        }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not record evidence');
      setOpen(false);
      setSummary('');
      setUri('');
      setCommand('');
      setExitCode('');
      onRecorded();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not record evidence');
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button type="button" className="grok-btn grok-btn-secondary" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls={headingId}>
        <Plus size={13} /> Record evidence
      </button>
      {open && (
        <form id={headingId} className="border border-default rounded-md p-4 mt-3 grid gap-3 md:grid-cols-2" onSubmit={submit}>
          <h3 className="text-sm font-semibold md:col-span-2 flex items-center gap-2"><FileCheck2 size={14} /> New evidence</h3>
          {task.contract?.requirements.length ? <label className="text-xs">Contract item<select className="grok-select w-full mt-1" value={requirementId} onChange={(event) => setRequirementId(event.target.value)}><option value="">Unlinked evidence</option>{task.contract.requirements.map((requirement) => <option key={requirement.id} value={requirement.id}>{requirement.label}</option>)}</select></label> : null}
          <label className="text-xs">Type<select className="grok-select w-full mt-1" value={kind} onChange={(event) => setKind(event.target.value as EvidenceKind)}>{KINDS.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
          <label className="text-xs">Result<select className="grok-select w-full mt-1" value={status} onChange={(event) => setStatus(event.target.value as EvidenceStatus)}><option value="passed">Passed</option><option value="failed">Failed</option><option value="informational">Informational</option></select></label>
          <label className="text-xs">Label<input className="grok-input w-full mt-1" required value={label} onChange={(event) => setLabel(event.target.value)} /></label>
          <label className="text-xs md:col-span-2">Summary<textarea className="grok-input w-full min-h-20 mt-1" required value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
          <label className="text-xs">Exact scope<input className="grok-input w-full mt-1" value={scope} onChange={(event) => setScope(event.target.value)} placeholder={task.workspaceRoots[0]?.id || 'all-routes'} /></label>
          <label className="text-xs">Evidence URL/path<input className="grok-input w-full mt-1" value={uri} onChange={(event) => setUri(event.target.value)} /></label>
          {(kind === 'command' || kind === 'test' || kind === 'build') && <><label className="text-xs">Command<input className="grok-input w-full mt-1 font-mono" value={command} onChange={(event) => setCommand(event.target.value)} /></label><label className="text-xs">Exit code<input type="number" className="grok-input w-full mt-1" value={exitCode} onChange={(event) => setExitCode(event.target.value)} /></label></>}
          {error && <div className="text-xs text-error md:col-span-2" role="alert">{error}</div>}
          <div className="flex gap-2 md:col-span-2"><button type="submit" className="grok-btn grok-btn-primary" disabled={pending}>{pending ? <Loader2 size={13} className="animate-spin" /> : null} Save evidence</button><button type="button" className="grok-btn grok-btn-ghost" disabled={pending} onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      )}
    </div>
  );
}

export default EvidenceRecorder;
