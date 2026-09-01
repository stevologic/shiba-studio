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

export type TerminalDock = 'float' | 'ide';

let open = false;
let dock: TerminalDock = 'float';
let storageHydrated = false;
const listeners = new Set<Listener>();
const dockListeners = new Set<Listener>();

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

/** Where the shared host PTY is shown: floating overlay vs Code bottom panel. */
export function getTerminalDock(): TerminalDock {
  return dock;
}

export function setTerminalDock(next: TerminalDock) {
  if (dock === next) return;
  dock = next;
  for (const l of dockListeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function subscribeTerminalDock(listener: Listener): () => void {
  dockListeners.add(listener);
  return () => {
    dockListeners.delete(listener);
  };
}

export function getTerminalDockServerSnapshot(): TerminalDock {
  return 'float';
}

/** Open the PTY in the Code IDE bottom panel. */
export function openIdeTerminal() {
  setTerminalDock('ide');
  setTerminalOpen(true);
}

/** Open the PTY as the studio-wide overlay. */
export function openFloatTerminal() {
  setTerminalDock('float');
  setTerminalOpen(true);
}

/** React hook-friendly snapshot for useSyncExternalStore (SSR). */
export function getTerminalOpenServerSnapshot(): boolean {
  return false;
}
