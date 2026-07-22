/**
 * Real host PTY terminal over WebSocket (localhost only).
 *
 * Shared "main" session: one long-lived PTY that the UI and chat tools attach to.
 * Disconnecting the browser does NOT kill the shell — reconnect resumes the same
 * session (with scrollback replay). Chat `terminal_exec` writes into this PTY.
 */
import type { IncomingMessage, Server as HttpServer } from 'http';
import os from 'node:os';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  resolveTerminalShell,
  terminalShellPublicInfo,
  type TerminalShell,
} from './terminal-shell';
import { advertisedHostnames } from './mdns';
import { configuredPublicOrigin, publicTerminalProxyEnabled } from './public-origin';

export const DEFAULT_TERMINAL_WS_PORT = 3911;
export const MAIN_SESSION_ID = 'main';
const MAX_SCROLLBACK = 120_000;

type PtyProcess = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  pid: number;
};

type ClientMsg =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  | { type: 'attach'; sessionId?: string };

type ServerMsg =
  | {
      type: 'ready';
      sessionId: string;
      shell: ReturnType<typeof terminalShellPublicInfo>;
      pid: number;
      cols: number;
      rows: number;
      resumed: boolean;
    }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number; signal?: number }
  | { type: 'error'; message: string }
  | { type: 'pong' };

type SharedSession = {
  id: string;
  proc: PtyProcess;
  shell: TerminalShell;
  cols: number;
  rows: number;
  clients: Set<WebSocket>;
  scrollback: string;
  alive: boolean;
};

type TerminalServerState = {
  port: number;
  host: string;
  wss: WebSocketServer | null;
  started: boolean;
  shell: TerminalShell | null;
  sessions: Map<string, SharedSession>;
  /** Active tool-driven command waiters (marker → resolve). */
  commandWaiters: Array<{
    marker: string;
    startedAt: number;
    buf: string;
    resolve: (r: { output: string; code: number | null; timedOut: boolean; aborted?: boolean }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
};

const g = globalThis as typeof globalThis & {
  __shibaTerminal?: TerminalServerState;
};

function state(): TerminalServerState {
  if (!g.__shibaTerminal) {
    g.__shibaTerminal = {
      port: Number(process.env.TERMINAL_WS_PORT || DEFAULT_TERMINAL_WS_PORT) || DEFAULT_TERMINAL_WS_PORT,
      host: process.env.TERMINAL_WS_HOST || '127.0.0.1',
      wss: null,
      started: false,
      shell: null,
      sessions: new Map(),
      commandWaiters: [],
    };
  }
  // HMR may restore a partial shape — ensure maps exist.
  if (!g.__shibaTerminal.sessions) g.__shibaTerminal.sessions = new Map();
  if (!g.__shibaTerminal.commandWaiters) g.__shibaTerminal.commandWaiters = [];
  return g.__shibaTerminal;
}

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(session: SharedSession, msg: ServerMsg) {
  for (const ws of session.clients) send(ws, msg);
}

function appendScrollback(session: SharedSession, data: string) {
  session.scrollback += data;
  if (session.scrollback.length > MAX_SCROLLBACK) {
    session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK);
  }
}

/** UI-only annotation (not typed into the shell as keystrokes). */
function injectUiNote(session: SharedSession, text: string) {
  const data = `\r\n\x1b[90m${text}\x1b[0m\r\n`;
  appendScrollback(session, data);
  broadcast(session, { type: 'output', data });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function feedCommandWaiters(data: string) {
  const st = state();
  if (!st.commandWaiters.length) return;
  for (const w of [...st.commandWaiters]) {
    w.buf += data;
    // Only match the marker at the start of a line (actual command OUTPUT).
    // Ignore the typed `echo MARKER:$?` line where the marker is mid-line.
    const re = new RegExp(`(?:^|[\\r\\n])${escapeRegExp(w.marker)}:(-?\\d+)`);
    const m = re.exec(w.buf);
    if (!m || m.index == null) continue;
    const markerStart = w.buf.indexOf(w.marker, m.index);
    if (markerStart < 0) continue;
    const code = m[1] != null ? Number(m[1]) : null;
    // Drop the trailing typed "echo MARKER…" line before the marker output.
    let output = w.buf.slice(0, markerStart).replace(/\r\n/g, '\n').replace(/\r/g, '');
    output = output.replace(/\n+$/, '');
    output = output.replace(new RegExp(`\\n[^\\n]*${escapeRegExp(w.marker)}[^\\n]*$`), '');
    clearTimeout(w.timer);
    st.commandWaiters = st.commandWaiters.filter((x) => x !== w);
    w.resolve({ output, code, timedOut: false });
  }
}

function spawnPty(shell: TerminalShell, cols: number, rows: number): PtyProcess {
  // Dynamic require keeps Turbopack from bundling the native addon incorrectly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';
  if (!env.LANG) env.LANG = 'en_US.UTF-8';

  const proc = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: Math.max(20, cols || 80),
    rows: Math.max(5, rows || 24),
    cwd: shell.cwd,
    env,
    useConpty: process.platform === 'win32',
  });

  return proc as unknown as PtyProcess;
}

