import { authenticatePhoneRequest, PhoneAssistantError } from '@/lib/phone-assistant';
import { encodeMcpSse, handlePhoneMcpPayload } from '@/lib/phone-mcp';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_BODY = 64_000;

function mcpHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'no-store');
  headers.set('MCP-Protocol-Version', '2025-03-26');
  return headers;
}

export async function GET(request: Request) {
  try {
    await authenticatePhoneRequest(request);
    return Response.json({
      ok: true,
      server: 'shiba-studio-phone',
      transport: 'streamable-http',
    }, { headers: mcpHeaders() });
  } catch (error) {
    const status = error instanceof PhoneAssistantError ? error.status : 401;
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Unauthorized' }, {
      status,
      headers: mcpHeaders(),
    });
  }
}

export async function POST(request: Request) {
  try {
    await authenticatePhoneRequest(request);
    const raw = await request.text();
    if (raw.length > MAX_BODY) {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Payload too large' } }, {
        status: 413,
        headers: mcpHeaders(),
      });
    }
    const payload = raw ? JSON.parse(raw) as unknown : {};
    const body = await handlePhoneMcpPayload(payload);
    if (body == null) return new Response(null, { status: 202, headers: mcpHeaders() });
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
      return new Response(encodeMcpSse(body), {
        status: 200,
        headers: mcpHeaders({ 'Content-Type': 'text/event-stream' }),
      });
    }
    return Response.json(body, { headers: mcpHeaders({ 'Content-Type': 'application/json' }) });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, {
        status: 400,
        headers: mcpHeaders(),
      });
    }
    const status = error instanceof PhoneAssistantError ? error.status : 400;
    return Response.json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: error instanceof Error ? error.message : 'MCP request failed' },
    }, { status, headers: mcpHeaders() });
  }
}

export async function DELETE(request: Request) {
  try {
    await authenticatePhoneRequest(request);
    return new Response(null, { status: 204, headers: mcpHeaders() });
  } catch (error) {
    const status = error instanceof PhoneAssistantError ? error.status : 401;
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Unauthorized' }, {
      status,
      headers: mcpHeaders(),
    });
  }
}
