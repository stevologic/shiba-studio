import { NextRequest, NextResponse } from 'next/server';
import { audit } from '@/lib/audit-log';
import {
  createIdeGitHubIssue,
  createIdeGitHubPullRequest,
  getIdeGitHubSnapshot,
  IdeGitHubError,
} from '@/lib/ide-github';
import { loadConfig } from '@/lib/persistence';
import { resolveWorkspace } from '@/lib/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE_HEADERS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new IdeGitHubError(`${label} must be a string.`, 'INVALID_GITHUB_INPUT', 400);
  }
  return value;
}

async function requestContext(explicitWorkspace?: unknown) {
  const config = await loadConfig();
  const workspace = typeof explicitWorkspace === 'string' ? explicitWorkspace.trim() : '';
  const resolved = resolveWorkspace(workspace || config.defaultWorkspace || process.cwd());
  return {
    workspace: resolved,
    token: config.integrations?.github?.token,
  };
}

function publicError(error: unknown) {
  if (error instanceof IdeGitHubError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status);
  }
  console.error('[shiba-studio] IDE GitHub request failed', error);
  return json(
    { ok: false, error: 'IDE GitHub request failed.', code: 'IDE_GITHUB_INTERNAL_ERROR' },
    500,
  );
}

export async function GET(req: NextRequest) {
  try {
    const context = await requestContext(req.nextUrl.searchParams.get('workspace') || undefined);
    const snapshot = await getIdeGitHubSnapshot(context.workspace, context.token);
    return json({ ok: true, workspace: context.workspace, ...snapshot });
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await req.json().catch(() => null) as unknown;
    if (!isRecord(parsed)) {
      throw new IdeGitHubError(
        'A JSON object request body is required.',
        'INVALID_JSON_BODY',
        400,
      );
    }
    const action = typeof parsed.action === 'string' ? parsed.action : '';
    const context = await requestContext(parsed.workspace);

    if (action === 'create-pr') {
      const result = await createIdeGitHubPullRequest({
        workspace: context.workspace,
        token: context.token,
        title: optionalString(parsed.title, 'title') || '',
        body: optionalString(parsed.body, 'body'),
        base: optionalString(parsed.base, 'base'),
      });
      audit('workspace', 'GitHub pull request created', `${context.workspace} · #${result.number}`);
      return json({ ok: true, result });
    }

    if (action === 'create-issue') {
      const result = await createIdeGitHubIssue({
        workspace: context.workspace,
        token: context.token,
        title: optionalString(parsed.title, 'title') || '',
        body: optionalString(parsed.body, 'body'),
      });
      audit('workspace', 'GitHub issue created', `${context.workspace} · #${result.number}`);
      return json({ ok: true, result });
    }

    throw new IdeGitHubError(
      `Unsupported GitHub action "${action || '(missing)'}".`,
      'UNKNOWN_GITHUB_ACTION',
      400,
    );
  } catch (error) {
    return publicError(error);
  }
}
