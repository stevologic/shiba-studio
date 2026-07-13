'use client';

/**
 * Jarvis-style HUD for Grok Voice mode.
 * Full HUD when expanded; minimized control docks in the left nav.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Mic, MicOff, Minimize2, RotateCcw, Square, Volume2, X, Zap } from 'lucide-react';
import { GROK_TTS_SPEEDS, clampTtsSpeed, DEFAULT_TTS_SPEED } from '@/lib/xai-tts';

export type VoiceAgentPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceAgentOverlayProps {
  open: boolean;
  phase: VoiceAgentPhase;
  voiceName?: string;
  /** Live interim transcript while listening */
  interim?: string;
  /** Last committed user phrase (optional caption) */
  lastHeard?: string;
  onClose: () => void;
  /** Mute / stop listening without fully exiting voice mode */
  onToggleMic?: () => void;
  micActive?: boolean;
  minimized?: boolean;
  onMinimizedChange?: (minimized: boolean) => void;
  /** Multi-agent voice circle (All agents + Grok Voice) */
  groupMode?: boolean;
  /** Current speech rate (0.7–1.5) */
  speechSpeed?: number;
  /** Live change speech rate (applies to next utterance) */
  onSpeechSpeedChange?: (speed: number) => void;
  /** A completed reply exists and can be replayed without another model call. */
  canRepeat?: boolean;
  /** Generation or speech is active and can be stopped. */
  canStop?: boolean;
  onRepeatLast?: () => void;
  onStopResponse?: () => void;
}

const PHASE_COPY: Record<VoiceAgentPhase, { title: string; hint: string }> = {
  idle: { title: 'Standby', hint: 'Voice online — speak when ready' },
  listening: { title: 'Listening', hint: 'Speak naturally · pause to send' },
  thinking: { title: 'Processing', hint: 'Working… · just start talking to interrupt' },
  speaking: { title: 'Speaking', hint: 'Just start talking to interrupt' },
};

function phaseCopy(phase: VoiceAgentPhase, groupMode?: boolean, speaker?: string) {
  if (groupMode) {
    if (phase === 'listening') {
      return { title: 'Listening', hint: 'Agents keep the discussion going if you stay quiet' };
    }
    if (phase === 'thinking') {
      return { title: speaker ? `${speaker} thinking` : 'Agent thinking', hint: 'Group table — just start talking to jump in' };
    }
    if (phase === 'speaking') {
      return { title: speaker ? speaker : 'Agent speaking', hint: 'Just start talking to interrupt' };
    }
    return { title: 'Group voice', hint: 'Multi-agent table — stay quiet and they continue' };
  }
  return PHASE_COPY[phase];
}

