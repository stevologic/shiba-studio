'use client';

/**
 * Minimized Grok Voice control docked in the left sidebar nav.
 * Full HUD still renders from VoiceAgentHost when expanded.
 */
import React, { useSyncExternalStore } from 'react';
import { Maximize2, Mic, MicOff, RotateCcw, Square, Volume2, X, Zap } from 'lucide-react';
import {
  getVoiceAgentUiState,
  invokeVoiceAgentClose,
  invokeVoiceAgentRepeatLast,
  invokeVoiceAgentStopResponse,
  invokeVoiceAgentToggleMic,
  setVoiceAgentMinimized,
  subscribeVoiceAgentUi,
} from '@/lib/voice-agent-ui-store';

export default function VoiceAgentNavDock({
  navCollapsed = false,
}: {
  navCollapsed?: boolean;
}) {
  const ui = useSyncExternalStore(
    subscribeVoiceAgentUi,
    getVoiceAgentUiState,
    getVoiceAgentUiState,
  );

  if (!ui.active || !ui.minimized) return null;

  const phase = ui.phase;
  const phaseTitle =
    phase === 'listening'
      ? 'Listening'
      : phase === 'thinking'
        ? 'Processing'
        : phase === 'speaking'
          ? 'Speaking'
          : 'Standby';

  const PhaseIcon =
    phase === 'speaking' ? Volume2 : phase === 'listening' ? Mic : phase === 'thinking' ? Zap : Zap;

  const caption = ui.interim?.trim() || ui.lastHeard?.trim() || '';

  if (navCollapsed) {
    return (
      <div className="voice-nav-dock voice-nav-dock-collapsed">
        <button
          type="button"
          className={`voice-nav-dock-icon-btn voice-nav-dock-phase-${phase}`}
          onClick={() => setVoiceAgentMinimized(false)}
          title={`Grok Voice · ${phaseTitle} — expand`}
          aria-label={`Expand Grok Voice (${phaseTitle})`}
        >
          <PhaseIcon size={18} />
          <span className="voice-nav-dock-pulse" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`voice-nav-dock voice-nav-dock-phase-${phase}`}
      role="status"
      aria-live="polite"
      aria-label={`Grok Voice ${phaseTitle}${caption ? `: ${caption}` : ''}`}
    >
      <button
        type="button"
        className="voice-nav-dock-main"
        onClick={() => setVoiceAgentMinimized(false)}
        title="Expand Grok Voice"
      >
        <span className="voice-nav-dock-core">
          <PhaseIcon size={15} />
        </span>
        <span className="voice-nav-dock-copy">
          <span className="voice-nav-dock-brand">
            <Zap size={10} />
            {ui.groupMode ? 'Voice group' : 'Grok Voice'}
          </span>
          <span className="voice-nav-dock-phase">{phaseTitle}</span>
          {caption ? (
            <span className="voice-nav-dock-caption">
              “{caption.length > 36 ? `${caption.slice(0, 36)}…` : caption}”
            </span>
          ) : null}
        </span>
      </button>
      <div className="voice-nav-dock-actions">
        <button
          type="button"
          className="voice-nav-dock-action"
          onClick={() => invokeVoiceAgentRepeatLast()}
          disabled={!ui.canRepeat}
          title={ui.canRepeat ? 'Repeat last reply' : 'No completed reply to repeat yet'}
          aria-label="Repeat last reply"
        >
          <RotateCcw size={13} />
        </button>
        <button
          type="button"
          className="voice-nav-dock-action"
          onClick={() => invokeVoiceAgentStopResponse()}
          disabled={phase !== 'thinking' && phase !== 'speaking'}
          title={phase === 'thinking' || phase === 'speaking' ? 'Stop response' : 'No active response to stop'}
          aria-label="Stop response"
        >
          <Square size={12} />
        </button>
        <button
          type="button"
          className="voice-nav-dock-action"
          onClick={() => invokeVoiceAgentToggleMic()}
          title={ui.micActive ? 'Pause microphone' : 'Resume microphone'}
          aria-label={ui.micActive ? 'Pause microphone' : 'Resume microphone'}
        >
          {ui.micActive ? <Mic size={13} /> : <MicOff size={13} />}
        </button>
        <button
          type="button"
          className="voice-nav-dock-action"
          onClick={() => setVoiceAgentMinimized(false)}
          title="Expand"
          aria-label="Expand Grok Voice"
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          className="voice-nav-dock-action voice-nav-dock-action-exit"
          onClick={() => invokeVoiceAgentClose()}
          title="Exit voice mode"
          aria-label="Exit voice mode"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
