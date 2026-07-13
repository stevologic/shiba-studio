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

import type { AppEvent, AppEventType } from './app-events';

export interface LiveEventMeta {
  /** True when the stream reopened after a gap, never on its first connection. */
  reconnect: boolean;
  /** Concrete server invalidation; absent for reconnect catch-up. */
  event?: AppEvent;
  /** All resource types owned by this subscription. */
  types: readonly AppEventType[];
}

type Listener = (type: AppEventType, meta: LiveEventMeta) => void;
type Subscription = { types: readonly AppEventType[]; listener: Listener };

let source: EventSource | null = null;
let hasOpenedOnce = false;
const subscriptions = new Set<Subscription>();

function notify(subscription: Subscription, type: AppEventType, meta: Omit<LiveEventMeta, 'types'>): void {
  try {
    subscription.listener(type, { ...meta, types: subscription.types });
  } catch {
    /* listener error is not ours */
  }
}

function ensureConnected(): void {
  if (typeof window === 'undefined' || source) return;
  try {
    const next = new EventSource('/api/events');
    source = next;
    // Events are invalidations rather than a replay log. On the initial
    // connection components already perform their own first load. Only a
    // reconnect needs catch-up; notify each subscription once (not once per
    // type) so a tasks+attention subscriber cannot issue duplicate GETs.
    next.onopen = () => {
      if (!hasOpenedOnce) {
        hasOpenedOnce = true;
        return;
      }
      for (const subscription of subscriptions) {
        const type = subscription.types[0];
        if (type) notify(subscription, type, { reconnect: true });
      }
    };
    next.onmessage = (message) => {
      let event: AppEvent | undefined;
      try {
        event = JSON.parse(message.data) as AppEvent;
      } catch {
        return;
      }
      if (!event?.type) return;
      for (const subscription of subscriptions) {
        if (subscription.types.includes(event.type)) {
          notify(subscription, event.type, { reconnect: false, event });
        }
      }
    };
    // Built-in retry handles transient drops. A hard failure (server gone)
    // closes the source; the next subscribe() reopens it.
    next.onerror = () => {
      if (source === next && next.readyState === EventSource.CLOSED) source = null;
    };
  } catch {
    source = null;
  }
}

/** Listen for change events. Returns an unsubscribe function. */
export function subscribeLiveEvents(types: AppEventType[], listener: Listener): () => void {
  const subscription: Subscription = { types: [...new Set(types)], listener };
  subscriptions.add(subscription);
  ensureConnected();
  return () => {
    subscriptions.delete(subscription);
  };
}
