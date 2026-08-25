'use client';

/**
 * Browser Grok Voice 2.0 session for Live Meetings.
 *
 * Connects with an ephemeral token (never an xAI API key), streams 24 kHz
 * PCM from getUserMedia, plays assistant PCM, and speaks engine `say` text
 * via interruptible `force_message`. Unexpected voice-model replies are
 * cancelled so the meeting engine stays the only author of agent turns.
 */

import { grokVoiceBrowserProtocol } from './grok-voice';
import type { LiveMeetingVoiceSession } from './live-meeting-voice';

export type LiveMeetingVoiceTransport = 'none' | 'connecting' | 'grok' | 'legacy';

export interface LiveMeetingVoiceClientHandlers {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onInterim?: (text: string) => void;
  onUserTranscript?: (text: string) => void;
  onSpeechStarted?: () => void;
  onSpeaking?: (speaking: boolean) => void;
  onError?: (message: string) => void;
}

interface VoiceSessionResponse {
  ok?: boolean;
  available?: boolean;
  error?: string;
  model?: string;
  url?: string;
  token?: string;
  expiresAt?: number;
  voice?: string;
  session?: LiveMeetingVoiceSession['session'];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  if (!Number.isFinite(ratio) || ratio <= 0) return input;
  const output = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let index = 0; index < output.length; index++) {
    output[index] = input[Math.min(input.length - 1, Math.floor(index * ratio))];
  }
  return output;
}

function floatToPcm16Bytes(input: Float32Array): Uint8Array {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index++) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

function decodePcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

function eventTranscript(event: Record<string, unknown>): string {
  const direct = event.transcript ?? event.text;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const nested = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : null;
  if (typeof nested?.transcript === 'string' && nested.transcript.trim()) return nested.transcript.trim();
  const content = Array.isArray(nested?.content) ? nested.content : Array.isArray(event.content) ? event.content : [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    const text = record.transcript ?? record.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

class PcmPlayer {
  private context: AudioContext | null = null;
  private nextTime = 0;
  private sources: AudioBufferSourceNode[] = [];
  private endedTimer: number | null = null;
  private onEnded: (() => void) | null = null;

  constructor(private readonly sampleRate: number) {}

  setEndedListener(listener: (() => void) | null): void {
    this.onEnded = listener;
  }

  async ensure(): Promise<AudioContext> {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext({ sampleRate: this.sampleRate });
      this.nextTime = 0;
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context;
  }

  async push(pcm: Int16Array): Promise<void> {
    if (!pcm.length) return;
    const context = await this.ensure();
    const floats = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index++) floats[index] = pcm[index] / 32768;
    const buffer = context.createBuffer(1, floats.length, this.sampleRate);
    buffer.getChannelData(0).set(floats);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((item) => item !== source);
      this.armEnded();
    };
    this.armEnded();
  }

  stop(): void {
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources = [];
    this.nextTime = 0;
    if (this.endedTimer != null) {
      window.clearTimeout(this.endedTimer);
      this.endedTimer = null;
    }
  }

  close(): void {
    this.stop();
    if (this.context && this.context.state !== 'closed') void this.context.close();
    this.context = null;
  }

  private armEnded(): void {
    if (this.endedTimer != null) window.clearTimeout(this.endedTimer);
    const remainingMs = Math.max(80, (this.nextTime - (this.context?.currentTime || 0)) * 1000 + 40);
    this.endedTimer = window.setTimeout(() => {
      this.endedTimer = null;
      if (!this.sources.length) this.onEnded?.();
    }, remainingMs);
  }
}

export class LiveMeetingVoiceClient {
  private ws: WebSocket | null = null;
  private session: VoiceSessionResponse | null = null;
  private capture: { stream: MediaStream; context: AudioContext; processor: ScriptProcessorNode } | null = null;
  private readonly player: PcmPlayer;
  private muted = false;
  private closed = false;
  private forceMessageActive = false;
  private speaking = false;

