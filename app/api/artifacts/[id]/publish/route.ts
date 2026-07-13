import { listArtifactPublications, publishArtifact, revokeArtifactPublications, takeDownArtifact } from '@/lib/artifacts';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return Response.json({ ok: true, publications: listArtifactPublications(id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not list publications' }, { status: 404 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    if (body.action === 'revoke') return Response.json({ ok: true, revoked: revokeArtifactPublications(id, body.publicationId) });
    if (body.action === 'takedown') return Response.json({ ok: true, artifact: takeDownArtifact(id) });
    const publication = publishArtifact({ artifactId: id, versionId: body.versionId, audience: body.audience || 'private_link', ttlHours: body.ttlHours });
    return Response.json({ ok: true, publication }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not publish artifact' }, { status: 400 });
  }
}