function wireSession(session: SharedSession) {
  session.proc.onData((data) => {
    appendScrollback(session, data);
    feedCommandWaiters(data);
    broadcast(session, { type: 'output', data });
  });
  session.proc.onExit(({ exitCode, signal }) => {
    session.alive = false;
    broadcast(session, { type: 'exit', code: exitCode, signal });
    for (const ws of [...session.clients]) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    session.clients.clear();
    const st = state();
    st.sessions.delete(session.id);
    // Fail any in-flight tool waits
    for (const w of st.commandWaiters) {
      clearTimeout(w.timer);
      w.resolve({ output: w.buf, code: exitCode, timedOut: false });
    }
    st.commandWaiters = [];
  });
}

/** Get or create the long-lived main Studio terminal session. */
export function ensureMainSession(cols = 80, rows = 24): SharedSession {
  const st = state();
  const existing = st.sessions.get(MAIN_SESSION_ID);
  if (existing?.alive) return existing;

  const shell = resolveTerminalShell();
  st.shell = shell;
  const proc = spawnPty(shell, cols, rows);
  const session: SharedSession = {
    id: MAIN_SESSION_ID,
    proc,
    shell,
    cols: Math.max(20, cols),
    rows: Math.max(5, rows),
    clients: new Set(),
    scrollback: '',
    alive: true,
  };
  wireSession(session);
  st.sessions.set(MAIN_SESSION_ID, session);
  console.log(
    `[shiba-studio] studio terminal session ready · pid ${proc.pid} · ${shell.label}`,
  );
  return session;
}

function detachClient(session: SharedSession, ws: WebSocket) {
  session.clients.delete(ws);
  // Do NOT kill the PTY — session persists across navigation / disconnect.
}

function attachClient(ws: WebSocket) {
  let session: SharedSession;
  try {
    session = ensureMainSession(80, 24);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    send(ws, { type: 'error', message: `Failed to start terminal: ${message}` });
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return;
  }

  const resumed = session.clients.size > 0 || session.scrollback.length > 0;
  session.clients.add(ws);

  send(ws, {
    type: 'ready',
    sessionId: session.id,
    shell: terminalShellPublicInfo(session.shell),
    pid: session.proc.pid,
    cols: session.cols,
    rows: session.rows,
    resumed,
  });

  // Replay scrollback so reconnect after navigation shows the same session.
  if (session.scrollback) {
    send(ws, { type: 'output', data: session.scrollback });
  }

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      if (session.alive) session.proc.write(String(raw));
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string' && session.alive) {
      session.proc.write(msg.data);
      return;
    }
    if (msg.type === 'resize' && session.alive) {
      const cols = Math.max(20, Math.floor(Number(msg.cols) || session.cols));
      const rows = Math.max(5, Math.floor(Number(msg.rows) || session.rows));
      session.cols = cols;
      session.rows = rows;
      try {
        session.proc.resize(cols, rows);
      } catch {
        /* ignore */
      }
    }
  });

  ws.on('close', () => detachClient(session, ws));
  ws.on('error', () => detachClient(session, ws));
}

/**
 * Write raw data into the shared Studio terminal (visible to the user).
 */
