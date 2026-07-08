/**
 * Module-level open/closed state for the Studio terminal.
 * Survives Next.js client navigations that remount page components.
 *
 * Important: do not read localStorage inside getTerminalOpen() during render —
 * that causes SSR/client hydration mismatches. Call hydrateTerminalOpen() once
 * after mount instead.
 */
'use client';

type Listener = () => void;

const OPEN_KEY = 'shiba-terminal-open';

let open = false;
let storageHydrated = false;
const listeners = new Set<Listener>();

function readStoredOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredOpen(v: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(OPEN_KEY, v ? '1' : '0');
  } catch {
    /* private mode */
  }
}

function emit() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('shiba-terminal-open', { detail: { open } }));
  }
}

/** Snapshot used by useSyncExternalStore (must match server on first client paint). */
export function getTerminalOpen(): boolean {
  return open;
}

/** Load persisted open state after React hydration. */
export function hydrateTerminalOpen(): void {
  if (storageHydrated || typeof window === 'undefined') return;
  storageHydrated = true;
  const stored = readStoredOpen();
  if (stored !== open) {
    open = stored;
    emit();
  }
}

export function setTerminalOpen(next: boolean) {
  storageHydrated = true;
  if (open === next) {
    writeStoredOpen(next);
    return;
  }
  open = next;
  writeStoredOpen(next);
  emit();
}

export function toggleTerminalOpen() {
  setTerminalOpen(!open);
}

export function subscribeTerminalOpen(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook-friendly snapshot for useSyncExternalStore (SSR). */
export function getTerminalOpenServerSnapshot(): boolean {
  return false;
}
