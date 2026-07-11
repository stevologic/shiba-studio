/**
 * Acoustic voice-activity detection for barge-in (Grok-voice style).
 *
 * The old interrupt trigger waited for ~2s of continuously *transcribed* words
 * from the Web Speech API while TTS played over it — recognition barely hears
 * anything during playback and its results arrive in bursts, so interruption
 * effectively never fired. Real voice assistants trigger on the microphone
 * SIGNAL instead: an echo-cancelled mic stream (the browser's AEC subtracts
 * the assistant's own speaker output) watched for sustained voice energy.
 * Speech onset is detected within ~250ms and the caller pauses TTS instantly;
 * the speech recognizer then only has to CONFIRM words in silence, which it
 * is good at.
 *
 * Split in two so the decision logic is unit-testable without a browser:
 *   - createVadDetector(): pure state machine fed (rms, now) samples.
 *   - startVoiceVad(): WebAudio plumbing that feeds the detector.
 */
'use client';

export interface VadDetectorOptions {
  /** Continuous energy must persist this long before firing. */
  minSpeechMs?: number;
  /** Brief dips below threshold shorter than this don't reset the onset. */
  dropoutMs?: number;
  /** Quiet time required before the detector re-arms for the next utterance. */
  rearmMs?: number;
  /** Threshold = max(absMin, noiseFloor * ratio). */
  ratio?: number;
  /** Absolute RMS floor — below this is never treated as speech. */
  absMin?: number;
  /** Starting noise-floor estimate (adapts while quiet). */
  initialNoiseFloor?: number;
}

export interface VadDetector {
  /** Feed one RMS sample; returns true exactly when speech onset fires. */
  push(rms: number, now: number): boolean;
  /** Current adaptive threshold (for tests/diagnostics). */
  readonly threshold: number;
}

/** Pure speech-onset state machine over an RMS sample stream. */
export function createVadDetector(opts: VadDetectorOptions = {}): VadDetector {
  const minSpeechMs = opts.minSpeechMs ?? 200;
  const dropoutMs = opts.dropoutMs ?? 150;
  const rearmMs = opts.rearmMs ?? 450;
  const ratio = opts.ratio ?? 2.4;
  const absMin = opts.absMin ?? 0.012;

  let noiseFloor = opts.initialNoiseFloor ?? 0.01;
  let speechStartedAt = 0;
  let lastAboveAt = 0;
  let firedForUtterance = false;

  return {
    push(rms: number, now: number): boolean {
      const threshold = Math.max(absMin, noiseFloor * ratio);
      if (rms >= threshold) {
        lastAboveAt = now;
        if (!speechStartedAt) speechStartedAt = now;
        if (!firedForUtterance && now - speechStartedAt >= minSpeechMs) {
          firedForUtterance = true;
          return true;
        }
        return false;
      }
      // Learn the room while nobody is talking (slow EMA).
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      if (speechStartedAt && now - lastAboveAt > dropoutMs) {
        speechStartedAt = 0;
      }
      if (firedForUtterance && now - lastAboveAt > rearmMs) {
        firedForUtterance = false;
        speechStartedAt = 0;
      }
      return false;
    },
    get threshold() {
      return Math.max(absMin, noiseFloor * ratio);
    },
  };
}

export interface VoiceVadOptions extends VadDetectorOptions {
  /** Sustained speech onset detected (fires once per utterance). */
  onSpeechStart: () => void;
}

export interface VoiceVadHandle {
  stop: () => void;
  /** True when the mic stream + analyser are live. */
  readonly running: boolean;
}

const TICK_MS = 30;

export async function startVoiceVad(opts: VoiceVadOptions): Promise<VoiceVadHandle | null> {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // AEC is the whole trick: the assistant's own TTS is subtracted from
        // the mic signal, so only the human's voice raises the energy.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch {
    return null; // caller falls back to transcript-based interrupts
  }

  const Ctx = window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) {
    for (const t of stream.getTracks()) t.stop();
    return null;
  }
  const ctx = new Ctx();
  try { await ctx.resume(); } catch { /* gesture-gated; ticks handle suspended */ }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const detector = createVadDetector(opts);
  let stopped = false;

  const timer = window.setInterval(() => {
    if (stopped || ctx.state !== 'running') return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (detector.push(rms, Date.now())) {
      try { opts.onSpeechStart(); } catch { /* listener error is not ours */ }
    }
  }, TICK_MS);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      window.clearInterval(timer);
      try { source.disconnect(); } catch { /* already gone */ }
      for (const t of stream.getTracks()) {
        try { t.stop(); } catch { /* already gone */ }
      }
      void ctx.close().catch(() => { /* already closed */ });
    },
    get running() {
      return !stopped;
    },
  };
}
