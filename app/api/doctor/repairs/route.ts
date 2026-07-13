import { applyDoctorRepair, previewDoctorRepair, type DoctorRepairAction } from '@/lib/doctor';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: DoctorRepairAction; confirm?: string; apply?: boolean };
    if (!body.action) throw new Error('Repair action is required');
    const preview = previewDoctorRepair(body.action);
    if (!body.apply) return Response.json({ ok: true, preview, requiresConfirmation: body.action });
    const result = await applyDoctorRepair(body.action, String(body.confirm || ''));
    return Response.json({ ok: true, preview, result });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Doctor repair failed' }, { status: 400 });
  }
}
