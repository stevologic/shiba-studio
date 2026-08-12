import { authenticatePhoneRequest, PhoneAssistantError } from '@/lib/phone-assistant';
import { executePhoneCommand, executePhoneTool } from '@/lib/phone-commands';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_BODY = 32_000;

export async function POST(request: Request) {
  try {
    await authenticatePhoneRequest(request);
    const raw = await request.text();
    if (raw.length > MAX_BODY) {
      return Response.json({ ok: false, error: 'Command payload is too large' }, { status: 413 });
    }
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const tool = String(body.tool || body.name || '').trim();
    const result = tool
      ? await executePhoneTool(tool, (body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
        ? body.arguments as Record<string, unknown>
        : body))
      : await executePhoneCommand(String(body.utterance || body.command || body.text || ''));
    return Response.json({ ok: result.ok, result }, {
      status: result.ok ? 200 : 422,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ ok: false, error: 'Command body must be JSON' }, { status: 400 });
    }
    const status = error instanceof PhoneAssistantError ? error.status : 400;
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Phone command failed',
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