export default function VoiceAgentOverlay({
  open,
  phase,
  voiceName = 'Grok',
  interim,
  lastHeard,
  onClose,
  onToggleMic,
  micActive,
  minimized = false,
  onMinimizedChange,
  groupMode = false,
  speechSpeed = DEFAULT_TTS_SPEED,
  onSpeechSpeedChange,
  canRepeat = false,
  canStop = false,
  onRepeatLast,
  onStopResponse,
}: VoiceAgentOverlayProps) {
  const [tick, setTick] = useState(0);
  const [mounted, setMounted] = useState(false);
  const speed = clampTtsSpeed(speechSpeed);
  const speedLabel = GROK_TTS_SPEEDS.find((s) => Math.abs(s.value - speed) < 0.01)?.label
    || `${speed}×`;

  /** Click the speed chip to cycle: 0.75 → 0.9 → 1 → 1.15 → 1.25 → 1.5 → … */
  function cycleSpeed() {
    if (!onSpeechSpeedChange) return;
    const vals = GROK_TTS_SPEEDS.map((s) => s.value);
    const idx = vals.findIndex((v) => Math.abs(v - speed) < 0.01);
    const base = idx >= 0 ? idx : vals.indexOf(DEFAULT_TTS_SPEED);
    const next = vals[(base + 1) % vals.length];
    onSpeechSpeedChange(next);
  }

  const speedHint = GROK_TTS_SPEEDS.find((s) => Math.abs(s.value - speed) < 0.01)?.hint || 'Normal';

  useEffect(() => {
    // rAF in both branches — the compiler lint forbids synchronous setState
    // directly in the effect body.
    const t = requestAnimationFrame(() => setMounted(open));
    return () => cancelAnimationFrame(t);
  }, [open]);

  // Gentle pulse clock for ring animations (no heavy canvas).
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(id);
  }, [open]);

  const copy = phaseCopy(phase, groupMode, voiceName);
  const caption = useMemo(() => {
    if (interim?.trim() && (phase === 'listening' || phase === 'speaking' || phase === 'thinking')) {
      return phase === 'listening' ? `“${interim.trim()}”` : `Interrupting… “${interim.trim()}”`;
    }
    if (phase === 'listening' && lastHeard?.trim()) return `Heard: “${lastHeard.trim()}”`;
    if (phase === 'thinking') return lastHeard?.trim() ? `${lastHeard.trim()}` : copy.hint;
    if (phase === 'speaking' && groupMode && voiceName) {
      return `${voiceName} is speaking · ${copy.hint}`;
    }
    return copy.hint;
  }, [phase, interim, lastHeard, copy.hint, voiceName, groupMode]);

  if (!open) return null;

  const ringScale = phase === 'speaking'
    ? 1 + 0.06 * Math.sin(tick / 2.2)
    : phase === 'listening'
      ? 1 + 0.04 * Math.sin(tick / 3)
      : phase === 'thinking'
        ? 1 + 0.03 * Math.sin(tick / 1.6)
        : 1;

  const phaseIcon =
    phase === 'speaking' ? (
      <Volume2 size={minimized ? 16 : 28} />
    ) : phase === 'listening' ? (
      <Mic size={minimized ? 16 : 28} />
    ) : phase === 'thinking' ? (
      <span className={minimized ? 'voice-jarvis-core-spin voice-jarvis-core-spin-sm' : 'voice-jarvis-core-spin'} />
    ) : (
      <Zap size={minimized ? 16 : 26} />
    );

  // Minimized UI lives in the left sidebar (VoiceAgentNavDock), not a floating pill.
  if (minimized) return null;

  // ── Full HUD ──
  return (
    <div
      className={`voice-jarvis-root ${mounted ? 'voice-jarvis-mounted' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label="Grok Voice assistant"
    >
      {/* Backdrop does not steal the page — click minimizes so you can keep working */}
      <div
        className="voice-jarvis-backdrop"
        onClick={() => onMinimizedChange?.(true)}
        aria-hidden
      >
        <div className="voice-jarvis-stars voice-jarvis-stars-far" />
        <div className="voice-jarvis-stars voice-jarvis-stars-near" />
      </div>

      <div className="voice-jarvis-panel" onClick={(e) => e.stopPropagation()}>
        <div className="voice-jarvis-panel-stars" aria-hidden />
        <div className="voice-jarvis-chrome">
          <div className="voice-jarvis-brand">
            <Zap size={12} className="voice-jarvis-brand-icon" />
            <span>{groupMode ? 'VOICE GROUP' : 'GROK VOICE'}</span>
            <span className="voice-jarvis-voice-tag">{voiceName}</span>
            {onSpeechSpeedChange ? (
              <button
                type="button"
                className="voice-jarvis-voice-tag voice-jarvis-speed-tag voice-jarvis-speed-chip"
                onClick={cycleSpeed}
                title={`Speech speed ${speedLabel} (${speedHint}) — click to change`}
                aria-label={`Speech speed ${speedLabel}. Click to cycle.`}
              >
                {speedLabel}
              </button>
            ) : (
              <span className="voice-jarvis-voice-tag voice-jarvis-speed-tag" title="Speech speed">
                {speedLabel}
              </span>
            )}
          </div>
          <div className="voice-jarvis-chrome-actions">
            {onToggleMic && (
              <button
                type="button"
                className="voice-jarvis-icon-btn"
                onClick={onToggleMic}
                title={micActive ? 'Pause microphone' : 'Resume microphone'}
                aria-label={micActive ? 'Pause microphone' : 'Resume microphone'}
              >
                {micActive ? <Mic size={14} /> : <MicOff size={14} />}
              </button>
            )}
            <button
              type="button"
              className="voice-jarvis-icon-btn"
              onClick={() => onMinimizedChange?.(true)}
              title="Minimize — keep voice on while you browse"
              aria-label="Minimize Grok Voice"
            >
              <Minimize2 size={14} />
            </button>
            <button
              type="button"
              className="voice-jarvis-icon-btn"
              onClick={onClose}
              title="Exit voice mode"
              aria-label="Exit voice mode"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className={`voice-jarvis-stage voice-jarvis-phase-${phase}`}>
          <div className="voice-jarvis-ring voice-jarvis-ring-outer" style={{ transform: `scale(${ringScale})` }} />
          <div className="voice-jarvis-ring voice-jarvis-ring-mid" />
          <div className="voice-jarvis-ring voice-jarvis-ring-inner" />

          <div className="voice-jarvis-ticks" aria-hidden>
            {Array.from({ length: 24 }).map((_, i) => (
              <span
                key={i}
                className="voice-jarvis-tick"
                style={{ transform: `rotate(${i * 15}deg) translateY(-72px)` }}
              />
            ))}
          </div>

          <div className="voice-jarvis-core">
            <div className="voice-jarvis-core-glow" />
            <div className="voice-jarvis-core-face">{phaseIcon}</div>
          </div>

          {(phase === 'speaking' || phase === 'listening') && (
            <div className="voice-jarvis-eq" aria-hidden>
              {Array.from({ length: 7 }).map((_, i) => (
                <span
                  key={i}
                  className="voice-jarvis-eq-bar"
                  style={{
                    animationDelay: `${i * 0.08}s`,
                    height: `${10 + ((tick + i * 3) % 7) * 3}px`,
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="voice-jarvis-status">
          <div className={`voice-jarvis-phase-label voice-jarvis-phase-label-${phase}`}>
            <span className="voice-jarvis-phase-dot" />
            {copy.title}
          </div>
          <div className="voice-jarvis-caption" title={caption}>
            {caption}
          </div>
        </div>

        <div className="voice-jarvis-controls" role="toolbar" aria-label="Voice response controls">
          <button
            type="button"
            className="voice-jarvis-control-btn"
            onClick={onRepeatLast}
            disabled={!canRepeat}
            title={canRepeat ? 'Replay the last completed reply from the beginning' : 'No completed reply to repeat yet'}
            aria-label="Repeat last reply"
          >
            <RotateCcw size={14} />
            Repeat last reply
          </button>
          <button
            type="button"
            className="voice-jarvis-control-btn"
            onClick={onStopResponse}
            disabled={!canStop}
            title={canStop ? 'Stop the current answer and keep voice mode listening' : 'No active response to stop'}
            aria-label="Stop response"
          >
            <Square size={13} />
            Stop response
          </button>
        </div>

        <div className="voice-jarvis-footer">
          <span className="voice-jarvis-hint">
            {onSpeechSpeedChange
              ? `Click ${speedLabel} to change speed · applies to next reply · Esc exits`
              : 'Minimize docks in the left nav · Esc exits'}
          </span>
        </div>
      </div>
    </div>
  );
}
