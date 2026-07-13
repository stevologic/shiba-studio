import { promises as fs } from 'node:fs';
import { nativeNodeCapturePath, NativeNodeError, requireLocalNativeNodeAdmin } from '@/lib/native-nodes';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireLocalNativeNodeAdmin(request);
    const { id } = await context.params;
    const content = await fs.readFile(nativeNodeCapturePath(id));
    return new Response(new Uint8Array(content), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Capture not found' }, {
      status: error instanceof NativeNodeError ? error.status : 404,
    });
  }
}
