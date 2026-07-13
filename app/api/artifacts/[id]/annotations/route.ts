import { addArtifactAnnotation, listArtifactAnnotations, resolveArtifactAnnotation } from '@/lib/artifacts';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return Response.json({ ok: true, annotations: listArtifactAnnotations(id) });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const annotation = resolveArtifactAnnotation(id, String(body.annotationId || ''), body.resolved !== false);
    return Response.json({ ok: true, annotation });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not update annotation' }, { status: 400 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const annotation = addArtifactAnnotation({ artifactId: id, versionId: body.versionId, locator: body.locator, comment: body.comment });
    return Response.json({ ok: true, annotation }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not add annotation' }, { status: 400 });
  }
}
