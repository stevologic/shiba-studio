'use client';

import { useCallback, useState } from 'react';
import { Loader2, Stethoscope } from 'lucide-react';
import type { DoctorCheck, DoctorRepairAction, DoctorReport } from '@/lib/doctor';

const STATUS_CLASS: Record<DoctorCheck['status'], string> = {
  ok: 'text-success',
  warning: 'text-warning',
  error: 'text-error',
};

export function StudioDoctorCard() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'scan' | DoctorRepairAction | null>(null);

  const scan = useCallback(async () => {
    setBusy('scan');
    setError(null);
    try {
      const response = await fetch('/api/doctor', { cache: 'no-store' });
      const data = await response.json() as { ok?: boolean; report?: DoctorReport; error?: string };
      if (!response.ok || !data.ok || !data.report) throw new Error(data.error || 'Doctor scan failed');
      setReport(data.report);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Doctor scan failed');
    } finally {
      setBusy(null);
    }
  }, []);

  async function repair(action: DoctorRepairAction) {
    setBusy(action);
    setError(null);
    try {
      const previewResponse = await fetch('/api/doctor/repairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const preview = await previewResponse.json() as { ok?: boolean; preview?: { effect: string }; error?: string };
      if (!previewResponse.ok || !preview.ok) throw new Error(preview.error || 'Could not preview repair');
      const confirmed = window.confirm(preview.preview?.effect || `Apply ${action}?`);
      if (!confirmed) return;
      const applyResponse = await fetch('/api/doctor/repairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, apply: true, confirm: action }),
      });
      const applied = await applyResponse.json() as { ok?: boolean; error?: string };
      if (!applyResponse.ok || !applied.ok) throw new Error(applied.error || 'Repair failed');
      await scan();
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : 'Repair failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grok-card p-5 settings-card">
      <div className="settings-card-head">
        <Stethoscope size={16} className="opacity-70 shrink-0" />
        <div>
          <div className="font-medium text-sm">Studio health</div>
          <div className="text-[11px] text-dim">Read-only diagnosis. Repairs preview their exact effect first.</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          className="grok-btn grok-btn-primary text-sm"
          disabled={busy !== null}
          onClick={() => void scan()}
        >
          {busy === 'scan' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
          {busy === 'scan' ? 'Scanning…' : report ? 'Scan again' : 'Run Doctor'}
        </button>
      </div>
      {error && <div className="text-xs text-error mt-2" role="alert">{error}</div>}
      {report && (
        <div className="mt-3 space-y-2">
          <div className="text-xs text-dim">
            {report.summary.ok} ok · {report.summary.warning} warning · {report.summary.error} error
            {report.safeMode ? ' · safe mode on' : ''}
          </div>
          <ul className="max-h-64 overflow-y-auto divide-y divide-[var(--border)]">
            {report.checks.map((check) => (
              <li key={check.id} className="py-2">
                <div className={`text-xs font-medium ${STATUS_CLASS[check.status]}`}>{check.label}</div>
                <p className="text-[11px] text-dim mt-0.5">{check.detail}</p>
                {check.repairAction && (
                  <button
                    type="button"
                    className="grok-btn grok-btn-ghost text-[11px] px-2 py-0.5 mt-1"
                    disabled={busy !== null}
                    onClick={() => void repair(check.repairAction!)}
                  >
                    {busy === check.repairAction ? 'Applying…' : 'Preview repair'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default StudioDoctorCard;