export function writeTerminal(data: string): { ok: boolean; error?: string } {
  try {
    startTerminalServer();
    const session = ensureMainSession();
    if (!session.alive) return { ok: false, error: 'Terminal session is not alive' };
    session.proc.write(data);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Run a command in the shared interactive terminal and capture output until a
 * completion marker (or timeout). Output is also shown in the Terminal UI.
 */
export async function runTerminalCommand(
  command: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{
  ok: boolean;
  output: string;
  code: number | null;
  timedOut: boolean;
  pid?: number;
  shell?: string;
  error?: string;
}> {
  const cmd = String(command || '').trim();
  if (!cmd) {
    return { ok: false, output: '', code: null, timedOut: false, error: 'Empty command' };
  }
  if (opts?.signal?.aborted) {
    return { ok: false, output: '', code: null, timedOut: false, error: 'Aborted' };
  }
  // Reject interactive/suspend that would hang the tool wait.
  if (/\b(vim|nvim|nano|less|more|top|htop|watch)\b/i.test(cmd) && !/\|/.test(cmd)) {
    return {
      ok: false,
      output: '',
      code: null,
      timedOut: false,
      error: 'Interactive full-screen commands are not supported via terminal_exec — open the Terminal panel and run them there, or use a non-interactive form.',
    };
  }

  try {
    startTerminalServer();
    const session = ensureMainSession();
    if (!session.alive) {
      return { ok: false, output: '', code: null, timedOut: false, error: 'Terminal session is not alive' };
    }

    const timeoutMs = Math.min(Math.max(opts?.timeoutMs ?? 45_000, 2_000), 180_000);
    const token = `SHIBA${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const marker = `__SHIBA_DONE_${token}__`;
    const st = state();

    const resultPromise = new Promise<{ output: string; code: number | null; timedOut: boolean; aborted?: boolean }>((resolve) => {
      let settled = false;
      const finish = (result: { output: string; code: number | null; timedOut: boolean; aborted?: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        st.commandWaiters = st.commandWaiters.filter((x) => x !== waiter);
        opts?.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => {
        // This command owns the current terminal waiter; Ctrl+C stops the
        // foreground process while preserving the shared shell session.
        session.proc.write('\x03');
        finish({ output: waiter.buf, code: null, timedOut: false, aborted: true });
      };
      const waiter: TerminalServerState['commandWaiters'][number] = {
        marker,
        startedAt: Date.now(),
        buf: '',
        resolve: finish,
        timer: setTimeout(() => {
          finish({ output: waiter.buf, code: null, timedOut: true });
        }, timeoutMs),
      };
      st.commandWaiters.push(waiter);
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts?.signal?.aborted) onAbort();
    });

    // Run the command, then emit a unique marker + exit code the waiter can match.
    // Prefer simple `echo MARKER:$?` (works on Git Bash / WSL / macOS / Linux).
    const kind = session.shell.kind;
    const safe = cmd.replace(/\r?\n/g, '; ');
    let payload: string;
    if (kind === 'powershell' || kind === 'cmd') {
      const escaped = safe.replace(/"/g, '`"');
      payload = `${escaped}\rWrite-Output "${marker}:$LASTEXITCODE"\r`;
    } else {
      // Enter the command, then a second line that always prints the marker.
      // Using plain echo avoids printf quoting issues under ConPTY / Git Bash.
      payload = `${safe}\recho ${marker}:$?\r`;
    }

    // Annotate UI only — do not type the note into the shell (it would execute).
    injectUiNote(session, `[shiba · terminal_exec] ${cmd}`);
    session.proc.write(payload);

    const result = await resultPromise;
    // Strip ANSI for tool result (keep a readable slice).
    const plain = result.output
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\r/g, '');
    // Drop the echoed command annotation line noise at the start if present
    const cleaned = plain.replace(/^\s*\[shiba · terminal_exec\][^\n]*\n?/, '');

    return {
      ok: !result.timedOut && !result.aborted,
      output: cleaned.slice(-12_000),
      code: result.code,
      timedOut: result.timedOut,
      pid: session.proc.pid,
      shell: session.shell.label,
      ...(result.aborted ? { error: 'Aborted' } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      output: '',
      code: null,
      timedOut: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Force-kill and respawn the main session (user-requested restart). */
export function restartMainSession(): { ok: boolean; error?: string; pid?: number } {
  try {
    const st = state();
    const old = st.sessions.get(MAIN_SESSION_ID);
    if (old) {
      old.alive = false;
      try {
        old.proc.kill();
      } catch {
        /* ignore */
      }
      for (const ws of [...old.clients]) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      st.sessions.delete(MAIN_SESSION_ID);
    }
    const session = ensureMainSession();
    return { ok: true, pid: session.proc.pid };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** True for loopback, this app's exact public origin, or trusted-LAN Studio. */
export function isAllowedTerminalOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const publicOrigin = configuredPublicOrigin();
    if (
      publicOrigin
      && publicTerminalProxyEnabled()
      && parsed.origin === publicOrigin.origin
    ) return true;
    const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    if (process.env.SHIBA_LAN_STUDIO !== '1') return advertisedHostnames().includes(host);
    const allowedHosts = new Set(advertisedHostnames());
    if (process.env.SHIBA_LAN_IP?.trim()) allowedHosts.add(process.env.SHIBA_LAN_IP.trim().toLowerCase());
    for (const list of Object.values(os.networkInterfaces())) {
      for (const entry of list || []) {
        if (!entry.internal && entry.address) allowedHosts.add(entry.address.toLowerCase());
      }
    }
    const expectedPort = String(Number(process.env.SHIBA_APP_PORT || process.env.PORT || 3000) || 3000);
    const actualPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && actualPort === expectedPort
      && allowedHosts.has(host);
  } catch {
    return false;
  }
}

function isLoopbackSocketAddress(address: string | undefined): boolean {
  const normalized = (address || '').toLowerCase();
  return normalized === '::1'
    || normalized === 'localhost'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    || /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized);
}

function attachAuthorizedClient(ws: WebSocket, req: IncomingMessage): void {
  // When public proxying is enabled, require a browser Origin even though the
  // final proxy-to-terminal hop is loopback. Otherwise an origin-less public
  // client would be indistinguishable from a trusted local process.
  const origin = req.headers.origin;
  const missingRequiredOrigin = !origin && (
    publicTerminalProxyEnabled() || !isLoopbackSocketAddress(req.socket.remoteAddress)
  );
  if (missingRequiredOrigin || (origin && !isAllowedTerminalOrigin(origin))) {
    console.warn(`[shiba-studio] rejected terminal WS from origin ${origin || '(missing)'}`);
    ws.close(1008, 'Forbidden origin');
    return;
  }
  attachClient(ws);
}

/**
 * Start the localhost WebSocket PTY bridge. Idempotent across HMR.
 * Binds 127.0.0.1 only — not exposed on the LAN.
 */
export function startTerminalServer(): { port: number; host: string; shell: TerminalShell } {
  const st = state();
  const shell = resolveTerminalShell();
  st.shell = shell;

  if (st.started && st.wss) {
    // Eagerly ensure session so tools work before any UI connects.
    try {
      ensureMainSession();
    } catch {
      /* spawn may fail until first use */
    }
    return { port: st.port, host: st.host, shell };
  }

  const wss = new WebSocketServer({
    host: st.host,
    port: st.port,
    perMessageDeflate: false,
  });

  wss.on('connection', (ws, req) => {
    // WebSockets are not subject to CORS. Validate browser Origin here; the
    // shared helper also rejects missing Origin once a public proxy is enabled.
    attachAuthorizedClient(ws, req);
  });

  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EADDRINUSE') {
      // Another server instance already owns the port — keep local session tools
      // working; UI may connect to the existing WS bridge.
      console.warn(
        `[shiba-studio] terminal WS port ${st.port} already in use — reusing existing bridge if running`,
      );
      st.started = true;
      return;
    }
    console.error('[shiba-studio] terminal WebSocket error', err);
  });

  st.wss = wss;
  st.started = true;

  try {
    ensureMainSession();
  } catch (e) {
    console.error('[shiba-studio] terminal session spawn deferred', e);
  }

  console.log(
    `[shiba-studio] real terminal PTY on ws://${st.host}:${st.port} · shared session "${MAIN_SESSION_ID}" · ${shell.label}`,
  );
  return { port: st.port, host: st.host, shell };
}

export function getTerminalServerInfo() {
  const st = state();
  const shell = st.shell || resolveTerminalShell();
  const main = st.sessions.get(MAIN_SESSION_ID);
  return {
    running: st.started && !!st.wss,
    host: st.host,
    port: st.port,
    wsUrl: `ws://${st.host}:${st.port}`,
    sessions: main ? 1 : 0,
    clients: main?.clients.size ?? 0,
    pid: main?.alive ? main.proc.pid : null,
    sessionId: MAIN_SESSION_ID,
    shell: terminalShellPublicInfo(main?.shell || shell),
  };
}

/** Optional: attach upgrade handler if you ever use a custom HTTP server. */
export function attachTerminalUpgrade(server: HttpServer) {
  const st = state();
  if (st.started && st.wss) return;
  const shell = resolveTerminalShell();
  st.shell = shell;
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/terminal/ws')) {
      return;
    }
    wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  wss.on('connection', (ws, req) => attachAuthorizedClient(ws, req));
  st.wss = wss;
  st.started = true;
  try {
    ensureMainSession();
  } catch {
    /* defer */
  }
}
