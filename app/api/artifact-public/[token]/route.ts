import { artifactVersionResponse, publicationAudienceAllowsRequest, resolvePublishedArtifact } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const published = resolvePublishedArtifact(token);
  if (!published) return Response.json({ ok: false, error: 'Publication not found, expired, or revoked' }, { status: 404 });
  if (!publicationAudienceAllowsRequest(published.publication, request)) {
    return Response.json({ ok: false, error: 'This publication is restricted to local and LAN access' }, { status: 403 });
  }
  const response = await artifactVersionResponse(published.artifact, published.version);
  // Revocation and takedown must take effect on the next request; never leave
  // bearer-token content in a browser or intermediary cache.
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
