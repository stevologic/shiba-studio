/** xAI Text-to-Speech helpers — https://api.x.ai/v1/tts */

export const XAI_TTS_URL = 'https://api.x.ai/v1/tts';
export const XAI_TTS_VOICES_URL = 'https://api.x.ai/v1/tts/voices';

/** Built-in Grok voices (fallback when the live catalog is unavailable). */
export const GROK_TTS_VOICES: Array<{ id: string; name: string; description: string }> = [
  { id: 'eve', name: 'Eve', description: 'Warm default — clear and natural' },
  { id: 'ara', name: 'Ara', description: 'Friendly and conversational' },
  { id: 'leo', name: 'Leo', description: 'Steady and professional' },
  { id: 'rex', name: 'Rex', description: 'Confident and clear' },
  { id: 'sal', name: 'Sal', description: 'Smooth and balanced' },
  { id: 'carina', name: 'Carina', description: 'Soft, empathetic, soothing' },
];

export const DEFAULT_TTS_VOICE = 'eve';

/** xAI TTS speed range is 0.7–1.5 (1.0 = normal). */
export const TTS_SPEED_MIN = 0.7;
export const TTS_SPEED_MAX = 1.5;
export const DEFAULT_TTS_SPEED = 1;

export const GROK_TTS_SPEEDS: Array<{ value: number; label: string; hint: string }> = [
  { value: 0.75, label: '0.75×', hint: 'Slower' },
  { value: 0.9, label: '0.9×', hint: 'Slightly slow' },
  { value: 1, label: '1×', hint: 'Normal' },
  { value: 1.15, label: '1.15×', hint: 'Slightly fast' },
  { value: 1.25, label: '1.25×', hint: 'Faster' },
  { value: 1.5, label: '1.5×', hint: 'Fastest' },
];

export function clampTtsSpeed(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TTS_SPEED;
  return Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, Math.round(n * 100) / 100));
}

/**
 * Remove emojis / pictographs so TTS never verbalizes them
 * ("smiling face", "thumbs up", etc.). Natural language only.
 */
export function stripEmojisForSpeech(raw: string): string {
  let t = String(raw || '');
  try {
    // Full emoji sequences (ZWJ, VS16, skin tones, flags, keycaps)
    t = t.replace(
      /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu,
      ' ',
    );
    // Regional indicator pairs (flags) if not already covered
    t = t.replace(/(?:\p{Regional_Indicator}){2}/gu, ' ');
    // Skin-tone modifiers left behind
    t = t.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
    // Variation selectors / combining enclosures often used with emoji
    t = t.replace(/[\uFE0E\uFE0F\u20E3]/g, '');
    // Misc symbol blocks that models often drop as "emoji" and TTS mangles
    t = t.replace(/[\u{2600}-\u{27BF}]/gu, ' ');
    t = t.replace(/[\u{1F000}-\u{1FAFF}]/gu, ' ');
    t = t.replace(/[\u{1F900}-\u{1F9FF}]/gu, ' ');
  } catch {
    // Environments without Unicode property escapes — best-effort BMP strip
    t = t.replace(
      /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]/g,
      ' ',
    );
  }
  return t;
}

/** Strip markdown / code fences / emoji so spoken audio stays natural language. */
export function textForSpeech(raw: string, maxChars = 12_000): string {
  let t = String(raw || '');
  // Drop fenced code blocks (read poorly aloud)
  t = t.replace(/```[\s\S]*?```/g, ' ');
  // Inline code
  t = t.replace(/`([^`]+)`/g, '$1');
  // Images / links
  t = t.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Headings / emphasis / quotes
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/[*_~]{1,3}/g, '');
  t = t.replace(/^>\s?/gm, '');
  // HTML-ish remnants
  t = t.replace(/<[^>]+>/g, ' ');
  // Emoji / pictographs — never spoken
  t = stripEmojisForSpeech(t);
  // Collapse whitespace (including leftover spaces from emoji removal)
  t = t.replace(/\s+/g, ' ').trim();
  // Tidy "word !" → "word!" after emoji gaps
  t = t.replace(/\s+([,.;:!?)}\]])/g, '$1');
  if (t.length > maxChars) t = `${t.slice(0, maxChars).trim()}…`;
  return t;
}

/**
 * Pull the next speakable utterance from the front of `text` for progressive TTS.
 * Returns null until we have a complete sentence (or a long enough clause).
 * minChars: wait until at least this many chars before speaking mid-stream.
 * maxChars: hard cap for a single TTS request (lower = faster first audio).
 */
export function takeNextUtterance(
  text: string,
  opts?: { minChars?: number; maxChars?: number; allowPartial?: boolean },
): string | null {
  const t = String(text || '').replace(/^\s+/, '');
  if (!t) return null;
  const minChars = opts?.minChars ?? 36;
  const maxChars = opts?.maxChars ?? 220;
  const allowPartial = opts?.allowPartial ?? false;

  // Prefer a complete sentence ending.
  const sentence = t.match(/^[\s\S]{12,}?[.!?…](?:["')\]]+)?(?=\s|$)/);
  if (sentence && sentence[0].trim().length >= Math.min(minChars, 24)) {
    return sentence[0].trim();
  }

  // Clause break after min length (comma / semicolon / newline-ish).
  if (t.length >= minChars) {
    const window = t.slice(0, maxChars);
    const clause = window.match(/^[\s\S]{24,}?[,;:](?:\s|$)/);
    if (clause) return clause[0].trim();
  }

  // Force a chunk once we have enough text (or stream finished).
  if (t.length >= maxChars || (allowPartial && t.length >= minChars)) {
    const window = t.slice(0, maxChars);
    const sp = window.lastIndexOf(' ');
    return (sp > minChars * 0.6 ? window.slice(0, sp) : window).trim() || null;
  }
  return null;
}

/** Split full reply into sequential TTS chunks (used after stream completes). */
export function splitSpeechChunks(raw: string, maxChunk = 280): string[] {
  const clean = textForSpeech(raw);
  if (!clean) return [];
  const out: string[] = [];
  let rest = clean;
  while (rest) {
    const next = takeNextUtterance(rest, { minChars: 1, maxChars: maxChunk, allowPartial: true });
    if (!next) break;
    out.push(next);
    rest = rest.slice(rest.indexOf(next) + next.length).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}