  constructor(
    private readonly meetingId: string,
    private readonly sampleRate: number,
    private readonly handlers: LiveMeetingVoiceClientHandlers = {},
  ) {
    this.player = new PcmPlayer(sampleRate);
    this.player.setEndedListener(() => this.setSpeaking(false));
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(voice?: string): Promise<void> {
    if (this.closed) throw new Error('Voice session already closed');
    const micPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: this.sampleRate,
      },
    });

    const response = await fetch(`/api/live-meetings/${encodeURIComponent(this.meetingId)}/voice-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(voice ? { voice } : {}),
    });
    const payload = await response.json().catch(() => ({})) as VoiceSessionResponse;
    if (!response.ok || !payload.token || !payload.url || !payload.session) {
      try { (await micPromise).getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
      throw new Error(payload.error || 'Grok Voice 2.0 is unavailable');
    }
    this.session = payload;

    const stream = await micPromise;
    if (this.closed) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Voice session already closed');
    }
    await this.startCapture(stream);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(payload.url!, [grokVoiceBrowserProtocol(payload.token!)]);
      this.ws = ws;
      const fail = (error: Error) => {
        if (this.ws === ws) this.ws = null;
        reject(error);
      };
      ws.onopen = () => {
        this.send({ type: 'session.update', session: payload.session });
        this.handlers.onConnected?.();
        resolve();
      };
      ws.onerror = () => fail(new Error('Grok Voice 2.0 connection failed'));
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.handlers.onDisconnected?.();
        }
      };
      ws.onmessage = (message) => {
        if (typeof message.data !== 'string') return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(message.data) as Record<string, unknown>; }
        catch { return; }
        this.handleEvent(event);
      };
    });
  }

  speak(text: string): void {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned || !this.connected) return;
    this.forceMessageActive = true;
    this.setSpeaking(true);
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'force_message',
        role: 'assistant',
        interruptible: true,
        content: [{ type: 'output_text', text: cleaned }],
      },
    });
  }

  cancelPlayback(): void {
    this.forceMessageActive = false;
    this.player.stop();
    this.setSpeaking(false);
    if (this.connected) this.send({ type: 'response.cancel' });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.capture) return;
    for (const track of this.capture.stream.getAudioTracks()) track.enabled = !muted;
  }

  close(): void {
    this.closed = true;
    this.cancelPlayback();
    this.player.close();
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    if (this.capture) {
      try { this.capture.processor.disconnect(); } catch { /* already disconnected */ }
      try { this.capture.context.close(); } catch { /* already closed */ }
      this.capture.stream.getTracks().forEach((track) => track.stop());
      this.capture = null;
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.handlers.onSpeaking?.(speaking);
  }

  private async startCapture(stream: MediaStream): Promise<void> {
    const context = new AudioContext({ sampleRate: this.sampleRate });
    if (context.state === 'suspended') await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (this.muted || !this.connected) return;
      const input = downsample(event.inputBuffer.getChannelData(0), context.sampleRate, this.sampleRate);
      this.send({
        type: 'input_audio_buffer.append',
        audio: bytesToBase64(floatToPcm16Bytes(input)),
      });
    };
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    this.capture = { stream, context, processor };
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = String(event.type || '');
    switch (type) {
      case 'input_audio_buffer.speech_started':
        this.handlers.onSpeechStarted?.();
        this.cancelPlayback();
        break;
      case 'conversation.item.input_audio_transcription.delta':
      case 'input_audio_transcription.delta':
        this.handlers.onInterim?.(eventTranscript(event));
        break;
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.input_audio_transcription.done':
      case 'input_audio_transcription.completed': {
        const spoken = eventTranscript(event);
        this.handlers.onInterim?.('');
        if (spoken) this.handlers.onUserTranscript?.(spoken);
        break;
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const audio = typeof event.delta === 'string' ? event.delta : '';
        if (audio) {
          this.setSpeaking(true);
          void this.player.push(decodePcm16(audio));
        }
        break;
      }
      case 'response.created':
        if (!this.forceMessageActive) this.send({ type: 'response.cancel' });
        break;
      case 'response.done':
      case 'response.output_audio.done':
        this.forceMessageActive = false;
        break;
      case 'error': {
        const message = String(event.message || event.error || 'Grok Voice 2.0 error');
        if (!/cancel/i.test(message)) this.handlers.onError?.(message);
        break;
      }
      default:
        break;
    }
  }
}
