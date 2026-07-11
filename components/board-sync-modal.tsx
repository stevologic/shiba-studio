'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Check, Loader2, RefreshCw, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import type {
  BoardSyncConflictPolicy,
  BoardSyncDirection,
  BoardSyncMode,
  BoardSyncProvider,
  BoardSyncResult,
  BoardSyncTarget,
} from '@/lib/board-sync-types';

interface ProviderOverview {
  configured: boolean;
  targetId?: string;
  targetName?: string;
  direction: BoardSyncDirection;
  mode: BoardSyncMode;
  linkedTasks: number;
  lastSync?: { completedAt?: string; errors?: number };
}

interface BoardSyncModalProps {
  open: boolean;
  onClose: () => void;
  onSynced: () => void;
}

const PROVIDERS: Array<{ id: BoardSyncProvider; label: string; icon: string }> = [
  { id: 'linear', label: 'Linear', icon: '/integrations/linear.svg' },
  { id: 'jira', label: 'Jira', icon: '/integrations/jira.svg' },
];

export default function BoardSyncModal({ open, onClose, onSynced }: BoardSyncModalProps) {
  const [overview, setOverview] = useState<Record<BoardSyncProvider, ProviderOverview> | null>(null);
  const [provider, setProvider] = useState<BoardSyncProvider>('linear');
  const [targets, setTargets] = useState<BoardSyncTarget[]>([]);
  const [targetId, setTargetId] = useState('');
  const [direction, setDirection] = useState<BoardSyncDirection>('pull');
  const [mode, setMode] = useState<BoardSyncMode>('board');
  const [conflictPolicy, setConflictPolicy] = useState<BoardSyncConflictPolicy>('newest');
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BoardSyncResult | null>(null);
  const current = overview?.[provider];

  const discover = useCallback(async (nextProvider: BoardSyncProvider, preferredTarget?: string) => {
    setDiscovering(true);
    setTargets([]);
    try {
      const response = await fetch('/api/board/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'discover', provider: nextProvider }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not load sync targets.');
      const nextTargets = Array.isArray(data.targets) ? data.targets as BoardSyncTarget[] : [];
      setTargets(nextTargets);
      setTargetId((value) => {
        const wanted = preferredTarget || value;
        return nextTargets.some((target) => target.id === wanted) ? wanted : (nextTargets[0]?.id || '');
      });
    } catch (error) {
      setTargets([]);
      toast.error(error instanceof Error ? error.message : 'Could not load sync targets.');
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setResult(null);
      try {
        const response = await fetch('/api/board/sync');
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || 'Could not load Board sync.');
        if (cancelled) return;
        const providers = data.providers as Record<BoardSyncProvider, ProviderOverview>;
        setOverview(providers);
        const nextProvider: BoardSyncProvider = providers.linear?.configured
          ? 'linear'
          : providers.jira?.configured
            ? 'jira'
            : 'linear';
        const selected = providers[nextProvider];
        setProvider(nextProvider);
        setDirection(selected?.direction || 'pull');
        setMode(selected?.mode || 'board');
        setTargetId(selected?.targetId || '');
        if (selected?.configured) await discover(nextProvider, selected.targetId);
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Could not load Board sync.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, discover]);

  function chooseProvider(nextProvider: BoardSyncProvider) {
    setProvider(nextProvider);
    setResult(null);
    const selected = overview?.[nextProvider];
    setDirection(selected?.direction || 'pull');
    setMode(selected?.mode || 'board');
    setTargetId(selected?.targetId || '');
    if (selected?.configured) void discover(nextProvider, selected.targetId);
    else setTargets([]);
  }

  async function runSync() {
    if (!targetId || running) return;
    setRunning(true);
    setResult(null);
    try {
      const response = await fetch('/api/board/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync',
          provider,
          targetId,
          direction,
          mode,
          conflictPolicy,
        }),
      });
      const data = await response.json();
      if (!response.ok || (!data.ok && !Array.isArray(data.errors))) {
        throw new Error(data.error || 'Board sync failed.');
      }
      const nextResult = data as BoardSyncResult;
      setResult(nextResult);
      onSynced();
      if (nextResult.errors.length) toast.warning(`Sync finished with ${nextResult.errors.length} item error(s).`);
      const overviewResponse = await fetch('/api/board/sync');
      const nextOverview = await overviewResponse.json();
      if (nextOverview.ok) setOverview(nextOverview.providers);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Board sync failed.');
    } finally {
      setRunning(false);
    }
  }

  const resultSummary = useMemo(() => {
    if (!result) return '';
    const changed = result.imported + result.exported + result.updatedLocal + result.updatedRemote;
    return `${changed} changed · ${result.skipped} unchanged${result.conflicts ? ` · ${result.conflicts} conflict(s)` : ''}`;
  }, [result]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[75] p-4" onClick={onClose}>
      <div
        className="modal modal-pop w-full max-w-lg p-6 kb-sync-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Sync Board with Linear or Jira"
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-lg font-semibold">Sync Board</div>
            <div className="text-xs text-dim mt-0.5">Mirror cards with a Linear team, Jira project, or Jira Kanban board.</div>
          </div>
          <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="data-loading-row py-8"><span className="data-spinner" /> Loading sync settings…</div>
        ) : (
          <>
            <div className="kb-sync-provider-grid mb-4">
              {PROVIDERS.map((item) => {
                const state = overview?.[item.id];
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`kb-sync-provider ${provider === item.id ? 'kb-sync-provider-active' : ''}`}
                    onClick={() => chooseProvider(item.id)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.icon} alt="" width={20} height={20} />
                    <span>{item.label}</span>
                    <span className={state?.configured ? 'text-success' : 'text-dim'}>{state?.configured ? 'Connected' : 'Not set up'}</span>
                  </button>
                );
              })}
            </div>

            {!current?.configured ? (
              <div className="sync-warning mb-4">
                <AlertTriangle size={14} />
                <span>Connect {provider === 'linear' ? 'Linear' : 'Jira'} in <Link href="/integrations" className="link-accent" onClick={onClose}>Capabilities</Link> first.</span>
              </div>
            ) : (
              <>
                <label className="kb-prop mb-4">
                  <span className="kb-prop-name">Sync target</span>
                  <div className="flex gap-2">
                    <select className="grok-select flex-1 text-xs" value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={discovering || running}>
                      {discovering && <option value="">Loading targets…</option>}
                      {!discovering && !targets.length && <option value="">No accessible targets</option>}
                      {targets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.kind === 'board' ? 'Kanban' : target.kind === 'project' ? 'Project' : 'Team'} · {target.name}{target.key ? ` (${target.key})` : ''}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="grok-btn grok-btn-secondary px-2.5" onClick={() => void discover(provider, targetId)} disabled={discovering || running} title="Refresh targets">
                      <RefreshCw size={14} className={discovering ? 'animate-spin' : ''} />
                    </button>
                  </div>
                </label>

                <div className="kb-prop-name mb-1.5">Direction</div>
                <div className="sync-direction mb-4 kb-sync-directions">
                  <button type="button" disabled={running} onClick={() => setDirection('pull')} className={`sync-direction-option ${direction === 'pull' ? 'sync-direction-active' : ''}`}>
                    <ArrowDownToLine size={15} /> Pull to Shiba
                  </button>
                  <button type="button" disabled={running} onClick={() => setDirection('push')} className={`sync-direction-option ${direction === 'push' ? 'sync-direction-active' : ''}`}>
                    <ArrowUpFromLine size={15} /> Push out
                  </button>
                  <button type="button" disabled={running} onClick={() => setDirection('bidirectional')} className={`sync-direction-option ${direction === 'bidirectional' ? 'sync-direction-active' : ''}`}>
                    <ArrowLeftRight size={15} /> Two-way
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-4">
                  <button type="button" className={`kb-sync-mode ${mode === 'board' ? 'kb-sync-mode-active' : ''}`} onClick={() => setMode('board')} disabled={running}>
                    <span>Tasks + columns</span>
                    <small>Titles, details, priority, labels, and mapped workflow status.</small>
                  </button>
                  <button type="button" className={`kb-sync-mode ${mode === 'tasks' ? 'kb-sync-mode-active' : ''}`} onClick={() => setMode('tasks')} disabled={running}>
                    <span>Task fields only</span>
                    <small>Keep each system&apos;s current workflow status unchanged.</small>
                  </button>
                </div>

                {direction === 'bidirectional' && (
                  <label className="kb-prop mb-4">
                    <span className="kb-prop-name">When the same field changed on both</span>
                    <select className="grok-select text-xs" value={conflictPolicy} onChange={(event) => setConflictPolicy(event.target.value as BoardSyncConflictPolicy)} disabled={running}>
                      <option value="newest">Use the newest task-field change</option>
                      <option value="local">Use Shiba&apos;s value</option>
                      <option value="remote">Use {provider === 'linear' ? 'Linear' : 'Jira'}&apos;s value</option>
                    </select>
                  </label>
                )}

                <div className="sync-explainer mb-4">
                  Once a provider returns an issue ID, repeat syncs reuse that stored link. Sync never deletes cards or remote issues, and it does not copy Shiba agent assignments, run activity, Jira sprints, or remote assignees.
                </div>

                {result && (
                  <div className={`kb-sync-result mb-4 ${result.errors.length ? 'kb-sync-result-warning' : ''}`}>
                    {result.errors.length ? <AlertTriangle size={15} /> : <Check size={15} />}
                    <div className="min-w-0">
                      <div className="text-xs font-medium">Sync complete · {resultSummary}</div>
                      {result.errors.slice(0, 3).map((error) => <div key={`${error.key}-${error.message}`} className="text-[10px] text-dim truncate" title={error.message}>{error.key}: {error.message}</div>)}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2.5">
                  <div className="text-[10px] text-dim flex-1">
                    {current.linkedTasks} linked card{current.linkedTasks === 1 ? '' : 's'}
                    {current.lastSync?.completedAt ? ` · last sync ${new Date(current.lastSync.completedAt).toLocaleString()}` : ''}
                  </div>
                  <button type="button" onClick={onClose} className="grok-btn grok-btn-secondary">Close</button>
                  <button type="button" onClick={() => void runSync()} disabled={running || discovering || !targetId} className="grok-btn grok-btn-primary">
                    {running ? <><Loader2 size={14} className="animate-spin" /> Syncing…</> : <><RefreshCw size={14} /> Sync now</>}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
