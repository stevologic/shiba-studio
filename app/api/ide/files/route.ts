import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { audit } from '@/lib/audit-log';
import {
  createIdeEntry,
  deleteIdeEntry,
  IDE_WORKSPACE_LIMITS,
  IdeWorkspaceError,
  listIdeDirectory,
  normalizeIdeRelativePath,
  normalizeIdeWorkspaceError,
  readIdeTextFile,
  renameIdeEntry,
  resolveIdeWorkspaceRoot,
  saveIdeTextFile,
  searchIdeWorkspace,
} from '@/lib/ide-workspace';
import { loadConfig } from '@/lib/persistence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdeWorkspaceError('INVALID_REQUEST', 'A JSON object body is required.', 400);
  }
  return value as JsonObject;
}

function requiredString(body: JsonObject, key: string, options: { allowEmpty?: boolean } = {}): string {
  const value = body[key];
  if (typeof value !== 'string' || (!options.allowEmpty && !value)) {
    throw new IdeWorkspaceError('INVALID_REQUEST', `"${key}" must be a string.`, 400);
  }
  return value;
}

function optionalString(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw new IdeWorkspaceError('INVALID_REQUEST', `"${key}" must be a string.`, 400);
  }
  return value;
}

function optionalBoolean(body: JsonObject, key: string): boolean | undefined {
  const value = body[key];
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw new IdeWorkspaceError('INVALID_REQUEST', `"${key}" must be a boolean.`, 400);
  }
  return value;
}

function searchLimit(value: string | null): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new IdeWorkspaceError('INVALID_REQUEST', '"limit" must be a positive integer.', 400);
  }
  return parsed;
}

async function workspaceInput(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const config = await loadConfig();
  return config.defaultWorkspace?.trim() || process.cwd();
}

async function readJsonBody(request: NextRequest): Promise<JsonObject> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > MAX_REQUEST_BODY_BYTES) {
      throw new IdeWorkspaceError('INVALID_REQUEST', 'The request body is too large.', 413);
    }
  }
  if (!request.body) {
    throw new IdeWorkspaceError('INVALID_REQUEST', 'A JSON request body is required.', 400);
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new IdeWorkspaceError('INVALID_REQUEST', 'The request body is too large.', 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return asObject(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof IdeWorkspaceError) throw error;
    throw new IdeWorkspaceError('INVALID_REQUEST', 'The request body is not valid JSON.', 400);
  }
}

function errorResponse(error: unknown): NextResponse {
  const normalized = normalizeIdeWorkspaceError(error);
  if (normalized.status >= 500) {
    console.error('[shiba-studio] IDE file operation failed', error);
  }
  return NextResponse.json(
    { ok: false, error: normalized.message, code: normalized.code },
    { status: normalized.status },
  );
}

export async function GET(request: NextRequest) {
  try {
    const action = request.nextUrl.searchParams.get('action') || 'bootstrap';
    const requestedWorkspace = await workspaceInput(
      request.nextUrl.searchParams.get('workspace') || undefined,
    );

    if (action === 'bootstrap') {
      const workspace = await resolveIdeWorkspaceRoot(requestedWorkspace);
      const listing = await listIdeDirectory(workspace);
      return NextResponse.json({
        ok: true,
        workspace,
        root: {
          path: '',
          name: path.basename(workspace) || workspace,
        },
        entries: listing.entries,
        truncated: listing.truncated,
        limits: IDE_WORKSPACE_LIMITS,
      });
    }

    if (action === 'list') {
      const listing = await listIdeDirectory(
        requestedWorkspace,
        request.nextUrl.searchParams.get('path') || '',
      );
      return NextResponse.json({ ok: true, ...listing });
    }

    if (action === 'read') {
      const file = await readIdeTextFile(
        requestedWorkspace,
        request.nextUrl.searchParams.get('path') || '',
      );
      return NextResponse.json({ ok: true, ...file });
    }

    if (action === 'search') {
      const result = await searchIdeWorkspace(
        requestedWorkspace,
        request.nextUrl.searchParams.get('q') || '',
        { limit: searchLimit(request.nextUrl.searchParams.get('limit')) },
      );
      return NextResponse.json({ ok: true, ...result });
    }

    throw new IdeWorkspaceError('INVALID_REQUEST', `Unknown IDE file action "${action}".`, 400);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonBody(request);
    const action = requiredString(body, 'action');
    const workspace = await workspaceInput(optionalString(body, 'workspace'));

    if (action === 'save') {
      const expectedVersion = optionalString(body, 'expectedVersion');
      if (expectedVersion && !/^[a-f0-9]{64}$/i.test(expectedVersion)) {
        throw new IdeWorkspaceError(
          'INVALID_REQUEST',
          '"expectedVersion" must be a SHA-256 version returned by the read endpoint.',
          400,
        );
      }
      const file = await saveIdeTextFile(
        workspace,
        requiredString(body, 'path'),
        requiredString(body, 'content', { allowEmpty: true }),
        expectedVersion,
      );
      audit(
        'workspace',
        'IDE file saved',
        `${file.workspace} · ${file.path}`,
        { workspace: file.workspace, path: file.path, size: file.size },
      );
      return NextResponse.json({ ok: true, ...file });
    }

    if (action === 'create') {
      const kind = optionalString(body, 'kind') || 'file';
      if (kind !== 'file' && kind !== 'directory') {
        throw new IdeWorkspaceError('INVALID_REQUEST', '"kind" must be "file" or "directory".', 400);
      }
      const entry = await createIdeEntry(
        workspace,
        requiredString(body, 'path'),
        kind,
        optionalString(body, 'content') || '',
      );
      const resolvedWorkspace = await resolveIdeWorkspaceRoot(workspace);
      audit(
        'workspace',
        `IDE ${kind} created`,
        `${resolvedWorkspace} · ${entry.path}`,
        { workspace: resolvedWorkspace, path: entry.path, kind },
      );
      return NextResponse.json(
        { ok: true, workspace: resolvedWorkspace, entry },
        { status: 201 },
      );
    }

    if (action === 'rename') {
      const sourcePath = normalizeIdeRelativePath(requiredString(body, 'path'));
      const entry = await renameIdeEntry(
        workspace,
        sourcePath,
        requiredString(body, 'newPath'),
      );
      const resolvedWorkspace = await resolveIdeWorkspaceRoot(workspace);
      audit(
        'workspace',
        'IDE entry renamed',
        `${resolvedWorkspace} · ${sourcePath} → ${entry.path}`,
        {
          workspace: resolvedWorkspace,
          sourcePath,
          destinationPath: entry.path,
          kind: entry.kind,
        },
      );
      return NextResponse.json({
        ok: true,
        workspace: resolvedWorkspace,
        entry,
      });
    }

    if (action === 'delete') {
      const recursive = optionalBoolean(body, 'recursive') || false;
      const deleted = await deleteIdeEntry(
        workspace,
        requiredString(body, 'path'),
        { recursive },
      );
      audit(
        'workspace',
        'IDE entry deleted',
        `${deleted.workspace} · ${deleted.path}`,
        {
          workspace: deleted.workspace,
          path: deleted.path,
          kind: deleted.kind,
          recursive,
        },
      );
      return NextResponse.json({ ok: true, workspace: deleted.workspace, deleted });
    }

    throw new IdeWorkspaceError('INVALID_REQUEST', `Unknown IDE file action "${action}".`, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
