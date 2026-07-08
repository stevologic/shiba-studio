import { NextRequest, NextResponse } from 'next/server';
import {
  DEFAULT_TTS_VOICE,
  GROK_TTS_VOICES,
  stripEmojisForSpeech,
  textForSpeech,
  XAI_TTS_URL,
  XAI_TTS_VOICES_URL,
} from '@/lib/xai-tts';
import { loadConfig } from '@/lib/persistence';
import { resolveCloudBearer } from '@/lib/xai-oauth';

export async function GET() {
  try {
    const cfg = await loadConfig();
    const auth = await resolveCloudBearer(cfg);
    if (!auth.token) {
      return NextResponse.json({
        ok: true,
        source: 'fallback',
        voices: GROK_TTS_VOICES,
        defaultVoice: DEFAULT_TTS_VOICE,
      });
    }
    try {
      const res = await fetch(XAI_TTS_VOICES_URL, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (res.ok) {
        const data = await res.json() as {
          voices?: Array<{ voice_id?: string; id?: string; name?: string; description?: string }>;
        };
        const voices = (data.voices || [])
          .map((v) => ({
            id: String(v.voice_id || v.id || '').toLowerCase(),
            name: String(v.name || v.voice_id || v.id || 'Voice'),
            description: String(v.description || ''),
          }))
          .filter((v) => v.id);
        if (voices.length) {
          return NextResponse.json({
            ok: true,
            source: 'xai',
            voices,
            defaultVoice: DEFAULT_TTS_VOICE,
          });
        }
      }
    } catch {
      /* fall through to built-ins */
    }
    return NextResponse.json({
      ok: true,
      source: 'fallback',
      voices: GROK_TTS_VOICES,
      defaultVoice: DEFAULT_TTS_VOICE,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to list voices' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    // Voice mode passes short chunks already cleaned of markdown; still strip
    // emojis so TTS never verbalizes pictographs ("smiling face", etc.).
    const raw = String(body.text || '');
    const text = body.preprocessed
      ? stripEmojisForSpeech(raw).replace(/\s+/g, ' ').trim()
      : textForSpeech(raw);
    if (!text) {
      return NextResponse.json({ error: 'No speakable text' }, { status: 400 });
    }
    const voiceId = String(body.voice_id || body.voiceId || DEFAULT_TTS_VOICE).toLowerCase() || DEFAULT_TTS_VOICE;
    const language = String(body.language || 'en');
    // fast=true → lower bitrate / sample rate + streaming latency hint for voice agent.
    const fast = body.fast === true || body.fast === 1 || body.fast === 'true';

    const cfg = await loadConfig();
    const auth = await resolveCloudBearer(cfg);
    if (!auth.token) {
      return NextResponse.json(
        { error: 'Cloud credentials required for Grok voices (API key or OAuth).' },
        { status: 401 },
      );
    }

    const payload: Record<string, unknown> = {
      text,
      voice_id: voiceId,
      language,
      // Skip extra normalization pass in voice chat (saves latency).
      text_normalization: body.text_normalization === true,
      output_format: fast
        ? { codec: 'mp3', sample_rate: 22050, bit_rate: 64000 }
        : {
            codec: 'mp3',
            sample_rate: 24000,
            bit_rate: 128000,
          },
    };
    // xAI supports optimize_streaming_latency for lower time-to-first-audio.
    if (fast || body.optimize_streaming_latency != null) {
      payload.optimize_streaming_latency = Number(body.optimize_streaming_latency ?? 2);
    }

    const res = await fetch(XAI_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Retry once without optimize flag if the server rejects it.
      if (payload.optimize_streaming_latency != null && res.status === 400) {
        delete payload.optimize_streaming_latency;
        const retry = await fetch(XAI_TTS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (retry.ok) {
          const bytes = new Uint8Array(await retry.arrayBuffer());
          return new NextResponse(bytes, {
            status: 200,
            headers: {
              'Content-Type': retry.headers.get('content-type') || 'audio/mpeg',
              'Cache-Control': 'no-store',
              'X-Voice-Id': voiceId,
            },
          });
        }
      }
      return NextResponse.json(
        { error: `xAI TTS failed (${res.status}): ${detail.slice(0, 300)}` },
        { status: res.status >= 400 && res.status < 600 ? res.status : 502 },
      );
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-Voice-Id': voiceId,
      },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'TTS failed' },
      { status: 500 },
    );
  }
}
