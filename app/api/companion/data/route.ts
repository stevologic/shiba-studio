import { authenticateCompanion, CompanionAuthError, listCompanionVoiceActions } from '@/lib/companion-auth';
import {
  companionAttentionSummaries,
  companionRoutineSummaries,
  companionTaskSummaries,
} from '@/lib/companion-projection';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = await authenticateCompanion(request);
    const [tasks, attention, routines] = await Promise.all([
      auth.scopes.has('read:tasks') ? Promise.resolve(companionTaskSummaries()) : Promise.resolve([]),
      auth.scopes.has('read:attention') ? Promise.resolve(companionAttentionSummaries()) : Promise.resolve([]),
      auth.scopes.has('read:routines') ? Promise.resolve(companionRoutineSummaries()) : Promise.resolve([]),
    ]);
    return Response.json({
      ok: true,
      device: { id: auth.device.id, name: auth.device.name, scopes: auth.device.scopes },
      syncedAt: new Date().toISOString(),
      tasks,
      attention,
      routines,
      voiceRequests: auth.scopes.has('action:voice') ? listCompanionVoiceActions(auth.device.id, 10) : [],
    }, {
      headers: {
        'Cache-Control': 'no-store',
        Vary: 'Authorization',
      },
    });
  } catch (error) {
    const status = error instanceof CompanionAuthError ? error.status : 400;
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Companion sync failed',
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
