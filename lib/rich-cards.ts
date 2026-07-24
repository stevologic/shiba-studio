/**
 * Rich cards — a small library of structured data displays agents can embed in
 * ANY markdown they produce (Grok chat replies, meeting stage visuals, run
 * output). A fenced code block with language `shiba-card` holding one JSON
 * object renders as a card instead of code; malformed payloads fall back to a
 * plain code block, so the mechanism can never lose content.
 *
 * Pure and dependency-free: safe to import from client components, server
 * modules, and verify scripts alike.
 */

export interface RichStatEntry {
  label: string;
  value: string;
  /** Small delta annotation next to the value (e.g. "+12%"). */
  delta?: string;
  tone?: 'up' | 'down' | 'flat';
}

export interface RichStatsCard {
  kind: 'stats';
  title?: string;
  stats: RichStatEntry[];
}

export interface RichProgressItem {
  label: string;
  /** 0–100. */
  percent: number;
  note?: string;
}

export interface RichProgressCard {
  kind: 'progress';
  title?: string;
  items: RichProgressItem[];
}

export type RichChecklistState = 'done' | 'active' | 'pending' | 'blocked';

export interface RichChecklistItem {
  text: string;
  state: RichChecklistState;
  note?: string;
}

export interface RichChecklistCard {
  kind: 'checklist';
  title?: string;
  items: RichChecklistItem[];
}

export type RichTimelineState = 'done' | 'active' | 'pending';

export interface RichTimelineItem {
  label: string;
  date?: string;
  state?: RichTimelineState;
  note?: string;
}

export interface RichTimelineCard {
  kind: 'timeline';
  title?: string;
  items: RichTimelineItem[];
}

export type RichCalloutTone = 'info' | 'success' | 'warning' | 'error';

export interface RichCalloutCard {
  kind: 'callout';
  tone: RichCalloutTone;
  title: string;
  body?: string;
}

export interface RichMediaCard {
  kind: 'media';
  title?: string;
  /** https://, data:image/, or a same-origin absolute path (/...). */
  src: string;
  alt?: string;
  body?: string;
  /** Where the image sits relative to the text. */
  layout?: 'left' | 'right' | 'top';
}

export interface RichSparklineSeries {
  label: string;
  /** 2–60 samples, oldest → newest. */
  values: number[];
  /** Headline text for the latest reading (e.g. "8 runs"). */
  value?: string;
  tone?: 'up' | 'down' | 'flat';
}

export interface RichSparklineCard {
  kind: 'sparkline';
  title?: string;
  series: RichSparklineSeries[];
}

export interface RichBarItem {
  label: string;
  /** Non-negative magnitude; bars scale to the largest item. */
  value: number;
  note?: string;
}

export interface RichBarsCard {
  kind: 'bars';
  title?: string;
  /** Unit suffix shown after values (e.g. "runs", "$"). */
  unit?: string;
  items: RichBarItem[];
}

export interface RichTimechartSeries {
  label: string;
  /** Y samples aligned with `x`; null = gap in the line. 2–120 points. */
  values: Array<number | null>;
}

export interface RichTimechartCard {
  kind: 'timechart';
  title?: string;
  xLabel?: string;
  yLabel?: string;
  /** Optional X tick labels (dates, iteration numbers); defaults to 1..n. */
  x?: string[];
  /** Up to 4 series, direct-labeled at the line ends. */
  series: RichTimechartSeries[];
}

export type RichCard =
  | RichStatsCard
  | RichProgressCard
  | RichChecklistCard
  | RichTimelineCard
  | RichCalloutCard
  | RichMediaCard
  | RichSparklineCard
  | RichBarsCard
  | RichTimechartCard;

/** The fence language that marks a card payload inside markdown. */
export const RICH_CARD_FENCE = 'shiba-card';

const MAX_ITEMS = 12;

function text(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function items<T>(raw: unknown, map: (entry: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ITEMS).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const mapped = map(entry as Record<string, unknown>);
    return mapped == null ? [] : [mapped];
  });
}

/**
 * Parse + normalize one card payload. Returns null for anything that is not a
 * well-formed card — callers then render the original fence as plain code.
 */
