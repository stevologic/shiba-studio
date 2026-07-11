/**
 * Client side of the live change feed (GET /api/events, SSE).
 *
 * One EventSource per browser tab, held at module scope so React remounts
 * (every tab navigation) reuse the same connection. Components subscribe to
 * event types and refresh their data slice when the server says it changed —
 * page refreshes and tight polling are no longer how data stays current.
 * EventSource auto-reconnects on drops; existing polls remain as a fallback.
 */
'use client';

import type { AppEventType } from './app-events';

type Listener = (type: AppEventType) => void;

let source: EventSource | null = null;
const listeners = new Map<AppEventType, Set<Listener>>();

function ensureConnected(): void {
  if (typeof window === 'undefined' || source) return;
  try {
    source = new EventSource('/api/events');
    source.onmessage = (e) => {
      let type: AppEventType | undefined;
      try {
        type = (JSON.parse(e.data) as { type?: AppEventType }).type;
      } catch {
        return;
      }
      if (!type) return;
      for (const l of listeners.get(type) ?? []) {
        try { l(type); } catch { /* listener error is not ours */ }
      }
    };
    // Built-in retry handles transient drops. A hard failure (server gone)
    // closes the source; the next subscribe() reopens it.
    source.onerror = () => {
      if (source?.readyState === EventSource.CLOSED) source = null;
    };
  } catch {
    source = null;
  }
}

/** Listen for change events. Returns an unsubscribe function. */
export function subscribeLiveEvents(types: AppEventType[], listener: Listener): () => void {
  ensureConnected();
  for (const t of types) {
    const set = listeners.get(t) ?? new Set();
    set.add(listener);
    listeners.set(t, set);
  }
  return () => {
    for (const t of types) listeners.get(t)?.delete(listener);
  };
}
