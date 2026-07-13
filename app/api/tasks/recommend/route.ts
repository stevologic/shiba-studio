import { recommendTaskMode } from '@/lib/task-router';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return Response.json({
      ok: true,
      recommendation: recommendTaskMode({
        outcome: String(body.outcome || ''),
        attachmentNames: Array.isArray(body.attachmentNames) ? body.attachmentNames : [],
        hasWorkspace: body.hasWorkspace === true,
      }),
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid recommendation request' }, { status: 400 });
  }
}
