'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Stethoscope, XCircle } from 'lucide-react';
import type { DoctorCheck, DoctorRepairAction, DoctorReport } from '@/lib/doctor';
import { NativeNodesPanel } from './native-nodes-panel';

function CheckIcon({ status }: { status: DoctorCheck['status'] }) {
  if (status === 'ok') return <CheckCircle2 size={17} className="text-success" aria-hidden="true" />;
  if (status === 'warning') return <AlertTriangle size={17} className="text-warning" aria-hidden="true" />;
  return <XCircle size={17} className="text-error" aria-hidden="true" />;
}

function RepairPreviewDialog({
  preview,
  repairing,
  onApply,
  onCancel,
}: {
  preview: { action: DoctorRepairAction; effect: string };
  repairing: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  const repairingRef = useRef(repairing);

  useEffect(() => {
    cancelRef.current = onCancel;
    repairingRef.current = repairing;
  }, [onCancel, repairing]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    applyRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !repairingRef.current) {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnFocus?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !repairing) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="modal modal-pop w-full max-w-lg p-5"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="repair-preview-heading"
        aria-describedby="repair-preview-description"
        tabIndex={-1}
      >
        <h2 id="repair-preview-heading" className="font-semibold">Repair preview</h2>
        <p id="repair-preview-description" className="text-sm text-muted mt-2">{preview.effect}</p>
        <p className="text-xs text-dim mt-2">Exact action: <span className="font-mono">{preview.action}</span>. Applying it writes an audit entry.</p>
        <div className="flex gap-2 mt-4">
          <button ref={applyRef} type="button" className="grok-btn grok-btn-primary" disabled={repairing} onClick={onApply}>{repairing ? <Loader2 size={13} className="animate-spin" /> : null} Apply exact repair</button>
          <button type="button" className="grok-btn grok-btn-ghost" disabled={repairing} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function DoctorPage() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState<DoctorRepairAction | null>(null);
  const [preview, setPreview] = useState<{ action: DoctorRepairAction; effect: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/doctor', { cache: 'no-store' });
      const data = await response.json() as { ok?: boolean; report?: DoctorReport; error?: string };
      if (!response.ok || !data.ok || !data.report) throw new Error(data.error || 'Diagnostics failed');
      setReport(data.report);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Diagnostics failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function previewRepair(action: DoctorRepairAction) {
    setRepairing(action);
    setError(null);
    try {
      const response = await fetch('/api/doctor/repairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, apply: false }),
      });
      const data = await response.json() as { ok?: boolean; preview?: { action: DoctorRepairAction; effect: string }; error?: string };
      if (!response.ok || !data.ok || !data.preview) throw new Error(data.error || 'Could not preview repair');
      setPreview(data.preview);
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : 'Could not preview repair');
    } finally {
      setRepairing(null);
    }
  }

  async function applyRepair() {
    if (!preview) return;
    setRepairing(preview.action);
    setError(null);
    try {
      const response = await fetch('/api/doctor/repairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: preview.action, apply: true, confirm: preview.action }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Repair failed');
      setPreview(null);
      await load();
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : 'Repair failed');
    } finally {
      setRepairing(null);
    }
  }

  return (
    <>
    <section className="page-content space-y-5" aria-labelledby="doctor-heading" inert={preview ? true : undefined} aria-hidden={preview ? true : undefined}>
      <header className="page-head-row">
        <div>
          <div className="flex items-center gap-2">
            <Stethoscope size={22} aria-hidden="true" />
            <h1 id="doctor-heading" className="page-title">Shiba Doctor</h1>
          </div>
          <p className="page-subtitle">Read-only diagnostics with explicit, audited repair previews. Reports never include credential values.</p>
        </div>
        <button type="button" className="grok-btn grok-btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} Run diagnostics
        </button>
      </header>

      {error && <div className="grok-card p-3 text-sm text-error" role="alert">{error}</div>}
      {loading && !report ? (
        <div className="grok-card p-10 text-center text-sm text-dim" aria-busy="true"><Loader2 size={20} className="animate-spin mx-auto mb-2" />Inspecting this Shiba host…</div>
      ) : report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3" aria-label="Diagnostic summary">
            {(['ok', 'warning', 'error'] as const).map((status) => (
              <div key={status} className="grok-card p-4">
                <div className="text-[11px] uppercase tracking-wide text-dim">{status}</div>
                <div className={`text-2xl font-semibold mt-1 ${status === 'ok' ? 'text-success' : status === 'warning' ? 'text-warning' : 'text-error'}`}>{report.summary[status]}</div>
              </div>
            ))}
          </div>
          <ul className="space-y-3" aria-label="Diagnostic checks">
            {report.checks.map((item) => (
              <li key={item.id} className="grok-card p-4 flex gap-3">
                <CheckIcon status={item.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold">{item.label}</h2>
                    <span className="status-pill text-dim">{item.category}</span>
                  </div>
                  <p className="text-xs text-muted mt-1.5">{item.detail}</p>
                  {item.repairAction && (
                    <button type="button" className="grok-btn grok-btn-ghost mt-3" disabled={!!repairing} onClick={() => void previewRepair(item.repairAction!)}>
                      {repairing === item.repairAction && <Loader2 size={13} className="animate-spin" />} Preview repair
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-dim">Generated {new Date(report.generatedAt).toLocaleString()}</p>
        </>
      ) : null}

      <NativeNodesPanel />
    </section>
    {preview && (
      <RepairPreviewDialog
        preview={preview}
        repairing={repairing === preview.action}
        onApply={() => { void applyRepair(); }}
        onCancel={() => setPreview(null)}
      />
    )}
    </>
  );
}

export default DoctorPage;
