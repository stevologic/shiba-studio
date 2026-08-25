/**
 * Live Meetings + Grok Voice 2.0 session mint.
 *
 * The meeting engine stays the brain (visuals, Board, minutes). Voice 2.0 is
 * the ears and mouth: the browser talks to xAI with an ephemeral token so the
 * cloud API key never leaves the host. Live Meeting audio is not stored —
 * only the existing text turn contract reaches SQLite.
 */

import { DEFAULT_TTS_VOICE } from './xai-tts';
import {
  GROK_VOICE_CLIENT_SECRETS_URL,
  GROK_VOICE_MODEL,
  GROK_VOICE_SAMPLE_RATE,
  GROK_VOICE_TOKEN_TTL_SECONDS,
  grokVoiceRealtimeUrl,
} from './grok-voice';
import type { LiveMeetingRecord } from './live-meeting-types';
import { loadConfig } from './persistence';
import { fetchCloudWithAuth, resolveCloudBearer } from './xai-oauth';

export class LiveMeetingVoiceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'LiveMeetingVoiceError';
    this.status = status;
  }
}

export interface LiveMeetingVoiceSecret {
  token: string;
  expiresAt: number;
}

export interface LiveMeetingVoiceSessionConfig {
  voice: string;
  instructions: string;
  turn_detection: {
    type: 'server_vad';
    threshold: number;
    silence_duration_ms: number;
    prefix_padding_ms: number;
    create_response: boolean;
  };
  audio: {
    input: {
      format: { type: 'audio/pcm'; rate: number };
      transcription: { language_hint: string; keyterms: string[] };
    };
    output: {
      format: { type: 'audio/pcm'; rate: number };
      speed: number;
    };
  };
}

export interface LiveMeetingVoiceSession {
  model: string;
  url: string;
  token: string;
  expiresAt: number;
  voice: string;
  session: LiveMeetingVoiceSessionConfig;
}

export function parseRealtimeClientSecret(payload: unknown): LiveMeetingVoiceSecret {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const nested = root.client_secret && typeof root.client_secret === 'object'
    ? root.client_secret as Record<string, unknown>
    : null;
  const nestedValue = nested && typeof nested.value === 'string' ? nested.value : '';
  const rootSecret = typeof root.client_secret === 'string' ? root.client_secret : '';
  const token = String(root.value || rootSecret || nestedValue || root.token || root.secret || '').trim();
  if (!token) throw new LiveMeetingVoiceError('xAI did not return an ephemeral voice token', 502);

  const rawExpiry = Number(root.expires_at ?? nested?.expires_at ?? 0);
  let expiresAt = Date.now() + GROK_VOICE_TOKEN_TTL_SECONDS * 1000;
  if (Number.isFinite(rawExpiry) && rawExpiry > 1_000_000_000_000) expiresAt = rawExpiry;
  else if (Number.isFinite(rawExpiry) && rawExpiry > 1_000_000_000) expiresAt = rawExpiry * 1000;
  return { token, expiresAt };
}

export function liveMeetingVoiceKeyterms(meeting: Pick<LiveMeetingRecord, 'agentName' | 'projectName' | 'focus' | 'title'>): string[] {
  const terms = [
    'Shiba Studio',
    'Board',
    meeting.agentName,
    meeting.projectName,
    meeting.title,
    ...String(meeting.focus || '').split(/[^A-Za-z0-9._-]+/),
  ]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term.length <= 50);
  return [...new Set(terms)].slice(0, 40);
}

/**
 * Voice-model instructions follow xAI's recommended second-person H2 order.
 * The studio still drives replies with `force_message`; this prompt is the
 * safety net if server VAD starts a model turn anyway.
 */
