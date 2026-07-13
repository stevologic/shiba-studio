/**
 * Ephemeral sessions created by this browser page lifecycle only.
 *
 * The module-level set survives client-side route unmounts without claiming
 * ephemeral sessions created in another browser or device.
 */
const browserLifecycleSessionIds = new Set<string>();
let pagehideListenerInstalled = false;

function ensurePagehideCleanup(): void {
  if (pagehideListenerInstalled || typeof window === 'undefined') return;
  pagehideListenerInstalled = true;
  window.addEventListener('pagehide', () => {
    for (const id of browserLifecycleSessionIds) {
      const payload = new Blob([JSON.stringify({ action: 'delete', id })], { type: 'application/json' });
      navigator.sendBeacon('/api/chat-sessions', payload);
    }
  });
}

export function registerBrowserEphemeralSession(sessionId: string): void {
  if (!sessionId) return;
  browserLifecycleSessionIds.add(sessionId);
  ensurePagehideCleanup();
}

export function unregisterBrowserEphemeralSession(sessionId: string): void {
  browserLifecycleSessionIds.delete(sessionId);
}

export function listBrowserEphemeralSessions(): string[] {
  return [...browserLifecycleSessionIds];
}
