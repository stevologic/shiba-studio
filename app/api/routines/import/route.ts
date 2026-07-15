import { loadAgents } from '@/lib/persistence';
import {
  parseRoutineImport,
  ROUTINE_IMPORT_MAX_BYTES,
  RoutineImportError,
  routineImportFormat,
} from '@/lib/routine-import';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const MULTIPART_ALLOWANCE_BYTES = 128 * 1024;

function errorResponse(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: RESPONSE_HEADERS });
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return errorResponse('Upload one exported automation file as multipart form data', 415);
  }

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > ROUTINE_IMPORT_MAX_BYTES + MULTIPART_ALLOWANCE_BYTES) {
    return errorResponse('Automation imports must be 2 MB or smaller', 413);
  }

  try {
    const form = await request.formData();
    const files = form.getAll('file');
    if (files.length !== 1 || !(files[0] instanceof File)) {
      return errorResponse('Choose exactly one exported automation file', 400);
    }

    const file = files[0];
    if (file.size === 0) return errorResponse('The selected automation file is empty', 400);
    if (file.size > ROUTINE_IMPORT_MAX_BYTES) return errorResponse('Automation imports must be 2 MB or smaller', 413);

    const format = routineImportFormat(file.name);
    if (!format) return errorResponse('Automation imports must use a .json, .yaml, or .yml file', 415);

    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      return errorResponse('The automation file must contain valid UTF-8 text', 400);
    }

    const agents = await loadAgents();
    const imported = parseRoutineImport(source, format, {
      availableAgentIds: new Set(agents.map((agent) => agent.id)),
    });
    return Response.json({ ok: true, ...imported }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof RoutineImportError) return errorResponse(error.message, 400);
    console.error('Automation import preview failed', error);
    return errorResponse('Could not import this automation file', 500);
  }
}
