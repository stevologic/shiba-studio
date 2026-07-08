import { NextRequest, NextResponse } from 'next/server';
import {
  getTerminalServerInfo,
  restartMainSession,
  runTerminalCommand,
  startTerminalServer,
  writeTerminal,
} from '@/lib/terminal-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/terminal — PTY bridge status + WebSocket URL for the client. */
export async function GET() {
  try {
    startTerminalServer();
    const info = getTerminalServerInfo();
    return NextResponse.json({
      ok: true,
      ...info,
      note: 'Shared host PTY via node-pty. Localhost WebSocket; session survives reconnects.',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        error: message,
        note: 'Install build tools if node-pty failed to load, or set SHIBA_TERMINAL_SHELL.',
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/terminal
 * body.action:
 *   - "exec" | omitted → run command in shared Studio terminal (chat/agent tools)
 *   - "write" → raw PTY write
 *   - "restart" → kill + respawn main session
 */
export async function POST(req: NextRequest) {
  try {
    startTerminalServer();
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'exec').toLowerCase();

    if (action === 'restart') {
      const r = restartMainSession();
      return NextResponse.json({ ok: r.ok, pid: r.pid, error: r.error, ...getTerminalServerInfo() });
    }

    if (action === 'write') {
      const data = String(body.data ?? body.text ?? '');
      if (!data) {
        return NextResponse.json({ ok: false, error: 'data required' }, { status: 400 });
      }
      const r = writeTerminal(data);
      return NextResponse.json({ ok: r.ok, error: r.error });
    }

    // exec
    const command = String(body.command || body.cmd || '').trim();
    if (!command) {
      return NextResponse.json({ ok: false, error: 'command required' }, { status: 400 });
    }
    const timeoutMs = body.timeoutMs != null ? Number(body.timeoutMs) : undefined;
    const result = await runTerminalCommand(command, { timeoutMs });
    return NextResponse.json({
      ok: result.ok && !result.timedOut && (result.code === 0 || result.code === null),
      ...result,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
