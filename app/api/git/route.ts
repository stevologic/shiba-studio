import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import { gitCheckout, gitCommit, gitCreatePr, gitStatus } from '@/lib/git-actions';
import { loadConfig } from '@/lib/persistence';
import { resolveWorkspace } from '@/lib/workspace';

/** Git actions for Grok Chat's /git commands — runs against the linked
 *  project workspace or the default workspace. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const cfg = await loadConfig();
    const requested = String(body.workspacePath || '').trim() || cfg.defaultWorkspace;
    if (!requested) {
      return NextResponse.json({ ok: false, error: 'No workspace — set a default workspace in Settings or link a project.' }, { status: 400 });
    }
    const cwd = resolveWorkspace(requested);
    if (!fs.existsSync(cwd)) {
      return NextResponse.json({ ok: false, error: `Workspace not found: ${cwd}` }, { status: 400 });
    }

    const action = String(body.action || '');
    let result: string;
    if (action === 'status') result = await gitStatus(cwd);
    else if (action === 'checkout') result = await gitCheckout(cwd, String(body.branch || ''));
    else if (action === 'commit') result = await gitCommit(cwd, String(body.message || ''));
    else if (action === 'pr') result = await gitCreatePr(cwd, String(body.title || ''), body.body ? String(body.body) : undefined);
    else return NextResponse.json({ ok: false, error: `Unknown git action "${action}"` }, { status: 400 });

    const { audit } = await import('@/lib/audit-log');
    audit('workspace', `git ${action}`, `${cwd}${body.branch ? ` · ${body.branch}` : ''}${body.title ? ` · ${body.title}` : ''}`);
    return NextResponse.json({ ok: true, result, cwd });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'git action failed' }, { status: 500 });
  }
}
