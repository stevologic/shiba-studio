/**
 * Grok Voice 2.0 (Speech-to-Speech) constants.
 * https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
 *
 * `grok-voice-latest` has pointed at `grok-voice-think-fast-2.0` since
 * 2026-08-05. Meetings pins the versioned name so a later alias bump cannot
 * silently change the room, and still documents the alias for operators.
 */

export const GROK_VOICE_MODEL = 'grok-voice-think-fast-2.0';
export const GROK_VOICE_MODEL_ALIAS = 'grok-voice-latest';
export const GROK_VOICE_SAMPLE_RATE = 24_000;
export const GROK_VOICE_TOKEN_TTL_SECONDS = 300;
export const GROK_VOICE_CLIENT_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';
export const GROK_VOICE_REALTIME_PATH = 'wss://api.x.ai/v1/realtime';

export function grokVoiceRealtimeUrl(model = GROK_VOICE_MODEL): string {
  return `${GROK_VOICE_REALTIME_PATH}?model=${encodeURIComponent(model)}`;
}

export function grokVoiceBrowserProtocol(token: string): string {
  return `xai-client-secret.${token}`;
}
