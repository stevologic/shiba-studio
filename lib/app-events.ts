// Server-side change bus behind GET /api/events (SSE). Stores emit here when
// data changes (runs persisted, board saved, chat sessions written, agents
// saved) and every connected browser tab hears about it within milliseconds —
// no page refresh, no tight polling. Registry lives on globalThis so dev HMR
// never strands subscribers.

export type AppEventType = 'runs' | 'board' | 'chats' | 'agents' | 'config';

export interface AppEvent {
  type: AppEventType;
  ts: string;
}

type Subscriber = {
  id: number;
  send: (evt: AppEvent) => void;
};

interface EventGlobals {
  __shibaAppEventSubs?: Map<number, Subscriber>;
  __shibaAppEventSeq?: number;
}
const g = globalThis as unknown as EventGlobals;
const subs: Map<number, Subscriber> = g.__shibaAppEventSubs ?? (g.__shibaAppEventSubs = new Map());

export function subscribeAppEvents(send: (evt: AppEvent) => void): () => void {
  const id = (g.__shibaAppEventSeq = (g.__shibaAppEventSeq ?? 0) + 1);
  subs.set(id, { id, send });
  return () => {
    subs.delete(id);
  };
}

/** Fire-and-forget: a dead subscriber (closed tab) is dropped on first throw. */
export function emitAppEvent(type: AppEventType): void {
  if (subs.size === 0) return;
  const evt: AppEvent = { type, ts: new Date().toISOString() };
  for (const sub of [...subs.values()]) {
    try {
      sub.send(evt);
    } catch {
      subs.delete(sub.id);
    }
  }
}

export function appEventSubscriberCount(): number {
  return subs.size;
}
