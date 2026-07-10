'use client';

/**
 * Global real host terminal — xterm.js client wired to the shared node-pty
 * WebSocket session. Session + open state survive page navigations.
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal as TermIcon, X, Maximize2, Minimize2, RefreshCw, ChevronDown } from 'lucide-react';
import {
  getTerminalOpen,
  getTerminalOpenServerSnapshot,
  hydrateTerminalOpen,
  setTerminalOpen,
  subscribeTerminalOpen,
  toggleTerminalOpen,
} from '@/lib/terminal-ui-store';

type TerminalInfo = {
  ok?: boolean;
  running?: boolean;
  wsUrl?: string;
  shell?: { label?: string; kind?: string; file?: string; cwd?: string; platform?: string };
  pid?: number | null;
  sessionId?: string;
  error?: string;
};

const HEIGHT_KEY = 'shiba-terminal-height';
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 160;
const MAX_HEIGHT_RATIO = 0.75;

/**
 * Traditional readable monospace — IBM Plex Mono (--font-terminal) with
 * classic system fallbacks (Cascadia / Consolas / Menlo / SF Mono).
 */
const TERMINAL_FONT_FAMILY =
  'var(--font-terminal), "IBM Plex Mono", "Cascadia Mono", "Cascadia Code", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace';
const TERMINAL_FONT_SIZE = 13;
const TERMINAL_LETTER_SPACING = 0;

/** Module-level connection — survives component remounts across navigations. */
type TerminalRuntime = {
  term: import('@xterm/xterm').Terminal | null;
  fit: import('@xterm/addon-fit').FitAddon | null;
  ws: WebSocket | null;
  dataDisposable: { dispose: () => void } | null;
  connecting: boolean;
  status: 'idle' | 'connecting' | 'ready' | 'error' | 'closed';
  statusDetail: string;
  info: TerminalInfo | null;
  listeners: Set<() => void>;
};

const runtime: TerminalRuntime = {
  term: null,
  fit: null,
  ws: null,
  dataDisposable: null,
  connecting: false,
  status: 'idle',
  statusDetail: '',
  info: null,
  listeners: new Set(),
};

