import { exportRoutine } from '@/lib/routines';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const format = new URL(request.url).searchParams.get('format') === 'yaml' ? 'yaml' : 'json';
    const body = exportRoutine(id, format);
    return new Response(body, {
      headers: {
        'Content-Type': format === 'yaml' ? 'application/yaml; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="routine-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.${format === 'yaml' ? 'yaml' : 'json'}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Routine export failed';
    return Response.json({ ok: false, error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
