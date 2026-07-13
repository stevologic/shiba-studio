import { NextRequest, NextResponse } from 'next/server';
import {
  compactContextScope,
  inspectContextScope,
  isContextScopeType,
  prepareSessionContext,
  setContextSourcePinned,
} from '@/lib/context-engine';

type Params = { scopeType: string; scopeId: string };

async function readParams(context: { params: Promise<Params> }) {
  const params = await context.params;
  if (!isContextScopeType(params.scopeType)) throw new Error('Invalid context scope type');
  const scopeId = decodeURIComponent(params.scopeId || '').trim();
  if (!scopeId) throw new Error('scopeId is required');
  return { scopeType: params.scopeType, scopeId };
}

export async function GET(req: NextRequest, context: { params: Promise<Params> }) {
  try {
    const { scopeType, scopeId } = await readParams(context);
    let previewMeter: ReturnType<typeof prepareSessionContext>['meter'] | undefined;
    if (scopeType === 'session' && req.nextUrl.searchParams.get('preview') === '1') {
      const { getChatSession } = await import('@/lib/chat-sessions');
      const session = await getChatSession(scopeId);
      if (session) {
        previewMeter = prepareSessionContext({
          sessionId: session.id,
          projectId: session.projectId,
          messages: session.messages,
          model: req.nextUrl.searchParams.get('model') || session.chatModel,
        }).meter;
      }
    }
    return NextResponse.json({
      ok: true,
      scope: inspectContextScope(scopeType, scopeId, {
        sourceLimit: Number(req.nextUrl.searchParams.get('limit') || 200),
        sourceOffset: Number(req.nextUrl.searchParams.get('offset') || 0),
      }),
      previewMeter,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Context inspection failed' },
      { status: 400 },
    );
  }
}

export async function POST(req: NextRequest, context: { params: Promise<Params> }) {
  try {
    const { scopeType, scopeId } = await readParams(context);
    const body = await req.json() as Record<string, unknown>;
    const action = String(body.action || 'compact');
    if (action === 'compact' || action === 'regenerate') {
      const compactions = compactContextScope(scopeType, scopeId, {
        keepRecent: body.keepRecent == null ? undefined : Number(body.keepRecent),
        batchSize: body.batchSize == null ? undefined : Number(body.batchSize),
      });
      return NextResponse.json({ ok: true, compactions, scope: inspectContextScope(scopeType, scopeId) });
    }
    if (action === 'pin') {
      const source = setContextSourcePinned(
        String(body.sourceId || ''),
        body.pinned !== false,
        { scopeType, scopeId },
      );
      return NextResponse.json({ ok: true, source, scope: inspectContextScope(scopeType, scopeId, { sourceLimit: 100 }) });
    }
    throw new Error('Unknown context action');
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Context action failed' },
      { status: 400 },
    );
  }
}