function notifyRuntime() {
  for (const l of runtime.listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

function setRuntimeStatus(
  status: TerminalRuntime['status'],
  detail?: string,
  info?: TerminalInfo | null,
) {
  runtime.status = status;
  if (detail !== undefined) runtime.statusDetail = detail;
  if (info !== undefined) runtime.info = info;
  notifyRuntime();
}

function fitTerminal() {
  const fitAddon = runtime.fit;
  const term = runtime.term;
  const ws = runtime.ws;
  if (!fitAddon || !term) return;
  try {
    fitAddon.fit();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  } catch {
    /* not attached */
  }
}

function disconnectWs(opts?: { clearStatus?: boolean }) {
  const ws = runtime.ws;
  runtime.ws = null;
  runtime.connecting = false;
  if (ws) {
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    } catch {
      /* ignore */
    }
  }
  if (opts?.clearStatus !== false) {
    setRuntimeStatus('closed', 'Disconnected');
  }
}

async function connectWs() {
  if (typeof window === 'undefined') return;
  if (runtime.connecting) return;
  if (runtime.ws && runtime.ws.readyState === WebSocket.OPEN) {
    fitTerminal();
    return;
  }

  disconnectWs({ clearStatus: false });
  runtime.connecting = true;
  setRuntimeStatus('connecting', 'Starting PTY bridge…');

  let meta: TerminalInfo;
  try {
    const res = await fetch('/api/terminal', { cache: 'no-store' });
    meta = (await res.json()) as TerminalInfo;
    runtime.info = meta;
    if (!res.ok || !meta.wsUrl) {
      runtime.connecting = false;
      setRuntimeStatus('error', meta.error || 'Terminal API failed', meta);
      runtime.term?.writeln(`\r\n\x1b[31m[shiba] ${meta.error || 'Terminal API failed'}\x1b[0m`);
      return;
    }
  } catch (e) {
    runtime.connecting = false;
    const message = e instanceof Error ? e.message : String(e);
    setRuntimeStatus('error', message);
    runtime.term?.writeln(`\r\n\x1b[31m[shiba] ${message}\x1b[0m`);
    return;
  }

  setRuntimeStatus('connecting', `Connecting ${meta.wsUrl}…`, meta);
  const ws = new WebSocket(meta.wsUrl!);
  runtime.ws = ws;

  ws.onopen = () => {
    setRuntimeStatus('connecting', 'Attaching to shared session…');
    const term = runtime.term;
    if (term) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };

  ws.onmessage = (ev) => {
    let msg: {
      type?: string;
      data?: string;
      message?: string;
      shell?: TerminalInfo['shell'];
      code?: number;
      pid?: number;
      resumed?: boolean;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      runtime.term?.write(String(ev.data));
      return;
    }
    if (msg.type === 'output' && typeof msg.data === 'string') {
      runtime.term?.write(msg.data);
      return;
    }
    if (msg.type === 'ready') {
      runtime.connecting = false;
      // Resumed session: reset view then server scrollback will repaint (next outputs).
      if (msg.resumed && runtime.term) {
        try {
          runtime.term.reset();
        } catch {
          /* ignore */
        }
      }
      const label = msg.shell?.label || meta.shell?.label || 'shell';
      const pid = msg.pid ?? meta.pid;
      setRuntimeStatus(
        'ready',
        `${label} · pid ${pid ?? '—'} · shared session`,
        {
          ...meta,
          shell: msg.shell || meta.shell,
          pid: pid ?? null,
          sessionId: msg.sessionId || meta.sessionId,
        },
      );
      requestAnimationFrame(() => fitTerminal());
      return;
    }
    if (msg.type === 'error') {
      runtime.connecting = false;
      setRuntimeStatus('error', msg.message || 'PTY error');
      runtime.term?.writeln(`\r\n\x1b[31m[shiba] ${msg.message || 'PTY error'}\x1b[0m`);
      return;
    }
    if (msg.type === 'exit') {
      runtime.connecting = false;
      setRuntimeStatus('closed', `Shell exited (${msg.code ?? '?'})`);
      runtime.term?.writeln(
        `\r\n\x1b[33m[shiba] shell exited with code ${msg.code ?? '?'} — reconnect to spawn a new session\x1b[0m`,
      );
    }
  };

  ws.onerror = () => {
    runtime.connecting = false;
    setRuntimeStatus('error', 'WebSocket error — is the PTY bridge running?');
  };

  ws.onclose = () => {
    if (runtime.ws === ws) runtime.ws = null;
    runtime.connecting = false;
    if (runtime.status === 'ready' || runtime.status === 'connecting') {
      setRuntimeStatus('closed', 'Connection closed — session kept on server');
    }
  };
}

async function ensureXterm(host: HTMLDivElement) {
  if (runtime.term) {
    // Keep font in sync if the module-level instance outlived a hot reload.
    try {
      runtime.term.options.fontFamily = TERMINAL_FONT_FAMILY;
      runtime.term.options.fontSize = TERMINAL_FONT_SIZE;
      runtime.term.options.lineHeight = 1.25;
      runtime.term.options.letterSpacing = TERMINAL_LETTER_SPACING;
      runtime.term.options.cursorStyle = 'block';
    } catch {
      /* ignore */
    }
    if (!host.contains(runtime.term.element || null)) {
      // Re-parent into the current host after a React remount.
      runtime.term.open(host);
    }
    fitTerminal();
    return;
  }

  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
  ]);
  await import('@xterm/xterm/css/xterm.css');

  if (runtime.term) {
    // Race: another mount finished first
    const existing = runtime.term as import('@xterm/xterm').Terminal;
    if (!host.contains((existing as { element?: HTMLElement | null }).element || null)) {
      existing.open(host);
    }
    fitTerminal();
    return;
  }

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: 1.25,
    letterSpacing: TERMINAL_LETTER_SPACING,
    theme: {
      background: '#0a0a0a',
      foreground: '#f5f5f5',
      cursor: '#ffffff',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(255,255,255,0.22)',
      black: '#000000',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#eab308',
      blue: '#a3a3a3',
      magenta: '#d4d4d4',
      cyan: '#a3a3a3',
      white: '#f5f5f5',
      brightBlack: '#737373',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#facc15',
      brightBlue: '#e5e5e5',
      brightMagenta: '#f5f5f5',
      brightCyan: '#e5e5e5',
      brightWhite: '#ffffff',
    },
    allowProposedApi: true,
    scrollback: 5000,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(host);
  runtime.term = term;
  runtime.fit = fitAddon;
  runtime.dataDisposable?.dispose();
  runtime.dataDisposable = term.onData((data) => {
    const ws = runtime.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });
  term.writeln('\x1b[90m[shiba] shared host PTY — survives navigation · chat tools can drive this shell\x1b[0m');
  fitAddon.fit();
}

/**
 * Mount once in the root layout. Open state is shared via terminal-ui-store.
 */
