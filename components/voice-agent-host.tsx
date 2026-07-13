'use client';

/**
 * Root-layout host for Grok Voice HUD so minimize + navigate work site-wide.
 * Engine (mic/TTS) stays in the chat panel; this only renders the overlay.
 */
import React, { useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import {
  getVoiceAgentUiState,
  invokeVoiceAgentClose,
  invokeVoiceAgentRepeatLast,
  invokeVoiceAgentSetSpeechSpeed,
  invokeVoiceAgentStopResponse,
  invokeVoiceAgentToggleMic,
  setVoiceAgentMinimized,
  subscribeVoiceAgentUi,
} from '@/lib/voice-agent-ui-store';

const VoiceAgentOverlay = dynamic(() => import('@/components/voice-agent-overlay'), {
  ssr: false,
});

export default function VoiceAgentHost() {
  const ui = useSyncExternalStore(
    subscribeVoiceAgentUi,
    getVoiceAgentUiState,
    getVoiceAgentUiState,
  );

  if (!ui.active) return null;

  return (
    <VoiceAgentOverlay
      open={ui.active}
      phase={ui.phase}
      voiceName={ui.voiceName}
      interim={ui.interim}
      lastHeard={ui.lastHeard}
      micActive={ui.micActive}
      minimized={ui.minimized}
      groupMode={!!ui.groupMode}
      speechSpeed={ui.speechSpeed ?? 1}
      canRepeat={ui.canRepeat}
      canStop={ui.phase === 'thinking' || ui.phase === 'speaking'}
      onSpeechSpeedChange={(speed) => invokeVoiceAgentSetSpeechSpeed(speed)}
      onRepeatLast={() => invokeVoiceAgentRepeatLast()}
      onStopResponse={() => invokeVoiceAgentStopResponse()}
      onMinimizedChange={setVoiceAgentMinimized}
      onToggleMic={() => invokeVoiceAgentToggleMic()}
      onClose={() => invokeVoiceAgentClose()}
    />
  );
}
