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

/* ── Custom cards — layouts the agent designs itself ── */

export type RichCustomTone = 'primary' | 'muted' | 'dim' | 'success' | 'warning' | 'error' | 'accent';

export interface RichCustomText {
  type: 'text';
  text: string;
  size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl';
  tone?: RichCustomTone;
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
  mono?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface RichCustomBadge {
  type: 'badge';
  text: string;
  tone?: 'neutral' | 'success' | 'warning' | 'error' | 'accent';
}

/** One "label: value" line — the workhorse of definition-style layouts. */
export interface RichCustomKv {
  type: 'kv';
  label: string;
  value: string;
}

export interface RichCustomMeter {
  type: 'meter';
  /** 0–100. */
  percent: number;
  label?: string;
  tone?: 'accent' | 'success' | 'warning' | 'error';
}

export interface RichCustomDivider {
  type: 'divider';
}

export interface RichCustomRow {
  type: 'row';
  /** `between` pushes items to the edges (header rows); others map to align-items. */
  align?: 'start' | 'center' | 'baseline' | 'between';
  items: RichCustomElement[];
}

export interface RichCustomGrid {
  type: 'grid';
  /** 2–4 equal columns. */
  columns?: number;
  items: RichCustomElement[];
}

export type RichCustomElement =
  | RichCustomText
  | RichCustomBadge
  | RichCustomKv
  | RichCustomMeter
  | RichCustomDivider
  | RichCustomRow
  | RichCustomGrid;

export interface RichCustomCard {
  kind: 'custom';
  title?: string;
  body: RichCustomElement[];
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
  | RichTimechartCard
  | RichCustomCard;

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

/** Nesting and size caps for agent-designed custom cards: enough for a real
 *  dashboard tile, small enough that a runaway payload can't bloat the DOM. */
const CUSTOM_MAX_DEPTH = 4;
const CUSTOM_MAX_ELEMENTS = 80;

function parseCustomElements(raw: unknown, depth: number, budget: { left: number }): RichCustomElement[] {
  if (!Array.isArray(raw) || depth > CUSTOM_MAX_DEPTH) return [];
  const out: RichCustomElement[] = [];
  for (const entry of raw.slice(0, MAX_ITEMS)) {
    if (budget.left <= 0) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const element = entry as Record<string, unknown>;

    if (element.type === 'text') {
      const textValue = text(element.text, 2_000);
      if (!textValue) continue;
      budget.left -= 1;
      const size = element.size === 'xs' || element.size === 'sm' || element.size === 'lg' || element.size === 'xl' ? element.size : undefined;
      const tone = element.tone === 'primary' || element.tone === 'muted' || element.tone === 'dim'
        || element.tone === 'success' || element.tone === 'warning' || element.tone === 'error' || element.tone === 'accent'
        ? element.tone : undefined;
      const weight = element.weight === 'medium' || element.weight === 'semibold' || element.weight === 'bold' ? element.weight : undefined;
      const align = element.align === 'center' || element.align === 'right' ? element.align : undefined;
      out.push({
        type: 'text',
        text: textValue,
        ...(size ? { size } : {}),
        ...(tone ? { tone } : {}),
        ...(weight ? { weight } : {}),
        ...(element.mono === true ? { mono: true } : {}),
        ...(align ? { align } : {}),
      });
      continue;
    }

    if (element.type === 'badge') {
      const textValue = text(element.text, 80);
      if (!textValue) continue;
      budget.left -= 1;
      const tone = element.tone === 'success' || element.tone === 'warning' || element.tone === 'error' || element.tone === 'accent'
        ? element.tone : undefined;
      out.push({ type: 'badge', text: textValue, ...(tone ? { tone } : {}) });
      continue;
    }

    if (element.type === 'kv') {
      const label = text(element.label, 160);
      const value = text(element.value, 400);
      if (!label || !value) continue;
      budget.left -= 1;
      out.push({ type: 'kv', label, value });
      continue;
    }

    if (element.type === 'meter') {
      const percent = Number(element.percent);
      if (!Number.isFinite(percent)) continue;
      budget.left -= 1;
      const label = text(element.label, 160) || undefined;
      const tone = element.tone === 'success' || element.tone === 'warning' || element.tone === 'error' ? element.tone : undefined;
      out.push({
        type: 'meter',
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        ...(label ? { label } : {}),
        ...(tone ? { tone } : {}),
      });
      continue;
    }

    if (element.type === 'divider') {
      budget.left -= 1;
      out.push({ type: 'divider' });
      continue;
    }

    if (element.type === 'row' || element.type === 'grid') {
      budget.left -= 1;
      const children = parseCustomElements(element.items, depth + 1, budget);
      if (!children.length) continue;
      if (element.type === 'row') {
        const align = element.align === 'center' || element.align === 'baseline' || element.align === 'between' ? element.align : undefined;
        out.push({ type: 'row', ...(align ? { align } : {}), items: children });
      } else {
        const columns = Math.max(2, Math.min(4, Math.round(Number(element.columns)) || 2));
        out.push({ type: 'grid', columns, items: children });
      }
      continue;
    }
  }
  return out;
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

  if (value.kind === 'custom') {
    const budget = { left: CUSTOM_MAX_ELEMENTS };
    const body = parseCustomElements(value.body, 1, budget);
    return body.length ? { kind: 'custom', ...(title ? { title } : {}), body } : null;
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
  'YOU decide how each piece of information is displayed — choose the form that reads best, not the first one that works. Plain prose for narrative, a markdown table for a grid of text, and a rich card whenever structure, status, or numbers deserve visual form. Inside any markdown you write, a fenced code block with language "shiba-card" containing ONE JSON object renders as a visual card. Kinds:',
  '{"kind":"stats","title":"...","stats":[{"label":"...","value":"...","delta":"+12%","tone":"up|down|flat"}]} — KPI tiles.',
  '{"kind":"progress","title":"...","items":[{"label":"...","percent":0-100,"note":"..."}]} — progress bars.',
  '{"kind":"checklist","title":"...","items":[{"text":"...","state":"done|active|pending|blocked","note":"..."}]} — work states.',
  '{"kind":"timeline","title":"...","items":[{"label":"...","date":"...","state":"done|active|pending","note":"..."}]} — milestones.',
  '{"kind":"callout","tone":"info|success|warning|error","title":"...","body":"..."} — one highlighted message.',
  '{"kind":"media","title":"...","src":"https://... | data:image/... | /same-origin/path","alt":"...","body":"...","layout":"left|right|top"} — an image beside text.',
  '{"kind":"sparkline","title":"...","series":[{"label":"...","values":[3,5,4,8],"value":"8 runs","tone":"up|down|flat"}]} — small trend lines, oldest to newest.',
  '{"kind":"bars","title":"...","unit":"runs","items":[{"label":"...","value":12,"note":"..."}]} — horizontal bar comparison, non-negative values.',
  '{"kind":"timechart","title":"...","xLabel":"iteration","yLabel":"score","x":["1","2","3"],"series":[{"label":"...","values":[3,null,8]}]} — Y over time or iterations, up to 4 series, null = gap.',
  '{"kind":"custom","title":"...","body":[elements]} — when no preset above fits, DESIGN YOUR OWN card from these elements: {"type":"text","text":"...","size":"xs|sm|base|lg|xl","tone":"primary|muted|dim|success|warning|error|accent","weight":"medium|semibold|bold","mono":true,"align":"center|right"} · {"type":"badge","text":"...","tone":"neutral|success|warning|error|accent"} · {"type":"kv","label":"...","value":"..."} · {"type":"meter","percent":0-100,"label":"...","tone":"success|warning|error"} · {"type":"divider"} · {"type":"row","align":"start|center|baseline|between","items":[...]} · {"type":"grid","columns":2-4,"items":[...]}. Rows and grids nest up to 4 levels — compose them like a tiny dashboard tile (e.g. a header row with a badge, a grid of big numbers, meters with labels).',
  'Only real data — never invent numbers or states for the sake of a card.',
].join('\n');
