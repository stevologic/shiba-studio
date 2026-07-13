import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '@/lib/data-paths';
import { NativeNodeError, requireNativeNodeTransport } from '@/lib/native-nodes';
import { NATIVE_NODE_RELEASE_FILES } from '@/lib/native-node-release';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ file: string }> }) {
  try {
    requireNativeNodeTransport(request);
    const { file } = await context.params;
    if (!(NATIVE_NODE_RELEASE_FILES as readonly string[]).includes(file)) {
      throw new NativeNodeError('Native helper release file not found', 404);
    }
    const body = await fs.readFile(path.join(projectRoot(), 'scripts', 'native-node', file));
    const contentType = file.endsWith('.ps1') ? 'text/plain; charset=utf-8'
      : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${file}"`,
        'Cache-Control': 'public, max-age=3600, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Release unavailable' }, {
      status: error instanceof NativeNodeError ? error.status : 404,
    });
  }
}