export function parseRichCard(raw: string): RichCard | null {
  let payload: unknown;
  try {
    payload = JSON.parse(String(raw || '').trim());
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const title = text(value.title, 200) || undefined;

  if (value.kind === 'stats') {
    const stats = items<RichStatEntry>(value.stats, (entry) => {
      const label = text(entry.label, 120);
      const statValue = text(entry.value, 60);
      if (!label || !statValue) return null;
      const tone = entry.tone === 'up' || entry.tone === 'down' || entry.tone === 'flat' ? entry.tone : undefined;
      const delta = text(entry.delta, 40) || undefined;
      return { label, value: statValue, ...(delta ? { delta } : {}), ...(tone ? { tone } : {}) };
    });
    return stats.length ? { kind: 'stats', ...(title ? { title } : {}), stats } : null;
  }

  if (value.kind === 'progress') {
    const rows = items<RichProgressItem>(value.items, (entry) => {
      const label = text(entry.label, 160);
      const percent = Number(entry.percent);
      if (!label || !Number.isFinite(percent)) return null;
      const note = text(entry.note, 200) || undefined;
      return { label, percent: Math.max(0, Math.min(100, Math.round(percent))), ...(note ? { note } : {}) };
    });
    return rows.length ? { kind: 'progress', ...(title ? { title } : {}), items: rows } : null;
  }

  if (value.kind === 'checklist') {
    const rows = items<RichChecklistItem>(value.items, (entry) => {
      const textValue = text(entry.text, 300);
      if (!textValue) return null;
      const state: RichChecklistState = entry.state === 'done' || entry.state === 'active' || entry.state === 'blocked'
        ? entry.state
        : 'pending';
      const note = text(entry.note, 200) || undefined;
      return { text: textValue, state, ...(note ? { note } : {}) };
    });
    return rows.length ? { kind: 'checklist', ...(title ? { title } : {}), items: rows } : null;
  }

  if (value.kind === 'timeline') {
    const rows = items<RichTimelineItem>(value.items, (entry) => {
      const label = text(entry.label, 200);
      if (!label) return null;
      const state = entry.state === 'done' || entry.state === 'active' || entry.state === 'pending' ? entry.state : undefined;
      const date = text(entry.date, 60) || undefined;
      const note = text(entry.note, 200) || undefined;
      return { label, ...(date ? { date } : {}), ...(state ? { state } : {}), ...(note ? { note } : {}) };
    });
    return rows.length ? { kind: 'timeline', ...(title ? { title } : {}), items: rows } : null;
  }

  if (value.kind === 'media') {
    const src = text(value.src, 300_000);
    // https, inline data images, and same-origin absolute paths only — no
    // javascript:, no protocol-relative //host, no plain http downgrade risk
    // beyond what chat images already allow.
    const safeSrc = /^https?:\/\/[^\s]+$/i.test(src) || /^data:image\//i.test(src) || (/^\/[^/]/.test(src));
    if (!src || !safeSrc) return null;
    const body = text(value.body, 4_000) || undefined;
    const alt = text(value.alt, 300) || undefined;
    const layout = value.layout === 'right' || value.layout === 'top' ? value.layout : 'left';
    return { kind: 'media', ...(title ? { title } : {}), src, ...(alt ? { alt } : {}), ...(body ? { body } : {}), layout };
  }

  if (value.kind === 'sparkline') {
    const series = items<RichSparklineSeries>(value.series, (entry) => {
      const label = text(entry.label, 120);
      if (!label) return null;
      const values = (Array.isArray(entry.values) ? entry.values : [])
        // null/undefined are gaps, not zeros — only numbers and numeric
        // strings survive.
        .map((sample) => (typeof sample === 'number' ? sample
          : typeof sample === 'string' && sample.trim() !== '' ? Number(sample) : NaN))
        .filter((sample) => Number.isFinite(sample))
        .slice(0, 60);
      if (values.length < 2) return null;
      const tone = entry.tone === 'up' || entry.tone === 'down' || entry.tone === 'flat' ? entry.tone : undefined;
      const headline = text(entry.value, 60) || undefined;
      return { label, values, ...(headline ? { value: headline } : {}), ...(tone ? { tone } : {}) };
    });
    return series.length ? { kind: 'sparkline', ...(title ? { title } : {}), series } : null;
  }

  if (value.kind === 'bars') {
    const rows = items<RichBarItem>(value.items, (entry) => {
      const label = text(entry.label, 160);
      const barValue = Number(entry.value);
      if (!label || !Number.isFinite(barValue) || barValue < 0) return null;
      const note = text(entry.note, 200) || undefined;
      return { label, value: barValue, ...(note ? { note } : {}) };
    });
    const unit = text(value.unit, 30) || undefined;
    return rows.length ? { kind: 'bars', ...(title ? { title } : {}), ...(unit ? { unit } : {}), items: rows } : null;
  }

  if (value.kind === 'timechart') {
    const MAX_POINTS = 120;
    // Validate first, then cap: an unplottable series must not consume one of
    // the four fixed categorical hue slots.
    const series = (Array.isArray(value.series) ? value.series : []).slice(0, 16).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as Record<string, unknown>;
      const label = text(row.label, 120);
      if (!label) return [];
      const values = (Array.isArray(row.values) ? row.values : []).slice(0, MAX_POINTS).map((sample) => {
        if (sample == null) return null;
        const numeric = typeof sample === 'number' ? sample
          : typeof sample === 'string' && sample.trim() !== '' ? Number(sample) : NaN;
        return Number.isFinite(numeric) ? numeric : null;
      });
      return values.filter((sample) => sample != null).length >= 2 ? [{ label, values }] : [];
    }).slice(0, 4);
    if (!series.length) return null;
    const x = (Array.isArray(value.x) ? value.x : []).slice(0, MAX_POINTS).map((tick) => text(tick, 24));
    const xLabel = text(value.xLabel, 60) || undefined;
    const yLabel = text(value.yLabel, 60) || undefined;
    return {
      kind: 'timechart',
      ...(title ? { title } : {}),
      ...(xLabel ? { xLabel } : {}),
      ...(yLabel ? { yLabel } : {}),
      ...(x.length ? { x } : {}),
      series,
    };
  }

  if (value.kind === 'callout') {
    const calloutTitle = text(value.title, 300);
    if (!calloutTitle) return null;
    const tone: RichCalloutTone = value.tone === 'success' || value.tone === 'warning' || value.tone === 'error'
      ? value.tone
      : 'info';
    const body = text(value.body, 4_000) || undefined;
    return { kind: 'callout', tone, title: calloutTitle, ...(body ? { body } : {}) };
  }

  return null;
}