export function buildLiveMeetingVoiceInstructions(input: {
  agentName: string;
  projectName: string;
  focus: string;
}): string {
  const who = input.agentName.trim() || 'the project engineer';
  const project = input.projectName.trim() || 'the workspace';
  const focus = input.focus.trim();
  return [
    '## Role & Persona',
    `You are ${who}, a senior engineer in a Shiba Studio project review with the creator about ${project}.`,
    'You sound like a colleague in the room: concrete, calm, and brief.',
    '',
    '## Objective',
    'Help the creator review the work. Speak only prepared review lines from the studio. Do not invent a second reply after the creator talks.',
    ...(focus ? [`The agreed focus is: ${focus}`] : []),
    '',
    '## Conversation Flow',
    'Wait for the creator. If a turn starts without a prepared studio line, say only a short check-in such as "One moment." then stop.',
    'Yield immediately when the creator starts talking.',
    '',
    '## Guardrails & Escalation',
    'NEVER invent files, commits, code, or Board cards.',
    'Give no medical, legal, or financial advice.',
    'If input is empty or garbled, ask one short clarification instead of guessing.',
    'If the creator mentions self-harm or a medical emergency, respond with care and tell them to contact local emergency services or 988 in the US.',
    '',
    '## Voice & Communication Style',
    'Spoken word only: no markdown, no bullet lists, no emoji, no stage directions.',
    'One or two short sentences. Respond only in English.',
    'Vary phrasing. Do not repeat the same sentence twice.',
    '',
    '## CRITICAL INSTRUCTIONS',
    'NEVER answer the creator yourself. The studio speaks your turns with force_message.',
    'If a model turn starts without a prepared line, say only "One moment."',
    'ALWAYS stay interruptible. Stop the instant the creator talks.',
  ].join('\n');
}

export function buildLiveMeetingVoiceSessionConfig(input: {
  voice: string;
  instructions: string;
  keyterms: string[];
}): LiveMeetingVoiceSessionConfig {
  return {
    voice: input.voice.trim().toLowerCase() || DEFAULT_TTS_VOICE,
    instructions: input.instructions,
    turn_detection: {
      type: 'server_vad',
      threshold: 0.7,
      silence_duration_ms: 700,
      prefix_padding_ms: 300,
      // OpenAI-compatible hint. If xAI honors it, the voice model will not
      // ad-lib after VAD. The client still cancels unexpected responses.
      create_response: false,
    },
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: GROK_VOICE_SAMPLE_RATE },
        transcription: { language_hint: 'en', keyterms: input.keyterms },
      },
      output: {
        format: { type: 'audio/pcm', rate: GROK_VOICE_SAMPLE_RATE },
        speed: 1,
      },
    },
  };
}

export async function mintLiveMeetingVoiceSession(input: {
  meeting: LiveMeetingRecord;
  voice?: string;
}): Promise<LiveMeetingVoiceSession> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.hasCloudAuth || !auth.token) {
    throw new LiveMeetingVoiceError(
      'Connect an xAI API key or OAuth in Settings to use Grok Voice 2.0',
      503,
    );
  }

  const response = await fetchCloudWithAuth(GROK_VOICE_CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_after: { seconds: GROK_VOICE_TOKEN_TTL_SECONDS } }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LiveMeetingVoiceError(
      `Could not start Grok Voice 2.0 (${response.status}): ${detail.slice(0, 200)}`,
      502,
    );
  }

  const secret = parseRealtimeClientSecret(await response.json());
  const voice = String(input.voice || cfg.defaultTtsVoice || DEFAULT_TTS_VOICE).toLowerCase() || DEFAULT_TTS_VOICE;
  const session = buildLiveMeetingVoiceSessionConfig({
    voice,
    instructions: buildLiveMeetingVoiceInstructions({
      agentName: input.meeting.agentName,
      projectName: input.meeting.projectName,
      focus: input.meeting.focus,
    }),
    keyterms: liveMeetingVoiceKeyterms(input.meeting),
  });

  return {
    model: GROK_VOICE_MODEL,
    url: grokVoiceRealtimeUrl(),
    token: secret.token,
    expiresAt: secret.expiresAt,
    voice,
    session,
  };
}
