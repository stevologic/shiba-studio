import { createArtifact, listArtifacts } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const taskId = new URL(request.url).searchParams.get('taskId') || undefined;
    return Response.json({ ok: true, artifacts: listArtifacts(taskId) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not list artifacts' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const artifact = await createArtifact({
      taskId: body.taskId,
      filePath: body.filePath,
      name: body.name,
      sourceLineage: body.sourceLineage,
      liveSource: body.liveSource,
      approveLiveSource: body.approveLiveSource === true,
    });
    return Response.json({ ok: true, artifact }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not create artifact' }, { status: 400 });
  }
}
