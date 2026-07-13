import { rollbackArtifact } from '@/lib/artifacts';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    return Response.json({ ok: true, artifact: rollbackArtifact(id, String(body.versionId || '')) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not roll back artifact' }, { status: 400 });
  }
}
