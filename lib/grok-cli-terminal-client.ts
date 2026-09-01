'use client';

import { setTerminalDock, setTerminalOpen } from './terminal-ui-store';

export type GrokCliTerminalClientResult = {
  ok: boolean;
  launched?: 'agent' | 'login';
  command?: string;
  path?: string;
  error?: string;
  busy?: boolean;
  installHint?: string;
};

/** Open the Studio Terminal and launch interactive Grok Build in that PTY. */
export async function openGrokCliInTerminal(opts?: {
  intent?: 'auto' | 'agent' | 'login';
  cwd?: string;
}): Promise<GrokCliTerminalClientResult> {
  const onCode = typeof window !== 'undefined' && /^\/code(\/|$)/.test(window.location.pathname);
  setTerminalDock(onCode ? 'ide' : 'float');
  setTerminalOpen(true);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('shiba-prepare-terminal'));
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }
  const res = await fetch('/api/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'grok',
      intent: opts?.intent || 'auto',
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    }),
  });
  const data = await res.json().catch(() => ({})) as GrokCliTerminalClientResult;
  if (!res.ok && !data.error) {
    return { ok: false, error: `Terminal launch failed (${res.status})` };
  }
  return data;
}
