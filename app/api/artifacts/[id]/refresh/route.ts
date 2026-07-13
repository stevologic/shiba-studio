import { refreshLiveArtifact } from '@/lib/artifacts';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return Response.json({ ok: true, artifact: await refreshLiveArtifact(id) }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not refresh live artifact' }, { status: 400 });
  }
}
