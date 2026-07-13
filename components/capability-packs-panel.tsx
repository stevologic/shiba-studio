'use client';

import { useCallback, useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Check, Download, History, Package, Pin, RefreshCw, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import { confirmDialog, promptDialog } from '@/components/confirm-dialog';
import type { CapabilityPackProposal, CapabilityPackRecord, LearningJourneyEntry } from '@/lib/capability-pack-types';
import { toast } from '@/lib/toast';

type SourceMode = 'manifest' | 'run' | 'url' | 'folder';

export function CapabilityPacksPanel() {
  const [packs, setPacks] = useState<CapabilityPackRecord[]>([]);
  const [proposals, setProposals] = useState<CapabilityPackProposal[]>([]);
  const [journey, setJourney] = useState<LearningJourneyEntry[]>([]);
  const [safeMode, setSafeMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [showWorkshop, setShowWorkshop] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>('manifest');
  const [sourceValue, setSourceValue] = useState('');
  const [approved, setApproved] = useState<Record<string, Set<string>>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [packsResponse, journeyResponse] = await Promise.all([
        fetch('/api/capability-packs?archived=1', { signal }),
        fetch('/api/capability-packs/journey', { signal }),
      ]);
      const [packData, journeyData] = await Promise.all([packsResponse.json(), journeyResponse.json()]);
      if (!packsResponse.ok || !packData.ok) throw new Error(packData.error || 'Could not load capability packs');
      setPacks(packData.packs || []);
      setProposals((packData.proposals || []).filter((proposal: CapabilityPackProposal) => proposal.status === 'proposed'));
      setSafeMode(!!packData.safeMode);
      if (journeyResponse.ok && journeyData.ok) setJourney(journeyData.entries || []);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      toast.error(error instanceof Error ? error.message : 'Could not load capability packs');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function mutate(body: Record<string, unknown>, success: string) {
    const key = String(body.proposalId || body.packId || body.action || 'action');
    setBusy(key);
    try {
      const response = await fetch('/api/capability-packs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Capability pack action failed');
      toast.success(success);
      await load();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Capability pack action failed');
      return false;
    } finally { setBusy(''); }
  }

  async function propose() {
    let body: Record<string, unknown>;
    if (sourceMode === 'manifest') body = { action: 'propose_manifest', manifest: sourceValue };
    else if (sourceMode === 'run') body = { action: 'propose_run', runId: sourceValue };
    else if (sourceMode === 'url') body = { action: 'propose_url', url: sourceValue };
    else body = { action: 'propose_folder', folder: sourceValue };
    const ok = await mutate(body, 'Capability pack proposal created');
    if (ok) { setSourceValue(''); setShowWorkshop(false); }
  }

  function togglePermission(proposalId: string, key: string) {
    setApproved((current) => {
      const next = new Set(current[proposalId] || []);
      if (next.has(key)) next.delete(key); else next.add(key);
      return { ...current, [proposalId]: next };
    });
  }

  async function uninstall(pack: CapabilityPackRecord) {
    const confirmed = await confirmDialog({
      title: `Uninstall ${pack.name}?`,
      message: 'The active skills and templates will be disabled. Version history stays available for rollback.',
      confirmLabel: 'Uninstall pack', danger: true,
    });
    if (confirmed) await mutate({ action: 'uninstall', packId: pack.id }, 'Capability pack uninstalled');
  }

  async function instantiateRoutine(pack: CapabilityPackRecord, templateId: string) {
    const agentId = await promptDialog({
      title: 'Create Automation from reviewed template',
      message: 'Enter the agent ID that should own this Automation. Creation is explicit and does not broaden the pack permissions.',
      placeholder: 'Agent ID', confirmLabel: 'Create Automation',
    });
    if (agentId?.trim()) {
      await mutate({ action: 'instantiate_routine', packId: pack.id, templateId, agentId: agentId.trim() }, 'Automation created from pack template');
    }
  }

  const archivedCount = packs.filter((pack) => pack.archived).length;
  const visiblePacks = packs.filter((pack) => showArchived ? pack.archived : !pack.archived);

  return (
    <section className="grok-card p-4 mb-4" aria-labelledby="capability-packs-title">
      <div className="flex flex-wrap items-center gap-2">
        <Package size={17} className="text-accent" />
        <div>
          <h2 id="capability-packs-title" className="text-sm font-semibold">Capability Packs &amp; Learning Journey</h2>
          <p className="text-[11px] text-dim">Versioned workflows stay inert until their source, diff, security scan, tests, setup, and permissions are approved.</p>
        </div>
        <button type="button" className="grok-btn grok-btn-ghost ml-auto text-xs" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
        <button type="button" className="grok-btn grok-btn-ghost text-xs" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>
          {showArchived ? <Package size={13} /> : <Archive size={13} />} {showArchived ? 'Active packs' : `Archived (${archivedCount})`}
        </button>
        <button type="button" className="grok-btn grok-btn-primary text-xs" onClick={() => setShowWorkshop((value) => !value)}>
          <Sparkles size={13} /> Learn workflow
        </button>
      </div>

      {safeMode && (
        <div role="alert" className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
          <ShieldCheck size={14} /> Safe mode is on. Packs remain stored, but activation and use are disabled.
        </div>
      )}

      {showWorkshop && (
        <div className="mt-3 rounded-lg border border-[var(--border)] p-3">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold">Skill Workshop proposal</h3>
            <button type="button" className="grok-btn grok-btn-ghost ml-auto p-1" onClick={() => setShowWorkshop(false)} aria-label="Close workshop"><X size={13} /></button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <select className="grok-select text-xs" value={sourceMode} onChange={(event) => setSourceMode(event.target.value as SourceMode)} aria-label="Workflow source">
              <option value="manifest">Pack manifest</option><option value="run">Successful run ID</option>
              <option value="url">HTTPS URL</option><option value="folder">Local/Git folder</option>
            </select>
            {sourceMode === 'manifest' ? (
              <textarea className="grok-input min-h-32 flex-1 font-mono text-xs" value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder="Paste a shiba-pack.json manifest" />
            ) : (
              <input className="grok-input flex-1 text-xs" value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder={sourceMode === 'run' ? 'Completed run ID' : sourceMode === 'url' ? 'https://…' : 'Absolute folder path'} />
            )}
          </div>
          <button type="button" className="grok-btn grok-btn-primary mt-2 text-xs" onClick={() => void propose()} disabled={!sourceValue.trim() || !!busy}>
            Create inert proposal
          </button>
        </div>
      )}

      {proposals.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-dim">Review queue</h3>
          <div className="mt-2 space-y-2">
            {proposals.map((proposal) => {
              const selected = approved[proposal.id] || new Set<string>();
              const ready = proposal.scan.passed && proposal.tests.passed && proposal.setup.passed;
              return (
                <article key={proposal.id} className="rounded-lg border border-[var(--border)] p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{proposal.manifest.name}</strong><code>v{proposal.version}</code>
                    <span className={ready ? 'text-green-400' : 'text-amber-300'}>{ready ? 'scan + tests + setup passed' : 'blocked by checks'}</span>
                    <span className="ml-auto text-dim">{proposal.sourceType} · {proposal.sourceHash.slice(0, 10)}</span>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-dim">Diff and findings</summary>
                    <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[10px]">{JSON.stringify({ diff: proposal.diff, scan: proposal.scan, tests: proposal.tests, setup: proposal.setup }, null, 2)}</pre>
                  </details>
                  {proposal.manifest.permissions.length > 0 && (
                    <fieldset className="mt-2 space-y-1">
                      <legend className="font-medium">Explicitly approve new or broadened permissions</legend>
                      {proposal.manifest.permissions.map((permission, index) => {
                        const key = proposal.requestedPermissionKeys[index];
                        return (
                          <label key={key} className="flex items-start gap-2 rounded border border-[var(--border)] p-2">
                            <input type="checkbox" checked={selected.has(key)} onChange={() => togglePermission(proposal.id, key)} />
                            <span><strong>{permission.action}</strong> · {permission.access} · {permission.confirmation}<br /><span className="text-dim">{permission.resource || 'declared resources'} · {permission.surfaces.join(', ')}</span></span>
                          </label>
                        );
                      })}
                    </fieldset>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button type="button" className="grok-btn grok-btn-primary text-xs" disabled={!ready || safeMode || busy === proposal.id} onClick={() => void mutate({ action: 'activate', proposalId: proposal.id, approvedPermissionKeys: [...selected] }, 'Capability pack activated')}>
                      <Check size={12} /> Activate reviewed version
                    </button>
                    <button type="button" className="grok-btn grok-btn-ghost text-xs" disabled={busy === proposal.id} onClick={() => void mutate({ action: 'reject', proposalId: proposal.id }, 'Proposal rejected')}>Reject</button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-2 lg:grid-cols-2">
        {visiblePacks.map((pack) => (
          <article key={pack.id} className="rounded-lg border border-[var(--border)] p-3 text-xs">
            <div className="flex items-center gap-2"><strong>{pack.name}</strong><code>{pack.activeVersion || pack.previousVersion}</code><span className="text-dim">{pack.status}</span></div>
            <p className="mt-1 text-dim">{pack.description || 'No description'}</p>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-dim">
              <span>{pack.manifest?.skills.length || 0} skills</span><span>{pack.manifest?.routineTemplates.length || 0} automations</span>
              <span>{pack.grantedPermissionKeys.length} grants</span><span>{pack.usageCount} uses</span>
              <span>source {pack.sourceHash.slice(0, 10)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <a className="grok-btn grok-btn-ghost text-xs" href={`/api/capability-packs?export=${encodeURIComponent(pack.id)}`}><Download size={12} /> Export</a>
              <button type="button" className="grok-btn grok-btn-ghost p-1" title={pack.pinned ? 'Unpin' : 'Pin'} aria-label={pack.pinned ? `Unpin ${pack.name}` : `Pin ${pack.name}`} onClick={() => void mutate({ action: 'metadata', packId: pack.id, pinned: !pack.pinned }, pack.pinned ? 'Pack unpinned' : 'Pack pinned')}><Pin size={12} /></button>
              {pack.archived ? (
                <button type="button" className="grok-btn grok-btn-ghost text-xs" disabled={!!busy} onClick={() => void mutate({ action: 'metadata', packId: pack.id, archived: false }, 'Pack restored')}><ArchiveRestore size={12} /> Restore</button>
              ) : (
                <button type="button" className="grok-btn grok-btn-ghost p-1" disabled={!!busy} title="Archive" aria-label={`Archive ${pack.name}`} onClick={() => void mutate({ action: 'metadata', packId: pack.id, archived: true }, 'Pack archived')}><Archive size={12} /></button>
              )}
              {pack.previousVersion && <button type="button" className="grok-btn grok-btn-ghost text-xs" disabled={safeMode} onClick={() => void mutate({ action: 'rollback', packId: pack.id, version: pack.previousVersion }, `Rolled back to ${pack.previousVersion}`)}><History size={12} /> Roll back</button>}
              {pack.status !== 'uninstalled' && <button type="button" className="grok-btn grok-btn-ghost p-1 text-red-400" title="Uninstall" aria-label={`Uninstall ${pack.name}`} onClick={() => void uninstall(pack)}><Trash2 size={12} /></button>}
            </div>
            {pack.status === 'active' && (pack.manifest?.routineTemplates.length || 0) > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-[var(--border)] pt-2">
                <span className="text-[10px] text-dim">Automation templates:</span>
                {pack.manifest!.routineTemplates.map((template) => (
                  <button key={template.id} type="button" className="grok-btn grok-btn-ghost text-[10px] py-1" disabled={safeMode} onClick={() => void instantiateRoutine(pack, template.id)}>
                    {template.name}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
        {!loading && visiblePacks.length === 0 && <p className="text-xs text-dim">{showArchived ? 'No archived capability packs.' : 'No capability packs yet. Learn a successful workflow or import a manifest.'}</p>}
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-xs font-semibold"><History size={13} className="mr-1 inline" />Learning Journey · {journey.length}</summary>
        <ul className="mt-2 max-h-72 space-y-1 overflow-auto">
          {journey.map((entry) => (
            <li key={entry.id} className="rounded border border-[var(--border)] p-2 text-xs">
              <div className="flex items-center gap-2"><strong>{entry.title}</strong><span className="text-dim">{entry.kind} · {entry.status}{entry.version ? ` · v${entry.version}` : ''}</span></div>
              <p className="mt-1 line-clamp-2 text-dim">{entry.detail}</p>
              <div className="mt-1 text-[10px] text-dim">{entry.source}{entry.staleAt ? ` · stale after ${new Date(entry.staleAt).toLocaleDateString()}` : ''}</div>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
