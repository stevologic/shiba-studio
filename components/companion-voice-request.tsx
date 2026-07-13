'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './companion-app.module.css';

const MAX_VOICE_BYTES = 50 * 1024 * 1024;

export interface CompanionVoiceRequestSummary {
  id: string;
  status: 'pending' | 'completed' | 'failed';
  result: {
    status?: string;
    title?: string;
    taskId?: string;
    error?: string;
  };
  createdAt: string;
  completedAt?: string;
}

interface CompanionVoiceRequestProps {
  deviceKey: string;
  secureContext: boolean | null;
  requests: CompanionVoiceRequestSummary[];
  onAccepted: () => Promise<void>;
}

function preferredMime(): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

function elapsedLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function requestStatus(request: CompanionVoiceRequestSummary): string {
  if (request.status === 'failed') return 'Failed';
  if (request.result.status === 'dispatched') return 'Started';
  if (request.result.status === 'dispatching') return 'Starting';
  if (request.result.status === 'transcribing') return 'Transcribing';
  if (request.result.status === 'uploading') return 'Uploading';
  return request.status === 'pending' ? 'Processing' : 'Completed';
}

export function CompanionVoiceRequest({ deviceKey, secureContext, requests, onAccepted }: CompanionVoiceRequestProps) {
  const [title, setTitle] = useState('');
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordedBytesRef = useRef(0);
  const startedAtRef = useRef(0);
  const audioUrlRef = useRef('');
  const microphoneAvailable = secureContext === true
    && typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== 'undefined'
    && Boolean(globalThis.crypto?.subtle);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1_000)), 250);
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
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  }, []);

  async function startRecording() {
    if (!consent || !microphoneAvailable || recording) return;
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recordedBytesRef.current = 0;
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        chunksRef.current.push(event.data);
        recordedBytesRef.current += event.data.size;
        if (recordedBytesRef.current > MAX_VOICE_BYTES && recorder.state !== 'inactive') {
          setError('Recording reached the 50 MB limit. Record a shorter request.');
          setRecording(false);
          recorder.stop();
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size > MAX_VOICE_BYTES) {
          setAudio(null);
          stream.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          return;
        }
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        const nextUrl = URL.createObjectURL(blob);
        audioUrlRef.current = nextUrl;
        setAudio(blob);
        setAudioUrl(nextUrl);
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      };
      recorderRef.current = recorder;
      streamRef.current = stream;
      setAudio(null);
      setIdempotencyKey(`voice-${crypto.randomUUID()}`);
      setElapsed(0);
      startedAtRef.current = Date.now();
      setRecording(true);
      recorder.start(1_000);
    } catch (recordingError) {
      setError(recordingError instanceof Error ? recordingError.message : 'Microphone access failed');
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop();
    setRecording(false);
  }

  async function sendVoiceRequest() {
    if (!audio || !consent || !idempotencyKey || busy) return;
    if (audio.size > MAX_VOICE_BYTES) {
      setError('Recording exceeds the 50 MB limit. Record a shorter request.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const digest = await crypto.subtle.digest('SHA-256', await audio.arrayBuffer());
      const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
      const response = await fetch('/api/companion/voice', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deviceKey}`,
          'Content-Type': audio.type,
          'x-audio-bytes': String(audio.size),
          'x-audio-sha256': sha256,
          'x-idempotency-key': idempotencyKey,
          'x-recording-consent': 'true',
          'x-voice-title': encodeURIComponent(title.trim() || 'Voice request'),
        },
        body: audio,
      });
      const payload = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Voice request could not be accepted');
      setAudio(null);
      setAudioUrl('');
      setConsent(false);
      setTitle('');
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = '';
      }
      await onAccepted();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Voice request could not be sent');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${styles.section} ${styles.sectionWide}`} aria-labelledby="voice-request-title">
      <div className={`${styles.sectionHeader} ${styles.between}`}>
        <h2 className={styles.sectionTitle} id="voice-request-title">Voice request</h2>
        <span className={styles.badge}>1-day local audio</span>
      </div>
      <article className={styles.card}>
        <p className={styles.muted}>Record a request, review it, then send it to the host for transcription and durable task creation. Raw audio stays on the host and is removed after one day.</p>
        {secureContext === false ? <p className={styles.voiceNotice}>Microphone recording requires HTTPS, such as Tailscale Serve. It is unavailable on an insecure LAN page.</p> : null}
        <label className={styles.field}>Optional request title
          <input className={styles.input} value={title} maxLength={160} placeholder="Follow up with the launch team" onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className={styles.voiceConsent}>
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          <span>I confirm that everyone required has consented to this recording, and I am responsible for applicable recording laws.</span>
        </label>
        <div className={styles.actions}>
          {!recording ? (
            <button className={styles.button} type="button" disabled={!consent || !microphoneAvailable || busy} onClick={() => void startRecording()}>Start recording</button>
          ) : (
            <button className={styles.danger} type="button" onClick={stopRecording}>Stop · {elapsedLabel(elapsed)}</button>
          )}
        </div>
        {audio && audioUrl ? (
          <div className={styles.voicePreview}>
            <audio controls src={audioUrl} />
            <button className={styles.secondary} type="button" disabled={!consent || busy} onClick={() => void sendVoiceRequest()}>{busy ? 'Sending…' : 'Send voice request'}</button>
          </div>
        ) : null}
        {error ? <p className={styles.voiceError} role="alert">{error}</p> : null}
      </article>
      {requests.length ? (
        <div className={styles.list} aria-label="Recent voice requests">
          {requests.map((request) => (
            <article className={styles.card} key={request.id}>
              <div className={styles.between}>
                <h3 className={styles.cardTitle}>{request.result.title || 'Voice request'}</h3>
                <span className={request.status === 'failed' ? styles.severity : styles.badge}>{requestStatus(request)}</span>
              </div>
              <p className={styles.meta}>{new Date(request.createdAt).toLocaleString()}</p>
              {request.result.error ? <p className={styles.voiceError}>{request.result.error}</p> : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
