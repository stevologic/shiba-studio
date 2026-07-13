import { verifyArtifactVersion } from '@/lib/artifacts';

export async function POST(request: Request, context: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await context.params;
  try {
    const body = await request.json();
    const artifact = await verifyArtifactVersion({
      artifactId: id,
      versionId,
      passed: body.passed === true,
      renderer: String(body.renderer || 'human-review'),
      notes: String(body.notes || ''),
      metadata: body.metadata,
    });
    return Response.json({ ok: true, artifact });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not verify artifact' }, { status: 400 });
  }
}
