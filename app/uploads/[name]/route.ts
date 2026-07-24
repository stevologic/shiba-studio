import { listGlobalUploadFiles } from '@/lib/workspace';
import { rawFileResponse } from '@/lib/serve-file';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /uploads/<name> → raw bytes of one global upload.
 *
 * Agents that generate a file into the global uploads folder naturally cite it
 * as `/uploads/<name>` in chat markdown; without this route every such image
 * rendered broken (repeated 404s in the server log).
 *
 * Serving follows the same capability rule as /api/files: the tracked list is
 * the capability. Only a name that appears in the current global-uploads
 * listing is served, so path traversal, absolute paths, and untracked files on
 * disk are all rejected by construction rather than by string matching.
 */
export async function GET(_request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  let requested: string;
  try {
    requested = decodeURIComponent(name);
  } catch {
    return Response.json({ ok: false, error: 'Invalid upload name' }, { status: 400 });
  }

  const files = await listGlobalUploadFiles();
  const match = files.find((file) => file.name === requested);
  if (!match) {
    return Response.json({ ok: false, error: 'Not a tracked global upload' }, { status: 404 });
  }
  return rawFileResponse(match.path, match.name);
}
