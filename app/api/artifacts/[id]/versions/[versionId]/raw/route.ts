import { artifactVersionResponse, getArtifact, getArtifactVersion } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await context.params;
  const artifact = getArtifact(id);
  const version = getArtifactVersion(id, versionId);
  if (!artifact || !version) return Response.json({ ok: false, error: 'Artifact version not found' }, { status: 404 });
  return artifactVersionResponse(artifact, version);
}
