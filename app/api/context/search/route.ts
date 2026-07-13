import { NextRequest, NextResponse } from 'next/server';
import { isContextScopeType, searchContext } from '@/lib/context-engine';
import type { ContextScopeType } from '@/lib/context-types';

function runSearch(body: Record<string, unknown>) {
  const scopeTypeRaw = body.scopeType ? String(body.scopeType) : undefined;
  if (scopeTypeRaw && !isContextScopeType(scopeTypeRaw)) {
    throw new Error('scopeType must be session, project, or run');
  }
  const scopeType = scopeTypeRaw as ContextScopeType | undefined;
  return searchContext({
    query: String(body.query || ''),
    scopeType,
    scopeId: body.scopeId ? String(body.scopeId) : undefined,
    projectId: body.projectId ? String(body.projectId) : undefined,
    runId: body.runId ? String(body.runId) : undefined,
    maxResults: body.maxResults == null ? undefined : Number(body.maxResults),
    maxChars: body.maxChars == null ? undefined : Number(body.maxChars),
  });
}

export async function GET(req: NextRequest) {
  try {
    const query = req.nextUrl.searchParams;
    return NextResponse.json({
      ok: true,
      result: runSearch({
        query: query.get('q') || '',
        scopeType: query.get('scopeType') || undefined,
        scopeId: query.get('scopeId') || undefined,
        projectId: query.get('projectId') || undefined,
        runId: query.get('runId') || undefined,
        maxResults: query.get('limit') || undefined,
        maxChars: query.get('maxChars') || undefined,
      }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Context search failed' },
      { status: 400 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    return NextResponse.json({ ok: true, result: runSearch(body) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Context search failed' },
      { status: 400 },
    );
  }
}
