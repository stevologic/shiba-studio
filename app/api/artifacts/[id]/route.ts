import { getArtifact, listArtifactAnnotations } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const artifact = getArtifact(id);
  if (!artifact) return Response.json({ ok: false, error: 'Artifact not found' }, { status: 404 });
  return Response.json({ ok: true, artifact, annotations: listArtifactAnnotations(id) }, { headers: { 'Cache-Control': 'no-store' } });
}
