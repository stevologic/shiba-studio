/**
 * Cross-page Grok Voice UI + binding state.
 * Engine lives in the chat panel for the bound session; this store keeps the
 * HUD alive and freezes that session while navigating other tabs.
 */
'use client';

export type VoiceAgentPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

type Listener = () => void;

type VoiceAgentUiState = {
  /** Grok Voice mode is on (engine running in chat panel). */
  active: boolean;
  /** Full HUD vs docked sidebar control. */
  minimized: boolean;
  /** Chat session id the voice engine is bound to (null when off). */
  boundSessionId: string | null;
  phase: VoiceAgentPhase;
  /** Display name (Grok voice catalog name, or speaking agent name in group mode). */
  voiceName: string;
  interim: string;
  lastHeard: string;
  micActive: boolean;
  /** Multi-agent voice group is active (All agents + Grok Voice). */
  groupMode?: boolean;
  /** Live speech rate multiplier (xAI TTS 0.7–1.5). */
  speechSpeed: number;
};

const listeners = new Set<Listener>();

const LS_AUTO = 'shiba-tts-auto';
const LS_SESSION = 'shiba-tts-session';

let state: VoiceAgentUiState = {
  active: false,
  minimized: false,
  boundSessionId: null,
  phase: 'idle',
  voiceName: 'Grok',
  interim: '',
  lastHeard: '',
  micActive: false,
  groupMode: false,
  speechSpeed: 1,
};

/** Callbacks registered by the chat panel (engine). */
let onCloseVoice: (() => void) | null = null;
let onToggleMic: (() => void) | null = null;
let onSetSpeechSpeed: ((speed: number) => void) | null = null;

function emit() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function getVoiceAgentUiState(): VoiceAgentUiState {
  return state;
}

export function subscribeVoiceAgentUi(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function patchVoiceAgentUi(partial: Partial<VoiceAgentUiState>) {
  state = { ...state, ...partial };
  emit();
}

export function setVoiceAgentActive(active: boolean, boundSessionId?: string | null) {
  if (active) {
    const sid = boundSessionId ?? state.boundSessionId;
    if (state.active && state.boundSessionId === sid) return;
    state = {
      ...state,
      active: true,
      boundSessionId: sid ?? null,
    };
    emit();
    return;
  }
  if (!state.active && !state.minimized && !state.boundSessionId) return;
  state = {
    ...state,
    active: false,
    minimized: false,
    boundSessionId: null,
    phase: 'idle',
    interim: '',
    micActive: false,
  };
  emit();
}

export function setVoiceAgentMinimized(minimized: boolean) {
  if (!state.active) return;
  if (state.minimized === minimized) return;
  state = { ...state, minimized };
  emit();
}

export function registerVoiceAgentHandlers(handlers: {
  onClose: () => void;
  onToggleMic: () => void;
  onSetSpeechSpeed?: (speed: number) => void;
}) {
  onCloseVoice = handlers.onClose;
  onToggleMic = handlers.onToggleMic;
  onSetSpeechSpeed = handlers.onSetSpeechSpeed || null;
  return () => {
    // Only clear if still our handlers (avoid clobbering a remounted panel).
    if (onCloseVoice === handlers.onClose) onCloseVoice = null;
    if (onToggleMic === handlers.onToggleMic) onToggleMic = null;
    if (onSetSpeechSpeed === handlers.onSetSpeechSpeed) onSetSpeechSpeed = null;
  };
}

export function invokeVoiceAgentClose() {
  onCloseVoice?.();
}

export function invokeVoiceAgentToggleMic() {
  onToggleMic?.();
}

/** Apply speech speed via the chat engine when bound; always patches HUD state. */
export function invokeVoiceAgentSetSpeechSpeed(speed: number) {
  const n = Number(speed);
  const clamped = Number.isFinite(n)
    ? Math.min(1.5, Math.max(0.7, Math.round(n * 100) / 100))
    : 1;
  if (onSetSpeechSpeed) {
    onSetSpeechSpeed(clamped);
  } else {
    // No engine mounted — still update HUD + localStorage for next session.
    state = { ...state, speechSpeed: clamped };
    try {
      window.localStorage.setItem('shiba-tts-speed', String(clamped));
    } catch { /* private mode */ }
    emit();
  }
}

/** Persist whether voice should resume only for this session after a soft reload. */
export function persistVoiceSessionBinding(on: boolean, sessionId: string | null | undefined) {
  try {
    if (on && sessionId) {
      window.localStorage.setItem(LS_AUTO, '1');
      window.localStorage.setItem(LS_SESSION, sessionId);
    } else {
      window.localStorage.setItem(LS_AUTO, '0');
      window.localStorage.removeItem(LS_SESSION);
    }
  } catch {
    /* private mode */
  }
}

/** Whether localStorage says voice should resume for this session only. */
export function shouldRestoreVoiceForSession(sessionId: string | null | undefined): boolean {
  if (!sessionId || typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem(LS_AUTO) !== '1') return false;
    return window.localStorage.getItem(LS_SESSION) === sessionId;
  } catch {
    return false;
  }
}

/**
 * End voice if it is bound to a different session (chat switch / new chat).
 * Returns true if voice was active and closed.
 */
export function endVoiceIfSessionChanges(nextSessionId: string | null | undefined): boolean {
  const bound = state.boundSessionId;
  if (!state.active || !bound) return false;
  if (nextSessionId && nextSessionId === bound) return false;
  // Prefer the engine handler (stops mic/TTS + clears local state).
  if (onCloseVoice) {
    onCloseVoice();
  } else {
    setVoiceAgentActive(false);
    persistVoiceSessionBinding(false, null);
  }
  return true;
}
