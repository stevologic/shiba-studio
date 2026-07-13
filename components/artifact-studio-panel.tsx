'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Archive, CheckCircle2, ExternalLink, FilePlus2, Loader2, MessageSquarePlus,
  RefreshCw, RotateCcw, Share2, ShieldOff, XCircle,
} from 'lucide-react';
import { ArtifactPreview } from '@/components/artifact-preview';
import type {
  ArtifactAnnotation, ArtifactAudience, ArtifactPublication, ArtifactRecord,
} from '@/lib/artifacts';
import type { TaskRecord } from '@/lib/task-types';

interface ArtifactStudioPanelProps {
  task: TaskRecord;
  onEvidenceChanged: () => void;
}

export function ArtifactStudioPanel({ task, onEvidenceChanged }: ArtifactStudioPanelProps) {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [selected, setSelected] = useState<ArtifactRecord | null>(null);
  const [annotations, setAnnotations] = useState<ArtifactAnnotation[]>([]);
  const [publications, setPublications] = useState<ArtifactPublication[]>([]);
  const [versionId, setVersionId] = useState('');
  const [filePath, setFilePath] = useState('');
  const [trackLive, setTrackLive] = useState(false);
  const [renderReport, setRenderReport] = useState<Record<string, unknown>>({});
  const [notes, setNotes] = useState('');
  const [locatorType, setLocatorType] = useState<'region' | 'page' | 'slide' | 'table' | 'cell'>('region');
  const [locatorValue, setLocatorValue] = useState('');
  const [comment, setComment] = useState('');
  const [publicationUrl, setPublicationUrl] = useState('');
  const [audience, setAudience] = useState<ArtifactAudience>('private_link');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/artifacts?taskId=${encodeURIComponent(task.id)}`, { cache: 'no-store', signal });
    const data = await response.json() as { ok?: boolean; artifacts?: ArtifactRecord[]; error?: string };
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load artifacts');
    setArtifacts(data.artifacts || []);
    setError(null);
  }, [task.id]);

  const loadArtifact = useCallback(async (id: string, signal?: AbortSignal) => {
    const [response, publicationResponse] = await Promise.all([
      fetch(`/api/artifacts/${encodeURIComponent(id)}`, { cache: 'no-store', signal }),
      fetch(`/api/artifacts/${encodeURIComponent(id)}/publish`, { cache: 'no-store', signal }),
    ]);
    const data = await response.json() as { ok?: boolean; artifact?: ArtifactRecord; annotations?: ArtifactAnnotation[]; error?: string };
    const publicationData = await publicationResponse.json() as { ok?: boolean; publications?: ArtifactPublication[] };
    if (!response.ok || !data.ok || !data.artifact) throw new Error(data.error || 'Could not load artifact');
    setSelected(data.artifact);
    setAnnotations(data.annotations || []);
    setPublications(publicationData.publications || []);
    setPublicationUrl('');
    setRenderReport({});
    setVersionId((current) => data.artifact!.versions?.some((version) => version.id === current) ? current : data.artifact!.currentVersionId);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadList(controller.signal).catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load artifacts');
      });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [loadList]);

  const version = selected?.versions?.find((item) => item.id === versionId) || null;
  const captureRenderReport = useCallback((report: Record<string, unknown>) => setRenderReport(report), []);

  async function registerArtifact() {
    setPending('register'); setError(null);
    try {
      const response = await fetch('/api/artifacts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          filePath,
          ...(trackLive ? { liveSource: { type: 'filesystem', reference: filePath, readOnly: true }, approveLiveSource: true } : {}),
        }),
      });
      const data = await response.json() as { ok?: boolean; artifact?: ArtifactRecord; error?: string };
      if (!response.ok || !data.ok || !data.artifact) throw new Error(data.error || 'Could not register artifact');
      setFilePath(''); setTrackLive(false); await loadList(); await loadArtifact(data.artifact.id);
    } catch (registerError) { setError(registerError instanceof Error ? registerError.message : 'Could not register artifact'); }
    finally { setPending(null); }
  }

  async function createVersion() {
    if (!selected) return;
    setPending('version'); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(selected.id)}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json() as { ok?: boolean; artifact?: ArtifactRecord; error?: string };
      if (!response.ok || !data.ok || !data.artifact) throw new Error(data.error || 'Could not capture a new version');
      setSelected(data.artifact); setVersionId(data.artifact.currentVersionId); setRenderReport({}); await loadList();
    } catch (versionError) { setError(versionError instanceof Error ? versionError.message : 'Could not capture a new version'); }
    finally { setPending(null); }
  }

  async function verify(passed: boolean) {
    if (!selected || !version) return;
    setPending('verify'); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(selected.id)}/versions/${encodeURIComponent(version.id)}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passed, renderer: String(renderReport.renderer || 'human-visual-review'), notes, metadata: renderReport }),
      });
      const data = await response.json() as { ok?: boolean; artifact?: ArtifactRecord; error?: string };
      if (!response.ok || !data.ok || !data.artifact) throw new Error(data.error || 'Could not save visual verification');
      setSelected(data.artifact); setNotes(''); await loadList(); onEvidenceChanged();
    } catch (verifyError) { setError(verifyError instanceof Error ? verifyError.message : 'Could not save visual verification'); }
    finally { setPending(null); }
  }

  async function addAnnotation() {
    if (!selected || !version || !comment.trim()) return;
    const numeric = Number(locatorValue);
    const [sheetName, cellName] = locatorValue.includes('!') ? locatorValue.split('!', 2) : ['', locatorValue];
    const region = locatorValue.split(',').map(Number);
    const locator = locatorType === 'page' ? { type: locatorType, page: numeric }
      : locatorType === 'slide' ? { type: locatorType, slide: numeric }
        : locatorType === 'cell' ? { type: locatorType, cell: cellName, ...(sheetName ? { sheet: sheetName } : {}) }
          : locatorType === 'table' ? { type: locatorType, ...(locatorValue.trim() ? { sheet: locatorValue.trim() } : {}) }
            : { type: locatorType, x: region[0], y: region[1], width: region[2], height: region[3] };
    setPending('annotation'); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(selected.id)}/annotations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: version.id, locator, comment }) });
      const data = await response.json() as { ok?: boolean; annotation?: ArtifactAnnotation; error?: string };
      if (!response.ok || !data.ok || !data.annotation) throw new Error(data.error || 'Could not add annotation');
      setAnnotations((current) => [data.annotation!, ...current]); setComment('');
    } catch (annotationError) { setError(annotationError instanceof Error ? annotationError.message : 'Could not add annotation'); }
    finally { setPending(null); }
  }

  async function updateAnnotation(annotationId: string, resolved: boolean) {
    if (!selected) return;
    setPending(`annotation:${annotationId}`); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(selected.id)}/annotations`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ annotationId, resolved }) });
      const data = await response.json() as { ok?: boolean; annotation?: ArtifactAnnotation; error?: string };
      if (!response.ok || !data.ok || !data.annotation) throw new Error(data.error || 'Could not update annotation');
      setAnnotations((current) => current.map((item) => item.id === data.annotation!.id ? data.annotation! : item));
    } catch (annotationError) { setError(annotationError instanceof Error ? annotationError.message : 'Could not update annotation'); }
    finally { setPending(null); }
  }

  async function publish() {
    if (!selected || !version) return;
    setPending('publish'); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(selected.id)}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: version.id, audience, ttlHours: 168 }) });
      const data = await response.json() as { ok?: boolean; publication?: ArtifactPublication & { token: string }; error?: string };
      if (!response.ok || !data.ok || !data.publication) throw new Error(data.error || 'Could not publish artifact');
      setPublicationUrl(`${window.location.origin}/api/artifact-public/${encodeURIComponent(data.publication.token)}`);
      setPublications((current) => [data.publication!, ...current]); await loadList();
    } catch (publishError) { setError(publishError instanceof Error ? publishError.message : 'Could not publish artifact'); }
    finally { setPending(null); }
  }

  async function mutateArtifact(action: 'refresh' | 'rollback') {
    if (!selected || !version) return;
    setPending(action); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(selected.id)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: action === 'rollback' ? JSON.stringify({ versionId: version.id }) : '{}',
      });
      const data = await response.json() as { ok?: boolean; artifact?: ArtifactRecord; error?: string };
      if (!response.ok || !data.ok || !data.artifact) throw new Error(data.error || `Could not ${action} artifact`);
      setSelected(data.artifact); setVersionId(data.artifact.currentVersionId); setRenderReport({}); await loadList();
    } catch (mutationError) { setError(mutationError instanceof Error ? mutationError.message : `Could not ${action} artifact`); }
    finally { setPending(null); }
  }

  async function publicationAction(action: 'revoke' | 'takedown', publicationId?: string) {
    if (!selected) return;
    setPending(action); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(selected.id)}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, publicationId }) });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || `Could not ${action} artifact`);
      setPublicationUrl(''); await loadArtifact(selected.id); await loadList();
    } catch (publicationError) { setError(publicationError instanceof Error ? publicationError.message : `Could not ${action} artifact`); }
    finally { setPending(null); }
  }

  if (!task.workspaceRoots.length) return null;
  return (
    <section className="grok-card p-5 space-y-4" aria-labelledby="artifact-studio-heading">
      <div><h2 id="artifact-studio-heading" className="text-base font-semibold flex items-center gap-2"><Archive size={16} /> Artifact Studio</h2><p className="text-xs text-dim mt-1">Immutable checkpoint-backed versions, visual review, precise feedback, and revocable publishing.</p></div>
      <div className="space-y-2">
        <div className="flex gap-2"><label className="sr-only" htmlFor="artifact-file-path">Task-owned artifact file path</label><input id="artifact-file-path" className="grok-input flex-1 font-mono text-xs" value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="Absolute path to a task-owned HTML, PDF, DOCX, PPTX, XLSX, image, or text file" /><button type="button" className="grok-btn grok-btn-secondary" disabled={!filePath.trim() || !!pending} onClick={() => void registerArtifact()}>{pending === 'register' ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />} Register</button></div>
        <label className="inline-flex items-center gap-2 text-xs text-dim"><input type="checkbox" checked={trackLive} onChange={(event) => setTrackLive(event.target.checked)} /> Approve this task-owned file as a read-only live source</label>
      </div>
      {error && <div className="text-xs text-error" role="alert">{error}</div>}
      {artifacts.length > 0 && <div className="flex flex-wrap gap-2">{artifacts.map((artifact) => <button key={artifact.id} type="button" className={`grok-btn ${selected?.id === artifact.id ? 'grok-btn-primary' : 'grok-btn-ghost'}`} onClick={() => void loadArtifact(artifact.id)}>{artifact.name}<span className="status-pill text-dim">{artifact.status}</span></button>)}</div>}
      {selected && version && <>
        <div className="flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor="artifact-version">Artifact version</label><select id="artifact-version" className="grok-select" value={version.id} onChange={(event) => { setVersionId(event.target.value); setRenderReport({}); }}>{selected.versions?.map((item) => <option key={item.id} value={item.id}>Version {item.version} · {item.renderStatus}</option>)}</select><button type="button" className="grok-btn grok-btn-ghost" disabled={!!pending || selected.status === 'archived'} onClick={() => void createVersion()}><RefreshCw size={12} /> Capture source as new version</button>{selected.liveSource && <button type="button" className="grok-btn grok-btn-ghost" disabled={!!pending || selected.status === 'archived'} onClick={() => void mutateArtifact('refresh')}><RefreshCw size={12} /> Refresh approved live source</button>}{version.id !== selected.currentVersionId && <button type="button" className="grok-btn grok-btn-ghost" disabled={!!pending} onClick={() => void mutateArtifact('rollback')}><RotateCcw size={12} /> Roll back to this version</button>}<span className="text-[11px] text-dim">checkpoint {version.checkpointId}</span></div>
        <div className="border border-default rounded-md p-3 overflow-auto"><ArtifactPreview key={version.id} artifact={selected} version={version} onReady={captureRenderReport} /></div>
        {renderReport.visualVerificationEligible === false && (
          <div className="rounded-md border border-warning p-3 text-xs text-warning" role="status">
            This is a structural preview only. It does not render Office layout, charts, images, or formatting, so it cannot produce passed visual evidence. Export or render the file with a fidelity-capable viewer before recording a visual pass.
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]"><label className="sr-only" htmlFor="artifact-review-notes">Visual review notes</label><input id="artifact-review-notes" className="grok-input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Visual review notes" /><button type="button" className="grok-btn grok-btn-primary" disabled={!!pending || renderReport.rendered !== true || renderReport.visualVerificationEligible === false} onClick={() => void verify(true)}><CheckCircle2 size={13} /> Pass visual check</button><button type="button" className="grok-btn grok-btn-danger" disabled={!!pending} onClick={() => void verify(false)}><XCircle size={13} /> Fail</button></div>
        <div className="border-t border-default pt-4 space-y-2">
          <div className="text-xs font-medium">Anchored revision feedback</div>
          <div className="grid gap-2 sm:grid-cols-[auto_1fr_2fr_auto]"><label className="sr-only" htmlFor="artifact-locator-type">Annotation locator type</label><select id="artifact-locator-type" className="grok-select" value={locatorType} onChange={(event) => { setLocatorType(event.target.value as typeof locatorType); setLocatorValue(''); }}><option value="region">Region</option><option value="page">Page</option><option value="slide">Slide</option><option value="table">Table</option><option value="cell">Cell</option></select><label className="sr-only" htmlFor="artifact-locator-value">Annotation location</label><input id="artifact-locator-value" className="grok-input" value={locatorValue} onChange={(event) => setLocatorValue(event.target.value)} placeholder={locatorType === 'region' ? 'x,y,width,height (0–1)' : locatorType === 'cell' ? 'Sheet!A1' : locatorType === 'table' ? 'Sheet or table name' : 'Positive number'} /><label className="sr-only" htmlFor="artifact-comment">Revision feedback</label><input id="artifact-comment" className="grok-input" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What should change here?" /><button type="button" className="grok-btn grok-btn-secondary" disabled={!comment.trim() || !locatorValue.trim() || !!pending} onClick={() => void addAnnotation()}><MessageSquarePlus size={13} /> Add</button></div>
          {annotations.map((annotation) => <div key={annotation.id} className="text-xs border border-default rounded p-2 flex gap-2 items-center"><span className="status-pill text-dim">{annotation.status}</span><span className="flex-1"><span className="status-pill text-dim">{annotation.locator.type}</span> {JSON.stringify(annotation.locator)} · {annotation.comment}</span><button type="button" className="grok-btn grok-btn-ghost" disabled={!!pending} onClick={() => void updateAnnotation(annotation.id, annotation.status !== 'resolved')}>{annotation.status === 'resolved' ? 'Reopen' : 'Resolve'}</button></div>)}
        </div>
        <div className="border-t border-default pt-4 space-y-2">
          <div className="flex flex-wrap gap-2 items-center"><label className="text-xs text-dim" htmlFor="artifact-audience">Audience</label><select id="artifact-audience" className="grok-select" value={audience} onChange={(event) => setAudience(event.target.value as ArtifactAudience)}><option value="private_link">Bearer link</option><option value="lan">Local/LAN only</option></select><button type="button" className="grok-btn grok-btn-secondary" disabled={version.renderStatus !== 'passed' || !!pending || selected.status === 'archived'} onClick={() => void publish()}><Share2 size={13} /> Publish verified version for 7 days</button><button type="button" className="grok-btn grok-btn-danger" disabled={!!pending || selected.status === 'archived'} onClick={() => void publicationAction('takedown')}><ShieldOff size={13} /> Takedown and archive</button>{publicationUrl && <a className="link-accent inline-flex items-center gap-1 text-xs break-all" href={publicationUrl} target="_blank" rel="noreferrer">{publicationUrl}<ExternalLink size={11} /></a>}</div>
          {publications.map((publication) => <div key={publication.id} className="text-xs text-dim flex items-center gap-2"><span className="status-pill">{publication.audience}</span><span>version {selected.versions?.find((item) => item.id === publication.versionId)?.version || publication.versionId}</span><span>{publication.revokedAt ? 'revoked' : `expires ${publication.expiresAt ? new Date(publication.expiresAt).toLocaleString() : 'never'}`}</span>{!publication.revokedAt && <button type="button" className="grok-btn grok-btn-ghost" disabled={!!pending} onClick={() => void publicationAction('revoke', publication.id)}>Revoke</button>}</div>)}
        </div>
      </>}
    </section>
  );
}

export default ArtifactStudioPanel;
