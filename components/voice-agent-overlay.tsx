'use client';

/**
 * Jarvis-style floating HUD for Grok Voice mode.
 * Shows listening / thinking / speaking state with a radial core and status line.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Mic, MicOff, Volume2, X, Zap } from 'lucide-react';

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
}

const PHASE_COPY: Record<VoiceAgentPhase, { title: string; hint: string }> = {
  idle: { title: 'Standby', hint: 'Voice online — speak when ready' },
  listening: { title: 'Listening', hint: 'Speak naturally · pause to send' },
  thinking: { title: 'Processing', hint: 'Working… · speak to interrupt' },
  speaking: { title: 'Speaking', hint: 'Speak anytime to interrupt' },
};

export default function VoiceAgentOverlay({
  open,
  phase,
  voiceName = 'Grok',
  interim,
  lastHeard,
  onClose,
  onToggleMic,
  micActive,
}: VoiceAgentOverlayProps) {
  const [tick, setTick] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!open) {
      setMounted(false);
      return;
    }
    const t = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(t);
  }, [open]);

  // Gentle pulse clock for ring animations (no heavy canvas).
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(id);
  }, [open]);

  const copy = PHASE_COPY[phase];
  const caption = useMemo(() => {
    // Show live transcript during barge-in (thinking / speaking) as well as listening.
    if (interim?.trim() && (phase === 'listening' || phase === 'speaking' || phase === 'thinking')) {
      return phase === 'listening' ? `“${interim.trim()}”` : `Interrupting… “${interim.trim()}”`;
    }
    if (phase === 'listening' && lastHeard?.trim()) return `Heard: “${lastHeard.trim()}”`;
    if (phase === 'thinking') return lastHeard?.trim() ? `Re: “${lastHeard.trim()}”` : copy.hint;
    return copy.hint;
  }, [phase, interim, lastHeard, copy.hint]);

  if (!open) return null;

  const ringScale = phase === 'speaking'
    ? 1 + 0.06 * Math.sin(tick / 2.2)
    : phase === 'listening'
      ? 1 + 0.04 * Math.sin(tick / 3)
      : phase === 'thinking'
        ? 1 + 0.03 * Math.sin(tick / 1.6)
        : 1;

  return (
    <div
      className={`voice-jarvis-root ${mounted ? 'voice-jarvis-mounted' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label="Grok Voice assistant"
    >
      <div className="voice-jarvis-backdrop" onClick={onClose} aria-hidden>
        <div className="voice-jarvis-stars voice-jarvis-stars-far" />
        <div className="voice-jarvis-stars voice-jarvis-stars-near" />
      </div>

      <div className="voice-jarvis-panel">
        <div className="voice-jarvis-panel-stars" aria-hidden />
        <div className="voice-jarvis-chrome">
          <div className="voice-jarvis-brand">
            <Zap size={12} className="voice-jarvis-brand-icon" />
            <span>GROK VOICE</span>
            <span className="voice-jarvis-voice-tag">{voiceName}</span>
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
            <div className="voice-jarvis-core-face">
              {phase === 'speaking' ? (
                <Volume2 size={28} />
              ) : phase === 'listening' ? (
                <Mic size={28} />
              ) : phase === 'thinking' ? (
                <span className="voice-jarvis-core-spin" />
              ) : (
                <Zap size={26} />
              )}
            </div>
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

        <div className="voice-jarvis-footer">
          <span className="voice-jarvis-hint">Pause briefly to send · Esc or ✕ to exit</span>
        </div>
      </div>
    </div>
  );
}