export default function StudioTerminal() {
  const open = useSyncExternalStore(
    subscribeTerminalOpen,
    getTerminalOpen,
    getTerminalOpenServerSnapshot,
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [, bump] = useState(0);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [maximized, setMaximized] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Subscribe to runtime status for UI chrome.
  useEffect(() => {
    const onChange = () => bump((n) => n + 1);
    runtime.listeners.add(onChange);
    return () => {
      runtime.listeners.delete(onChange);
    };
  }, []);

  // Restore open/height from storage after hydrate (never during SSR render).
  useEffect(() => {
    hydrateTerminalOpen();
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HEIGHT_KEY);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= MIN_HEIGHT) setHeight(n);
    } catch {
      /* private mode */
    }
  }, []);

  const persistHeight = useCallback((h: number) => {
    setHeight(h);
    try {
      window.localStorage.setItem(HEIGHT_KEY, String(h));
    } catch {
      /* ignore */
    }
  }, []);

  // Keyboard shortcut (global)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === '`' || e.key === '~')) {
        e.preventDefault();
        toggleTerminalOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep xterm + WS alive while panel is open OR was previously connected.
  // When closed we keep the WS so tools still stream output into the buffer;
  // user reopening shows history without a new shell.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Always ensure connection once in the browser so chat tools' session is warm.
      if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) {
        // Defer connect until first open or first ensure — still connect early for tools UX
      }
      if (open && hostRef.current) {
        await ensureXterm(hostRef.current);
        if (cancelled) return;
        await connectWs();
        fitTerminal();
      } else if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) {
        // Warm shared session without UI (tools can still write; UI attaches later).
        // Skip auto-connect when never opened — tools call ensure on server side.
      }
    })();
    return () => {
      cancelled = true;
      // Intentionally do NOT dispose term/ws on unmount — survives navigation.
    };
  }, [open]);

  // When opening, re-attach host and fit.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      if (!hostRef.current) return;
      await ensureXterm(hostRef.current);
      if (cancelled) return;
      if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) {
        await connectWs();
      } else {
        fitTerminal();
      }
      setTimeout(fitTerminal, 50);
      setTimeout(fitTerminal, 200);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, height, maximized]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => fitTerminal();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - e.clientY;
      const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
      const next = Math.min(maxH, Math.max(MIN_HEIGHT, dragRef.current.startH + delta));
      persistHeight(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      fitTerminal();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [persistHeight]);

  const panelHeight = maximized
    ? Math.floor(typeof window !== 'undefined' ? window.innerHeight * 0.85 : 600)
    : height;

  const status = runtime.status;
  const statusDetail = runtime.statusDetail;
  const info = runtime.info;
  const statusTone =
    status === 'ready'
      ? 'text-success'
      : status === 'error'
        ? 'text-error'
        : status === 'connecting'
          ? 'text-warning'
          : 'text-dim';

  // Launcher lives in the top nav only (no bottom-right FAB overlay).
  return (
    <>
      {open && (
        <div
          className="studio-terminal-panel"
          style={{ height: panelHeight }}
          role="dialog"
          aria-label="Host terminal"
        >
          <div
            className="studio-terminal-resize"
            onMouseDown={(e) => {
              e.preventDefault();
              dragRef.current = { startY: e.clientY, startH: height };
              document.body.style.cursor = 'ns-resize';
              document.body.style.userSelect = 'none';
              setMaximized(false);
            }}
            title="Drag to resize"
          />
          <div className="studio-terminal-bar">
            <div className="studio-terminal-bar-left">
              <TermIcon size={14} className="opacity-80 shrink-0" />
              <span className="studio-terminal-title">
                {info?.shell?.label || 'Terminal'}
              </span>
              <span className={`text-[11px] ${statusTone} truncate max-w-[40vw]`}>
                {statusDetail || status}
              </span>
            </div>
            <div className="studio-terminal-bar-right">
              <button
                type="button"
                className="grok-btn grok-btn-ghost p-1.5"
                title="Reconnect to shared session"
                onClick={() => {
                  runtime.term?.writeln('\r\n\x1b[90m[shiba] reconnecting to shared session…\x1b[0m');
                  void connectWs();
                }}
              >
                <RefreshCw size={14} />
              </button>
              <button
                type="button"
                className="grok-btn grok-btn-ghost p-1.5"
                title="Restart shell (new session)"
                onClick={() => {
                  void (async () => {
                    try {
                      await fetch('/api/terminal', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'restart' }),
                      });
                      runtime.term?.writeln('\r\n\x1b[90m[shiba] session restarted\x1b[0m');
                      void connectWs();
                    } catch (e) {
                      runtime.term?.writeln(
                        `\r\n\x1b[31m[shiba] restart failed: ${e instanceof Error ? e.message : e}\x1b[0m`,
                      );
                    }
                  })();
                }}
              >
                <span className="text-[10px] font-semibold px-0.5">RST</span>
              </button>
              <button
                type="button"
                className="grok-btn grok-btn-ghost p-1.5"
                title={maximized ? 'Restore' : 'Maximize'}
                onClick={() => setMaximized((v) => !v)}
              >
                {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                type="button"
                className="grok-btn grok-btn-ghost p-1.5"
                title="Minimize (keeps session)"
                onClick={() => setTerminalOpen(false)}
              >
                <ChevronDown size={14} />
              </button>
              <button
                type="button"
                className="grok-btn grok-btn-ghost p-1.5"
                title="Hide terminal (session stays alive)"
                onClick={() => setTerminalOpen(false)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <div ref={hostRef} className="studio-terminal-xterm" />
        </div>
      )}
    </>
  );
}
