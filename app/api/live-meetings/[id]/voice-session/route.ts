import { getLiveMeeting } from '@/lib/live-meetings';
import { LiveMeetingVoiceError, mintLiveMeetingVoiceSession } from '@/lib/live-meeting-voice';
import { GROK_VOICE_MODEL } from '@/lib/grok-voice';
import { resolveCloudBearer } from '@/lib/xai-oauth';
import { loadConfig } from '@/lib/persistence';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Mint a short-lived Grok Voice 2.0 token for the Meetings room.
 * The xAI API key stays on the host. LAN clients cannot reach this route
 * (proxy companion allowlist). Live Meeting audio is never stored.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const meeting = getLiveMeeting(id);
    if (!meeting) return Response.json({ ok: false, available: false, error: 'Meeting not found' }, { status: 404 });
    const auth = await resolveCloudBearer(await loadConfig());
    return Response.json({
      ok: true,
      available: auth.hasCloudAuth,
      model: GROK_VOICE_MODEL,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({
      ok: false,
      available: false,
      error: error instanceof Error ? error.message : 'Could not check voice',
    }, { status: 400 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const meeting = getLiveMeeting(id);
    if (!meeting) return Response.json({ ok: false, available: false, error: 'Meeting not found' }, { status: 404 });
    if (meeting.status !== 'active') {
      return Response.json({ ok: false, available: false, error: 'Voice is only available in an active meeting' }, { status: 409 });
    }
    let voice = '';
    try {
      const body = await request.json() as { voice?: unknown };
      voice = typeof body.voice === 'string' ? body.voice : '';
    } catch {
      voice = '';
    }
    const session = await mintLiveMeetingVoiceSession({ meeting, voice });
    return Response.json({ ok: true, available: true, ...session }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof LiveMeetingVoiceError ? error.status : 400;
    return Response.json({
      ok: false,
      available: false,
      error: error instanceof Error ? error.message : 'Could not start Grok Voice 2.0',
    }, { status });
  }
}
