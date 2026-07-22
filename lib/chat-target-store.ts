/**
 * Legacy direct-chat agent/target selection.
 *
 * Durable chat sessions own and restore their own `chatTarget`; this small
 * browser-local store remains only for older direct/project chat surfaces that
 * do not have a session row.
 */
'use client';

export type StickyChatTarget = 'grok' | 'all' | string;

const LS_KEY = 'shiba-chat-target';

type Listener = () => void;
const listeners = new Set<Listener>();

let sticky: StickyChatTarget = 'grok';
let hydrated = false;

function hydrateFromStorage() {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const v = window.localStorage.getItem(LS_KEY)?.trim();
    if (v) sticky = v;
  } catch {
    /* private mode */
  }
}

function emit() {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function getStickyChatTarget(): StickyChatTarget {
  hydrateFromStorage();
  return sticky;
}

export function setStickyChatTarget(next: StickyChatTarget) {
  const value = next || 'grok';
  hydrateFromStorage();
  if (sticky === value) return;
  sticky = value;
  hydrated = true;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LS_KEY, sticky);
    } catch {
      /* private mode */
    }
  }
  emit();
}

export function subscribeStickyChatTarget(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
