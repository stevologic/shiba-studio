'use client';

/**
 * Renderer for the rich-card library (lib/rich-cards.ts) — the visual half of
 * the `shiba-card` markdown fence. Used wherever ChatMarkdown renders: Grok
 * chat replies, the meeting stage, run output, file previews.
 */

import React from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Info,
  Minus,
  OctagonAlert,
} from 'lucide-react';
import type {
  RichCalloutTone,
  RichCard,
  RichChecklistState,
  RichTimechartCard,
  RichTimelineState,
} from '@/lib/rich-cards';

const TIMECHART_COLORS = [
  'var(--accent-3)',
  'var(--accent-2)',
  'var(--fun-orange)',
  'var(--success)',
] as const;

/** Multi-series line chart with axes, optional X ticks, null = gap. */
function Timechart({ card }: { card: RichTimechartCard }) {
  const width = 360;
  const height = 160;
  const padL = 36;
  const padR = 56;
  const padT = 12;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = Math.max(...card.series.map((s) => s.values.length), 2);
  const finite = card.series.flatMap((s) => s.values.filter((v): v is number => v != null && Number.isFinite(v)));
  const minY = finite.length ? Math.min(...finite) : 0;
  const maxY = finite.length ? Math.max(...finite) : 1;
  const spanY = maxY - minY || 1;
  const xAt = (index: number) => padL + (n <= 1 ? 0 : (index / (n - 1)) * plotW);
  const yAt = (value: number) => padT + (1 - (value - minY) / spanY) * plotH;
  const xTicks = card.x?.length
    ? card.x.slice(0, n)
    : Array.from({ length: Math.min(n, 6) }, (_, i) => {
        const idx = n <= 1 ? 0 : Math.round((i / Math.max(Math.min(n, 6) - 1, 1)) * (n - 1));
        return String(idx + 1);
      });
  const yTicks = [maxY, (minY + maxY) / 2, minY].map((v) =>
    Number.isInteger(v) ? String(v) : v.toFixed(1),
  );

  return (
    <div className="my-2 p-4" style={CARD_SHELL}>
      <CardTitle title={card.title} />
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ maxWidth: width, height: 'auto' }}
        role="img"
        aria-label={card.title || 'Time chart'}
      >
        <title>{card.title || 'Time chart'}</title>
        {/* axes */}
        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="var(--border)" strokeWidth={1} />
        <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="var(--border)" strokeWidth={1} />
        {yTicks.map((label, i) => {
          const y = padT + (i / 2) * plotH;
          return (
            <g key={`y-${i}`}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--border)" strokeWidth={0.5} opacity={0.5} />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={9} fill="var(--text-dim)">{label}</text>
            </g>
          );
        })}
        {xTicks.map((label, i) => {
          const idx = card.x?.length
            ? i
            : n <= 1
              ? 0
              : Math.round((i / Math.max(xTicks.length - 1, 1)) * (n - 1));
          const x = xAt(Math.min(idx, n - 1));
          return (
            <text key={`x-${i}`} x={x} y={height - 8} textAnchor="middle" fontSize={9} fill="var(--text-dim)">
              {label}
            </text>
          );
        })}
        {card.yLabel && (
          <text
            x={12}
            y={padT + plotH / 2}
            textAnchor="middle"
            fontSize={9}
            fill="var(--text-dim)"
            transform={`rotate(-90 12 ${padT + plotH / 2})`}
          >
            {card.yLabel}
          </text>
        )}
        {card.xLabel && (
          <text x={padL + plotW / 2} y={height - 2} textAnchor="middle" fontSize={9} fill="var(--text-dim)">
            {card.xLabel}
          </text>
        )}
        {card.series.map((series, sIdx) => {
          const color = TIMECHART_COLORS[sIdx % TIMECHART_COLORS.length];
          // Split into contiguous polylines so null gaps break the stroke.
          const segments: Array<Array<[number, number]>> = [];
          let current: Array<[number, number]> = [];
          series.values.forEach((sample, index) => {
            if (sample == null || !Number.isFinite(sample)) {
              if (current.length) segments.push(current);
              current = [];
              return;
            }
            current.push([xAt(index), yAt(sample)]);
          });
          if (current.length) segments.push(current);
          let lastIdx = -1;
          let lastFinite: number | null = null;
          for (let i = series.values.length - 1; i >= 0; i--) {
            const v = series.values[i];
            if (v != null && Number.isFinite(v)) {
              lastIdx = i;
              lastFinite = v;
              break;
            }
          }
          return (
            <g key={sIdx}>
              {segments.map((pts, segIdx) => (
                <polyline
                  key={segIdx}
                  points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {lastFinite != null && lastIdx >= 0 && (
                <>
                  <circle cx={xAt(lastIdx)} cy={yAt(lastFinite)} r={2.5} fill={color} />
                  <text
                    x={xAt(lastIdx) + 6}
                    y={yAt(lastFinite) + 3}
                    fontSize={9}
                    fill={color}
                  >
                    {series.label}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Word-sized trend line: single hue, no axes — the headline value carries the
 *  reading and the line shows shape. Native tooltip exposes min/max/latest. */
function Sparkline({ values, tone }: { values: number[]; tone?: 'up' | 'down' | 'flat' }) {
  const width = 120;
  const height = 32;
  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((sample, index) => {
    const x = pad + (index / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (sample - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const [endX, endY] = points[points.length - 1];
  const endColor = tone === 'up' ? 'var(--success)' : tone === 'down' ? 'var(--error)' : 'var(--accent-3)';
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="flex-shrink-0"
      role="img"
      aria-label={`Trend from ${min} to ${max}, latest ${values[values.length - 1]}`}
    >
      <title>{`min ${min} · max ${max} · latest ${values[values.length - 1]}`}</title>
      <polyline
        points={points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
        fill="none"
        stroke="var(--accent-3)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={endX} cy={endY} r={2.5} fill={endColor} />
    </svg>
  );
}

const CARD_SHELL: React.CSSProperties = {
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
};

function CardTitle({ title }: { title?: string }) {
  if (!title) return null;
  return <div className="text-xs font-medium text-dim uppercase tracking-wide mb-2">{title}</div>;
}

function StatDelta({ delta, tone }: { delta?: string; tone?: 'up' | 'down' | 'flat' }) {
  if (!delta && !tone) return null;
  const color = tone === 'up' ? 'var(--success)' : tone === 'down' ? 'var(--error)' : 'var(--text-dim)';
  const Icon = tone === 'up' ? ChevronUp : tone === 'down' ? ChevronDown : Minus;
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium" style={{ color }}>
      <Icon size={12} strokeWidth={2.5} aria-hidden />
      {delta}
    </span>
  );
}

const CHECK_STATE: Record<RichChecklistState, { icon: React.ReactNode; color: string; label: string }> = {
  done: { icon: <CircleCheck size={15} aria-hidden />, color: 'var(--success)', label: 'Done' },
  active: { icon: <CircleDashed size={15} aria-hidden />, color: 'var(--fun-orange)', label: 'In progress' },
  pending: { icon: <CircleDashed size={15} aria-hidden />, color: 'var(--text-dim)', label: 'Pending' },
  blocked: { icon: <CircleAlert size={15} aria-hidden />, color: 'var(--error)', label: 'Blocked' },
};

const TIMELINE_STATE: Record<RichTimelineState, string> = {
  done: 'var(--success)',
  active: 'var(--fun-orange)',
  pending: 'var(--border-light)',
};

const CALLOUT_TONE: Record<RichCalloutTone, { icon: React.ReactNode; color: string }> = {
  info: { icon: <Info size={15} aria-hidden />, color: 'var(--accent-3)' },
  success: { icon: <Check size={15} aria-hidden />, color: 'var(--success)' },
  warning: { icon: <AlertTriangle size={15} aria-hidden />, color: 'var(--warning)' },
  error: { icon: <OctagonAlert size={15} aria-hidden />, color: 'var(--error)' },
};

export default function RichCardView({ card }: { card: RichCard }) {
  if (card.kind === 'stats') {
    return (
      <div className="my-2 p-4" style={CARD_SHELL}>
        <CardTitle title={card.title} />
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(120px, ${card.stats.length > 2 ? '1fr' : '180px'}))` }}>
          {card.stats.map((stat, index) => (
            <div key={index} className="min-w-0">
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="text-xl font-semibold text-primary leading-tight">{stat.value}</span>
                <StatDelta delta={stat.delta} tone={stat.tone} />
              </div>
              <div className="text-[11px] text-dim mt-0.5 truncate" title={stat.label}>{stat.label}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (card.kind === 'progress') {
    return (
      <div className="my-2 p-4" style={CARD_SHELL}>
        <CardTitle title={card.title} />
        <div className="space-y-2.5">
          {card.items.map((item, index) => (
            <div key={index}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-xs text-primary truncate" title={item.label}>{item.label}</span>
                <span className="text-[11px] font-mono text-dim flex-shrink-0">{item.percent}%</span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-hover)' }} role="progressbar" aria-valuenow={item.percent} aria-valuemin={0} aria-valuemax={100} aria-label={item.label}>
                <div className="h-full rounded-full" style={{ width: `${item.percent}%`, background: item.percent >= 100 ? 'var(--success)' : 'var(--accent-2)' }} />
              </div>
              {item.note && <div className="text-[11px] text-dim mt-0.5">{item.note}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (card.kind === 'checklist') {
    return (
      <div className="my-2 p-4" style={CARD_SHELL}>
        <CardTitle title={card.title} />
        <ul className="space-y-1.5">
          {card.items.map((item, index) => {
            const state = CHECK_STATE[item.state];
            return (
              <li key={index} className="flex items-start gap-2">
                <span className="mt-0.5 flex-shrink-0" style={{ color: state.color }} title={state.label}>{state.icon}</span>
                <span className="min-w-0">
                  <span className={`text-sm ${item.state === 'done' ? 'text-muted' : 'text-primary'}`}>{item.text}</span>
                  {item.note && <span className="block text-[11px] text-dim">{item.note}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (card.kind === 'timeline') {
    return (
      <div className="my-2 p-4" style={CARD_SHELL}>
        <CardTitle title={card.title} />
        <ol className="relative ml-1.5 space-y-3 list-none" style={{ borderLeft: '1px solid var(--border-light)', paddingLeft: 0 }}>
          {card.items.map((item, index) => (
            <li key={index} className="relative pl-4">
              <span
                className="absolute w-2.5 h-2.5 rounded-full"
                style={{
                  left: '-5.5px',
                  top: '4px',
                  background: TIMELINE_STATE[item.state || 'pending'],
                  border: '2px solid var(--bg-elev)',
                }}
                aria-hidden
              />
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-sm text-primary">{item.label}</span>
                {item.date && <span className="text-[11px] font-mono text-dim">{item.date}</span>}
              </div>
              {item.note && <div className="text-[11px] text-dim mt-0.5">{item.note}</div>}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (card.kind === 'sparkline') {
    return (
      <div className="my-2 p-4" style={CARD_SHELL}>
        <CardTitle title={card.title} />
        <div className="space-y-2.5">
          {card.series.map((series, index) => (
            <div key={index} className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-xs text-primary truncate" title={series.label}>{series.label}</div>
                {series.value && (
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-base font-semibold text-primary">{series.value}</span>
                    <StatDelta tone={series.tone} />
                  </div>
                )}
              </div>
              <Sparkline values={series.values} tone={series.tone} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (card.kind === 'bars') {
    const max = Math.max(...card.items.map((item) => item.value), 1);
    const format = (value: number) => `${Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1)}${card.unit ? ` ${card.unit}` : ''}`;
    return (
      <div className="my-2 p-4" style={CARD_SHELL}>
        <CardTitle title={card.title} />
        <div className="space-y-2">
          {card.items.map((item, index) => (
            <div key={index}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-xs text-primary truncate" title={item.label}>{item.label}</span>
                <span className="text-[11px] font-mono text-dim flex-shrink-0">{format(item.value)}</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-hover)' }} role="img" aria-label={`${item.label}: ${format(item.value)} of ${format(max)}`}>
                <div className="h-full rounded-full" style={{ width: `${Math.max((item.value / max) * 100, item.value > 0 ? 2 : 0)}%`, background: 'var(--accent-2)' }} />
              </div>
              {item.note && <div className="text-[11px] text-dim mt-0.5">{item.note}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (card.kind === 'media') {
    const image = (
      // eslint-disable-next-line @next/next/no-img-element -- agent-supplied/data-URI sources; next/image cannot optimize them
      <img
        src={card.src}
        alt={card.alt || card.title || 'Card image'}
        className="rounded border border-default max-w-full"
        style={{ maxHeight: 240, objectFit: 'contain' }}
        loading="lazy"
      />
    );
    if (card.layout === 'top' || !card.body) {
      return (
        <div className="my-2 p-4" style={CARD_SHELL}>
          <CardTitle title={card.title} />
          {image}
          {card.body && <div className="text-sm text-muted mt-2 whitespace-pre-wrap">{card.body}</div>}
        </div>
      );
    }
    return (
      <div className="my-2 p-4" style={CARD_SHELL}>
        <CardTitle title={card.title} />
        <div className={`flex items-start gap-4 ${card.layout === 'right' ? 'flex-row-reverse' : ''}`}>
          <div className="flex-shrink-0" style={{ maxWidth: '42%' }}>{image}</div>
          <div className="text-sm text-muted whitespace-pre-wrap min-w-0">{card.body}</div>
        </div>
      </div>
    );
  }

  if (card.kind === 'timechart') {
    return <Timechart card={card} />;
  }

  // Discriminated callout — must not fall through from other kinds (timechart
  // was previously unhandled and poisoned `card.tone` / `card.body` access).
  if (card.kind === 'callout') {
    const tone = CALLOUT_TONE[card.tone];
    return (
      <div
        className="my-2 p-3.5 flex items-start gap-2.5"
        style={{
          ...CARD_SHELL,
          borderLeft: `3px solid ${tone.color}`,
          background: `color-mix(in srgb, ${tone.color} 6%, var(--bg-elev))`,
        }}
        role={card.tone === 'error' || card.tone === 'warning' ? 'alert' : 'note'}
      >
        <span className="mt-0.5 flex-shrink-0" style={{ color: tone.color }}>{tone.icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-primary">{card.title}</div>
          {card.body && <div className="text-xs text-muted mt-0.5 whitespace-pre-wrap">{card.body}</div>}
        </div>
      </div>
    );
  }

  return null;
}
