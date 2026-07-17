import { NextRequest, NextResponse } from 'next/server';
import { audit } from '@/lib/audit-log';
import {
  applyIdeGitAction,
  getIdeGitFileDiff,
  getIdeGitSnapshot,
  IdeGitError,
  type IdeGitAction,
  type IdeGitDiffArea,
} from '@/lib/ide-git';
import { loadConfig } from '@/lib/persistence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE_HEADERS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requestWorkspace(explicit: unknown): Promise<string> {
  const requested = typeof explicit === 'string' ? explicit.trim() : '';
  if (requested) return requested;
  const config = await loadConfig();
  const fallback = String(config.defaultWorkspace || '').trim();
  if (!fallback) {
    throw new IdeGitError(
      'No workspace was provided and no default workspace is configured.',
      'WORKSPACE_REQUIRED',
      400,
    );
  }
  return fallback;
}

function pathsFrom(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new IdeGitError('paths must be an array of repository-relative strings.', 'INVALID_PATHS', 400);
  }
  return value as string[];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IdeGitError(`${label} is required.`, `INVALID_${label.toUpperCase().replace(/\s+/g, '_')}`, 400);
  }
  return value;
}

function parseAction(body: Record<string, unknown>): IdeGitAction {
  const action = typeof body.action === 'string' ? body.action : '';
  switch (action) {
    case 'stage':
    case 'unstage':
    case 'discard':
      return { action, paths: pathsFrom(body.paths) };
    case 'commit':
      return { action, message: requiredString(body.message, 'commit message') };
    case 'pull':
    case 'push':
      return { action };
    case 'fetch':
      return {
        action,
        ...(typeof body.remote === 'string' && body.remote.trim()
          ? { remote: body.remote.trim() }
          : {}),
      };
    case 'checkout':
      return { action, branch: requiredString(body.branch, 'branch') };
    case 'createBranch':
      return {
        action,
        branch: requiredString(body.branch, 'branch'),
        ...(typeof body.startPoint === 'string' && body.startPoint.trim()
          ? { startPoint: body.startPoint.trim() }
          : {}),
      };
    default:
      throw new IdeGitError(`Unknown IDE Git action "${action || '(missing)'}".`, 'UNKNOWN_GIT_ACTION', 400);
  }
}

function publicError(error: unknown) {
  if (error instanceof IdeGitError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status);
  }
  console.error('[shiba-studio] IDE Git request failed', error);
  return json({ ok: false, error: 'IDE Git request failed.', code: 'IDE_GIT_INTERNAL_ERROR' }, 500);
}

function auditMeta(action: IdeGitAction, result: Awaited<ReturnType<typeof applyIdeGitAction>>) {
  const meta: Record<string, unknown> = {
    action: action.action,
    branch: result.snapshot.head.branch,
  };
  if ('paths' in action) meta.pathCount = action.paths.length;
  if ('branch' in action) meta.targetBranch = action.branch;
  if ('remote' in action && action.remote) meta.remote = action.remote;
  if (result.commitOid) meta.commitOid = result.commitOid;
  return meta;
}

export async function GET(req: NextRequest) {
  try {
    const workspace = await requestWorkspace(req.nextUrl.searchParams.get('workspace'));
    const view = req.nextUrl.searchParams.get('view') || 'snapshot';
    if (view === 'snapshot') {
      const requestedCount = Number(req.nextUrl.searchParams.get('recentCommits') || 25);
      const recentCommitCount = Number.isFinite(requestedCount)
        ? Math.max(1, Math.min(50, Math.floor(requestedCount)))
        : 25;
      const snapshot = await getIdeGitSnapshot(workspace, { recentCommitCount });
      return json({ ok: true, snapshot });
    }
    if (view === 'diff') {
      const filePath = req.nextUrl.searchParams.get('path') || '';
      if (!filePath) {
        throw new IdeGitError('path is required for a file diff.', 'DIFF_PATH_REQUIRED', 400);
      }
      const rawArea = req.nextUrl.searchParams.get('area') || 'working';
      if (rawArea !== 'working' && rawArea !== 'staged') {
        throw new IdeGitError('area must be "working" or "staged".', 'INVALID_DIFF_AREA', 400);
      }
      const diff = await getIdeGitFileDiff(workspace, filePath, rawArea as IdeGitDiffArea);
      return json({ ok: true, diff });
    }
    throw new IdeGitError(`Unknown IDE Git view "${view}".`, 'UNKNOWN_GIT_VIEW', 400);
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await req.json().catch(() => null) as unknown;
    if (!isRecord(parsed)) {
      throw new IdeGitError('A JSON object request body is required.', 'INVALID_JSON_BODY', 400);
    }
    const workspace = await requestWorkspace(parsed.workspace);
    const action = parseAction(parsed);
    const result = await applyIdeGitAction(workspace, action);
    audit(
      'workspace',
      `ide git ${action.action}`,
      result.snapshot.repoRoot,
      auditMeta(action, result),
    );
    return json({ ok: true, ...result });
  } catch (error) {
    return publicError(error);
  }
}
