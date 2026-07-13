'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AudioLines,
  CheckCircle2,
  Clock3,
  FileAudio,
  Loader2,
  Mic,
  Pause,
  Play,
  Save,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import { confirmDialog } from '@/components/confirm-dialog';
import { subscribeLiveEvents } from '@/lib/live-events';
import type { MeetingActionItem, MeetingDecision, MeetingRecord } from '@/lib/meeting-types';
import type { Agent } from '@/lib/types';
import { toast } from '@/lib/toast';

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const CONSENT_TEXT = 'I confirm that everyone required has consented to this recording and that I am responsible for complying with applicable recording laws.';

type ApiPayload = { ok?: boolean; meeting?: MeetingRecord; meetings?: MeetingRecord[]; error?: string };

function timeLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function inferredMime(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', amr: 'audio/amr' } as Record<string, string>)[extension || ''] || 'application/octet-stream';
}

function recordingMime(): string {
  const choices = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return choices.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

function ReviewEditor({
  meeting,
  agents,
  onChanged,
  onSeek,
}: {
  meeting: MeetingRecord;
  agents: Agent[];
  onChanged: (meeting: MeetingRecord) => void;
  onSeek: (seconds: number) => void;
}) {
  const [title, setTitle] = useState(meeting.title);
  const [summary, setSummary] = useState(meeting.summary);
  const [decisions, setDecisions] = useState<MeetingDecision[]>(meeting.decisions);
  const [actions, setActions] = useState<MeetingActionItem[]>(meeting.actionItems);
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>(meeting.speakerLabels);
  const [retentionDays, setRetentionDays] = useState(meeting.retentionDays);
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set());
  const [createBoardCards, setCreateBoardCards] = useState(true);
  const [createRoutines, setCreateRoutines] = useState(false);
  const [routineAgentId, setRoutineAgentId] = useState(agents[0]?.id || '');
  const [busy, setBusy] = useState<'save' | 'outputs' | null>(null);

  const speakers = useMemo(() => [...new Set(meeting.segments.map((segment) => segment.speakerId))], [meeting.segments]);

  async function persistReview(): Promise<MeetingRecord> {
    const response = await fetch(`/api/meetings/${encodeURIComponent(meeting.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: meeting.version, title, summary, decisions, actionItems: actions, speakerLabels, retentionDays }),
    });
    const data = await response.json() as ApiPayload;
    if (!response.ok || !data.ok || !data.meeting) throw new Error(data.error || 'Could not save the meeting review');
    return data.meeting;
  }

  async function saveReview() {
    setBusy('save');
    try {
      onChanged(await persistReview());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the meeting review');
    } finally {
      setBusy(null);
    }
  }

  async function createOutputs() {
    if (!selectedActions.size || (!createBoardCards && !createRoutines)) return;
    const confirmed = await confirmDialog({
      title: 'Create selected follow-up work?',
      message: `This will create ${createBoardCards ? 'Board cards' : ''}${createBoardCards && createRoutines ? ' and ' : ''}${createRoutines ? 'durable manual Routines' : ''} for ${selectedActions.size} selected action item(s). Nothing is created until you confirm.`,
      confirmLabel: 'Create selected work',
    });
    if (!confirmed) return;
    setBusy('outputs');
    try {
      // Persist the exact edited action text/owners/dates before downstream work
      // is created. A stale review version blocks creation instead of silently
      // using the original model-generated values.
      await persistReview();
      const response = await fetch(`/api/meetings/${encodeURIComponent(meeting.id)}/outputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, actionItemIds: [...selectedActions], createBoardCards, createRoutines, routineAgentId }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not create the selected work');
      setSelectedActions(new Set());
      const refreshed = await fetch(`/api/meetings/${encodeURIComponent(meeting.id)}`, { cache: 'no-store' }).then((result) => result.json()) as ApiPayload;
      if (refreshed.meeting) onChanged(refreshed.meeting);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create the selected work');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grok-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Review</h3>
            <p className="text-xs text-muted mt-1">Edit the model output before creating any downstream work.</p>
          </div>
          <button type="button" className="grok-btn grok-btn-primary" onClick={() => void saveReview()} disabled={busy !== null || !title.trim()}>
            {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save review
          </button>
        </div>
        <label className="block text-xs text-muted">Title
          <input className="grok-input mt-1" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
        </label>
        <label className="block text-xs text-muted">Summary
          <textarea className="grok-input mt-1 min-h-28 resize-y" value={summary} onChange={(event) => setSummary(event.target.value)} />
        </label>
        <label className="block text-xs text-muted max-w-xs">Keep local audio for
          <select className="grok-input mt-1" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))}>
            <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option>
          </select>
        </label>
      </div>

      {speakers.length > 0 && (
        <div className="grok-card p-4">
          <h3 className="font-semibold mb-3">Speakers</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {speakers.map((speaker) => (
              <label key={speaker} className="text-xs text-muted">{speaker}
                <input className="grok-input mt-1" value={speakerLabels[speaker] || ''} placeholder="Add a name" onChange={(event) => setSpeakerLabels((current) => ({ ...current, [speaker]: event.target.value }))} />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="grok-card p-4">
        <h3 className="font-semibold mb-3">Decisions</h3>
        <div className="space-y-2">
          {decisions.map((decision, index) => (
            <div key={decision.id} className="flex items-start gap-2">
              <textarea className="grok-input min-h-16 resize-y" value={decision.text} aria-label={`Decision ${index + 1}`} onChange={(event) => setDecisions((current) => current.map((item) => item.id === decision.id ? { ...item, text: event.target.value } : item))} />
              {decision.start != null && <button type="button" className="grok-btn grok-btn-ghost shrink-0" onClick={() => onSeek(decision.start!)}>{timeLabel(decision.start)}</button>}
            </div>
          ))}
          {!decisions.length && <p className="text-xs text-dim">No decisions were extracted.</p>}
        </div>
      </div>

      <div className="grok-card p-4 space-y-4">
        <div>
          <h3 className="font-semibold">Action items</h3>
          <p className="text-xs text-muted mt-1">Select only the reviewed items you want to turn into work.</p>
        </div>
        {actions.map((action, index) => (
          <div key={action.id} className="rounded-lg border border-default p-3 space-y-2">
            <div className="flex items-start gap-2">
              <input type="checkbox" className="mt-2" checked={selectedActions.has(action.id)} aria-label={`Select action item ${index + 1}`} onChange={(event) => setSelectedActions((current) => { const next = new Set(current); if (event.target.checked) next.add(action.id); else next.delete(action.id); return next; })} />
              <textarea className="grok-input min-h-16 resize-y" value={action.text} aria-label={`Action item ${index + 1}`} onChange={(event) => setActions((current) => current.map((item) => item.id === action.id ? { ...item, text: event.target.value } : item))} />
              {action.start != null && <button type="button" className="grok-btn grok-btn-ghost shrink-0" onClick={() => onSeek(action.start!)}>{timeLabel(action.start)}</button>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 pl-6">
              <input className="grok-input" value={action.owner || ''} placeholder="Owner" aria-label={`Owner for action item ${index + 1}`} onChange={(event) => setActions((current) => current.map((item) => item.id === action.id ? { ...item, owner: event.target.value } : item))} />
              <input className="grok-input" value={action.due || ''} placeholder="Due date or timing" aria-label={`Due date for action item ${index + 1}`} onChange={(event) => setActions((current) => current.map((item) => item.id === action.id ? { ...item, due: event.target.value } : item))} />
            </div>
          </div>
        ))}
        {!actions.length && <p className="text-xs text-dim">No action items were extracted.</p>}
        {!!actions.length && (
          <div className="border-t border-default pt-4 space-y-3">
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={createBoardCards} onChange={(event) => setCreateBoardCards(event.target.checked)} /> Board cards</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={createRoutines} onChange={(event) => setCreateRoutines(event.target.checked)} /> Durable manual Routines</label>
            </div>
            {createRoutines && <select className="grok-input max-w-sm" value={routineAgentId} onChange={(event) => setRoutineAgentId(event.target.value)} aria-label="Routine agent"><option value="">Choose an agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>}
            <button type="button" className="grok-btn grok-btn-primary" disabled={busy !== null || selectedActions.size === 0 || (!createBoardCards && !createRoutines) || (createRoutines && !routineAgentId)} onClick={() => void createOutputs()}>
              {busy === 'outputs' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Review and confirm outputs
            </button>
          </div>
        )}
        {meeting.outputs.length > 0 && <div className="border-t border-default pt-3 text-xs text-muted">Created: {meeting.outputs.map((output) => <Link className="text-accent hover:underline ml-2" key={output.id} href={output.type === 'board_card' ? `/board?card=${encodeURIComponent(output.externalId)}` : `/routines?routine=${encodeURIComponent(output.externalId)}`}>{output.type === 'board_card' ? 'Board card' : 'Routine'}</Link>)}</div>}
      </div>
    </div>
  );
}

export function MeetingCapturePanel({ agents }: { agents: Agent[] }) {
  const searchParams = useSearchParams();
  const [meetings, setMeetings] = useState<MeetingRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState(searchParams.get('meeting') || '');
  const [title, setTitle] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [recordingUrl, setRecordingUrl] = useState('');
  const [busy, setBusy] = useState<'upload' | 'transcribe' | 'delete' | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const deepLinkAppliedRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  const recordingUrlRef = useRef('');
  const recordingBytesRef = useRef(0);
  const recordingCapReachedRef = useRef(false);

  const selected = useMemo(() => meetings?.find((meeting) => meeting.id === selectedId) || null, [meetings, selectedId]);

  const loadMeetings = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/meetings', { cache: 'no-store', signal });
      const data = await response.json() as ApiPayload;
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load meetings');
      const next = data.meetings || [];
      setMeetings(next);
      setSelectedId((current) => current && next.some((meeting) => meeting.id === current) ? current : (next[0]?.id || ''));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setMeetings([]);
      toast.error(error instanceof Error ? error.message : 'Could not load meetings');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void loadMeetings(controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [loadMeetings]);

  useEffect(() => subscribeLiveEvents(['meetings'], () => { void loadMeetings(); }), [loadMeetings]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setRecordingSeconds(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
  }, []);

  useEffect(() => {
    const seek = Number(searchParams.get('t'));
    if (deepLinkAppliedRef.current || !selected || selected.id !== searchParams.get('meeting') || !Number.isFinite(seek)) return;
    const audio = audioRef.current;
    if (!audio) return;
    const apply = () => { audio.currentTime = Math.max(0, seek); deepLinkAppliedRef.current = true; };
    if (audio.readyState >= 1) apply(); else audio.addEventListener('loadedmetadata', apply, { once: true });
    return () => audio.removeEventListener('loadedmetadata', apply);
  }, [searchParams, selected]);

  async function startRecording() {
    if (!consent || recording || typeof MediaRecorder === 'undefined') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = recordingMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recordingBytesRef.current = 0;
      recordingCapReachedRef.current = false;
      recorder.ondataavailable = (event) => {
        if (!event.data.size || recordingCapReachedRef.current) return;
        const nextBytes = recordingBytesRef.current + event.data.size;
        if (nextBytes > MAX_AUDIO_BYTES) {
          recordingCapReachedRef.current = true;
          if (recorder.state !== 'inactive') recorder.stop();
          setRecording(false);
          toast.error('Recording stopped at the 50 MB local capture limit. The bounded recording is still available to review.');
          return;
        }
        recordingBytesRef.current = nextBytes;
        chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
        const nextUrl = URL.createObjectURL(blob);
        recordingUrlRef.current = nextUrl;
        setRecordingBlob(blob);
        setRecordingUrl(nextUrl);
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      };
      recorderRef.current = recorder;
      streamRef.current = stream;
      setRecordingBlob(null);
      if (recordingUrlRef.current) {
        URL.revokeObjectURL(recordingUrlRef.current);
        recordingUrlRef.current = '';
        setRecordingUrl('');
      }
      setRecordingSeconds(0);
      recordingStartedAtRef.current = Date.now();
      setRecording(true);
      recorder.start(1_000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Microphone access failed');
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop();
    setRecording(false);
  }

  async function uploadAudio(blob: Blob, filename: string, source: 'microphone' | 'upload') {
    if (!consent) return toast.error('Confirm recording consent before uploading audio');
    if (!title.trim()) return toast.error('Add a meeting title first');
    if (!blob.size || blob.size > MAX_AUDIO_BYTES) return toast.error('Audio must be non-empty and no larger than 50 MB');
    setBusy('upload');
    try {
      const response = await fetch('/api/meetings', {
        method: 'POST',
        headers: {
          'Content-Type': blob.type,
          'x-meeting-title': encodeURIComponent(title.trim()),
          'x-meeting-source': source,
          'x-audio-filename': encodeURIComponent(filename),
          'x-retention-days': String(retentionDays),
          'x-consent-confirmed': 'true',
        },
        body: blob,
      });
      const data = await response.json() as ApiPayload;
      if (!response.ok || !data.ok || !data.meeting) throw new Error(data.error || 'Audio upload failed');
      setMeetings((current) => [data.meeting!, ...(current || []).filter((item) => item.id !== data.meeting!.id)]);
      setSelectedId(data.meeting.id);
      setRecordingBlob(null);
      if (recordingUrlRef.current) {
        URL.revokeObjectURL(recordingUrlRef.current);
        recordingUrlRef.current = '';
        setRecordingUrl('');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Audio upload failed');
    } finally {
      setBusy(null);
    }
  }

  async function transcribe() {
    if (!selected) return;
    setBusy('transcribe');
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(selected.id)}/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json() as ApiPayload;
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not start transcription');
      if (data.meeting) setMeetings((current) => current?.map((item) => item.id === data.meeting!.id ? data.meeting! : item) || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start transcription');
    } finally {
      setBusy(null);
    }
  }

  async function removeMeeting(audioOnly: boolean) {
    if (!selected) return;
    const confirmed = await confirmDialog({ title: audioOnly ? 'Delete local audio?' : 'Delete meeting?', message: audioOnly ? 'The transcript, review, citations, and created-work links remain. The recording cannot be restored.' : 'This permanently deletes the local recording and its transcript/review.', confirmLabel: audioOnly ? 'Delete audio' : 'Delete meeting', danger: true });
    if (!confirmed) return;
    setBusy('delete');
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(selected.id)}${audioOnly ? '?audioOnly=true' : ''}`, { method: 'DELETE' });
      const data = await response.json() as ApiPayload;
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not delete the meeting');
      if (audioOnly && data.meeting) setMeetings((current) => current?.map((item) => item.id === data.meeting!.id ? data.meeting! : item) || []);
      else { setMeetings((current) => current?.filter((item) => item.id !== selected.id) || []); setSelectedId(''); }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the meeting');
    } finally {
      setBusy(null);
    }
  }

  function updateSelected(next: MeetingRecord) {
    setMeetings((current) => current?.map((item) => item.id === next.id ? next : item) || [next]);
  }

  function seek(seconds: number) {
    if (!audioRef.current || !selected?.audioAvailable) return;
    audioRef.current.currentTime = seconds;
    void audioRef.current.play().catch(() => {});
  }

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2"><AudioLines size={21} /> Meetings</h1>
        <p className="text-sm text-muted mt-1">Consent-first microphone capture or audio upload, speaker-aware transcription, and reviewable follow-up work.</p>
      </div>

      <div className="grok-card p-4 border-l-2 border-l-accent space-y-3">
        <div className="flex items-start gap-3"><ShieldCheck size={19} className="text-accent shrink-0 mt-0.5" /><div><h2 className="font-semibold">Recording consent is required</h2><p className="text-xs text-muted mt-1">Shiba stores the audio locally and sends it to xAI only when you explicitly start transcription.</p></div></div>
        <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>{CONSENT_TEXT}</span></label>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <div className="grok-card p-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <label className="text-xs text-muted">Meeting title<input className="grok-input mt-1" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly product sync" maxLength={300} /></label>
              <label className="text-xs text-muted">Audio retention<select className="grok-input mt-1" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select></label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-default p-4 space-y-3">
                <div className="flex items-center gap-2 font-medium"><Mic size={17} /> Microphone</div>
                <p className="text-xs text-muted">Captures only the microphone you authorize in the browser.</p>
                <div className="flex items-center gap-2">
                  {!recording ? <button type="button" className="grok-btn grok-btn-primary" disabled={!consent || busy !== null || typeof MediaRecorder === 'undefined'} onClick={() => void startRecording()}><Play size={14} /> Start recording</button> : <button type="button" className="grok-btn grok-btn-danger" onClick={stopRecording}><Square size={13} /> Stop</button>}
                  {recording && <span className="font-mono text-sm text-error">● {timeLabel(recordingSeconds)}</span>}
                </div>
                {recordingUrl && recordingBlob && <div className="space-y-2"><audio controls className="w-full" src={recordingUrl} /><button type="button" className="grok-btn grok-btn-secondary" disabled={busy !== null} onClick={() => void uploadAudio(recordingBlob, `microphone-${Date.now()}.webm`, 'microphone')}>{busy === 'upload' ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Save recording</button></div>}
              </div>
              <div className="rounded-lg border border-default p-4 space-y-3">
                <div className="flex items-center gap-2 font-medium"><FileAudio size={17} /> Upload audio</div>
                <p className="text-xs text-muted">WebM, MP3, WAV, M4A/MP4, OGG, FLAC, AAC, or AMR, up to 50 MB.</p>
                <label className={`grok-btn grok-btn-secondary w-fit ${!consent || busy !== null ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}><Upload size={14} /> Choose audio<input type="file" className="sr-only" disabled={!consent || busy !== null} accept="audio/webm,audio/mpeg,audio/wav,audio/mp4,audio/ogg,audio/flac,audio/aac,audio/amr,.m4a" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (!file) return; const typed = new File([file], file.name, { type: inferredMime(file) }); void uploadAudio(typed, file.name, 'upload'); }} /></label>
              </div>
            </div>
            <div className="rounded-lg border border-default bg-subtle p-3 flex items-start gap-2"><Pause size={16} className="text-muted shrink-0 mt-0.5" /><div><div className="text-sm font-medium">System audio capture is not supported yet</div><p className="text-xs text-muted mt-1">Automatic meeting-app or desktop audio capture is coming later. For now, upload a mixed recording only when you have permission to record it.</p></div></div>
          </div>

          {selected && (
            <>
              <div className="grok-card p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><h2 className="font-semibold">{selected.title}</h2><div className="flex flex-wrap gap-3 mt-1 text-xs text-muted"><span>{new Date(selected.createdAt).toLocaleString()}</span><span>{(selected.audioBytes / 1024 / 1024).toFixed(1)} MB</span><span className="capitalize">{selected.status}</span><Link className="text-accent hover:underline" href={`/tasks/${encodeURIComponent(selected.taskId)}`}>Task & evidence</Link></div></div>
                  <div className="flex gap-2"><button type="button" className="grok-btn grok-btn-ghost" disabled={!selected.audioAvailable || busy !== null} onClick={() => void removeMeeting(true)}><Trash2 size={14} /> Audio</button><button type="button" className="grok-btn grok-btn-danger" disabled={busy !== null} onClick={() => void removeMeeting(false)}><Trash2 size={14} /> Meeting</button></div>
                </div>
                {selected.audioAvailable ? <audio key={selected.id} ref={audioRef} controls preload="metadata" className="w-full" src={`/api/meetings/${encodeURIComponent(selected.id)}/audio`} /> : <p className="text-xs text-muted">The local audio has been deleted; the reviewed transcript and citations remain.</p>}
                {(selected.status === 'uploaded' || selected.status === 'failed') && <button type="button" className="grok-btn grok-btn-primary" disabled={!selected.audioAvailable || busy !== null} onClick={() => void transcribe()}>{busy === 'transcribe' ? <Loader2 size={14} className="animate-spin" /> : <AudioLines size={14} />} Transcribe with xAI</button>}
                {selected.status === 'transcribing' && <div className="text-sm text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Transcribing and extracting review items…</div>}
                {selected.error && <p className="text-xs text-error">{selected.error}</p>}
              </div>

              {selected.segments.length > 0 && <div className="grok-card p-4"><h2 className="font-semibold mb-3">Timestamped transcript</h2><div className="space-y-1 max-h-[32rem] overflow-y-auto pr-1">{selected.segments.map((segment) => <div key={segment.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-lg px-2 py-2 hover:bg-hover"><button type="button" className="text-xs font-mono text-accent text-left" onClick={() => seek(segment.start)} title="Play this exact moment">{timeLabel(segment.start)}</button><div><div className="text-xs font-semibold text-muted">{selected.speakerLabels[segment.speakerId] || segment.speakerId}</div><p className="text-sm leading-relaxed mt-0.5">{segment.text}</p><Link className="text-[11px] text-dim hover:text-accent" href={segment.citationUrl}>Copyable exact citation · {segment.start.toFixed(2)}–{segment.end.toFixed(2)}s</Link></div></div>)}</div></div>}

              {selected.status === 'ready' && <ReviewEditor key={`${selected.id}:${selected.version}`} meeting={selected} agents={agents} onChanged={updateSelected} onSeek={seek} />}
            </>
          )}
        </div>

        <aside className="grok-card p-3 h-fit lg:sticky lg:top-4">
          <div className="flex items-center justify-between px-1 pb-2"><h2 className="font-semibold">Library</h2><span className="text-xs text-dim">{meetings?.length || 0}</span></div>
          {meetings === null ? <div className="data-loading-row"><span className="data-spinner" /> Loading…</div> : meetings.length ? <div className="space-y-1">{meetings.map((meeting) => <button key={meeting.id} type="button" onClick={() => setSelectedId(meeting.id)} className={`w-full rounded-lg p-3 text-left border ${meeting.id === selectedId ? 'border-accent bg-hover' : 'border-transparent hover:bg-hover'}`}><div className="font-medium text-sm truncate">{meeting.title}</div><div className="flex items-center gap-2 text-[11px] text-muted mt-1"><Clock3 size={11} /> {new Date(meeting.createdAt).toLocaleDateString()}<span className="capitalize ml-auto">{meeting.status}</span></div></button>)}</div> : <p className="text-xs text-dim p-2">No captured meetings yet.</p>}
        </aside>
      </div>
    </div>
  );
}