/**
 * Compact instruction block teaching a model the card fence. Appended to chat
 * and meeting system prompts so every agent surface can use cards.
 */
export const RICH_CARD_PROMPT = [
  'Rich cards: inside any markdown you write, a fenced code block with language "shiba-card" containing ONE JSON object renders as a visual card. Prefer a card over prose or a table when it genuinely reads better. Kinds:',
  '{"kind":"stats","title":"...","stats":[{"label":"...","value":"...","delta":"+12%","tone":"up|down|flat"}]} — KPI tiles.',
  '{"kind":"progress","title":"...","items":[{"label":"...","percent":0-100,"note":"..."}]} — progress bars.',
  '{"kind":"checklist","title":"...","items":[{"text":"...","state":"done|active|pending|blocked","note":"..."}]} — work states.',
  '{"kind":"timeline","title":"...","items":[{"label":"...","date":"...","state":"done|active|pending","note":"..."}]} — milestones.',
  '{"kind":"callout","tone":"info|success|warning|error","title":"...","body":"..."} — one highlighted message.',
  '{"kind":"media","title":"...","src":"https://... | data:image/... | /same-origin/path","alt":"...","body":"...","layout":"left|right|top"} — an image beside text.',
  '{"kind":"sparkline","title":"...","series":[{"label":"...","values":[3,5,4,8],"value":"8 runs","tone":"up|down|flat"}]} — small trend lines, oldest to newest.',
  '{"kind":"bars","title":"...","unit":"runs","items":[{"label":"...","value":12,"note":"..."}]} — horizontal bar comparison, non-negative values.',
  '{"kind":"timechart","title":"...","xLabel":"iteration","yLabel":"score","x":["1","2","3"],"series":[{"label":"...","values":[3,null,8]}]} — Y over time or iterations, up to 4 series, null = gap.',
  'Only real data — never invent numbers or states for the sake of a card.',
].join('\n');
