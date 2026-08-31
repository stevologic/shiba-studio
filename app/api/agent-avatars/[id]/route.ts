import { rawFileResponse } from '@/lib/serve-file';
import { parseImagineAvatarId } from '@/lib/agent-avatars';
import { readImagineAvatar } from '@/lib/agent-avatar-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/agent-avatars/<uuid>
 * Serve a Grok Imagine portrait stored for an agent. The uuid is the capability:
 * unknown, path-like, or missing files 404 rather than reading arbitrary disk.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let requested: string;
  try {
    requested = decodeURIComponent(id);
  } catch {
    return Response.json({ ok: false, error: 'Invalid avatar id' }, { status: 400 });
  }
  if (!parseImagineAvatarId(`imagine:${requested}`)) {
    return Response.json({ ok: false, error: 'Not an Imagine avatar' }, { status: 404 });
  }
  const file = await readImagineAvatar(requested);
  if (!file) return Response.json({ ok: false, error: 'Avatar not found' }, { status: 404 });
  const response = await rawFileResponse(file.absPath, file.name);
  response.headers.set('Cache-Control', 'private, max-age=86400, immutable');
  return response;
}
