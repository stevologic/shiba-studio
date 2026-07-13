import { createArtifactVersion } from '@/lib/artifacts';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    return Response.json({ ok: true, artifact: await createArtifactVersion(id, body.filePath) }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not create artifact version' }, { status: 400 });
  }
}
