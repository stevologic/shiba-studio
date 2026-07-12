// Bare-name convenience: a tiny HTTP listener on port 80 that 302-redirects
// http://shiba.local/  →  http://shiba.local:<appPort>/  (and the same for any
// other name/IP the request arrives under). mDNS (lib/mdns.ts) makes the NAME
// resolve to this machine, but a browser still needs the port unless something
// answers on 80 — this is that something, so users can type just "shiba.local".
//
// Best-effort and non-fatal: if port 80 is already taken (IIS, another server)
// or needs elevation, it logs once and skips — the app is still reachable at
// shiba.local:<appPort>. Disable with SHIBA_PORT80=off. The redirect target is
// SHIBA_APP_PORT, else PORT, else 3000 (the default `next dev`/`next start` port).

import http from 'http';

interface Port80Globals {
  __shibaPort80?: http.Server | null;
}
const g = globalThis as unknown as Port80Globals;

const REDIRECT_PORT = 80;

/** The port the app itself listens on — what bare :80 traffic is sent to. */
export function appPort(): number {
  return Number(process.env.SHIBA_APP_PORT || process.env.PORT || 3000) || 3000;
}

/**
 * Start the port-80 → app-port redirector. Idempotent and best-effort; never
 * throws. Skipped when the app already runs on port 80 (nothing to redirect).
 */
export function startPort80Redirect(): http.Server | null {
  if (process.env.SHIBA_PORT80 === 'off') return null;
  if (g.__shibaPort80) return g.__shibaPort80;

  const target = appPort();
  if (target === REDIRECT_PORT) return null; // app is already on :80

  const lanMode = process.env.SHIBA_LAN === '1';
  const bindHost = lanMode ? '0.0.0.0' : '127.0.0.1';

  const server = http.createServer((req, res) => {
    // Host header without its port (browsers omit :80) → re-add the app port.
    const host = (req.headers.host || 'shiba.local').split(':')[0];
    const location = `http://${host}:${target}${req.url || '/'}`;
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end(`Redirecting to ${location}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[shiba-studio] port 80 busy — bare http://shiba.local won't redirect (open shiba.local:${target} instead)`);
    } else if (err.code === 'EACCES') {
      console.warn(`[shiba-studio] port 80 needs elevated rights here — bare http://shiba.local won't redirect (open shiba.local:${target} instead)`);
    } else {
      console.warn('[shiba-studio] port-80 redirect error:', err.message);
    }
    try { server.close(); } catch { /* already closed */ }
    g.__shibaPort80 = null;
  });

  server.listen(REDIRECT_PORT, bindHost, () => {
    g.__shibaPort80 = server;
    console.log(`[shiba-studio] http://shiba.local → :${target} redirect active (${bindHost}:80)`);
  });

  return server;
}

export function stopPort80Redirect(): void {
  const s = g.__shibaPort80;
  if (!s) return;
  try { s.close(); } catch { /* already closed */ }
  g.__shibaPort80 = null;
}
