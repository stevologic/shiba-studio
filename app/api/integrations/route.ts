import { NextRequest, NextResponse } from 'next/server';
import { saveConfig, loadConfig } from '@/lib/persistence';
import * as Ints from '@/lib/integrations';
import { audit } from '@/lib/audit-log';

export async function GET() {
  const cfg = await loadConfig();
  let listeners = null;
  try {
    const { getChannelListenerStatuses } = await import('@/lib/channel-listeners');
    listeners = getChannelListenerStatuses();
  } catch { /* optional */ }
  return NextResponse.json({ integrations: cfg.integrations, listeners });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const cfg = await loadConfig();

  if (body.action === 'save') {
    const which = body.which as string | undefined;
    const creds = body.creds || {};
    const partial =
      which && creds[which] !== undefined
        ? { [which]: creds[which] }
        : creds;
    // Pasted tokens routinely arrive with stray whitespace/newlines — a top
    // cause of baffling 401s. Trim every string credential field on save.
    for (const svc of Object.values(partial) as Array<Record<string, unknown>>) {
      if (svc && typeof svc === 'object') {
        for (const [k, v] of Object.entries(svc)) {
          if (typeof v === 'string') (svc as Record<string, unknown>)[k] = v.trim();
        }
      }
    }
    const next = await saveConfig({ integrations: partial });
    Ints.setIntegrationCreds(next.integrations || {});
    audit('integration', 'credentials saved', which || Object.keys(partial).join(', '));
    // Restart mention listeners when Slack/Discord creds change.
    let listeners = null;
    try {
      const { syncChannelListeners } = await import('@/lib/channel-listeners');
      listeners = await syncChannelListeners();
    } catch { /* non-fatal */ }
    return NextResponse.json({ ok: true, integrations: next.integrations, listeners });
  }

  if (body.action === 'delete') {
    const which = body.which as string | undefined;
    if (!which) return NextResponse.json({ error: 'which is required' }, { status: 400 });
    const cleared = which === 'obsidian' ? { mode: 'local' as const } : {};
    const next = await saveConfig({ integrations: { [which]: cleared } });
    Ints.setIntegrationCreds(next.integrations || {});
    audit('integration', 'credentials removed', which);
    let listeners = null;
    try {
      const { syncChannelListeners } = await import('@/lib/channel-listeners');
      listeners = await syncChannelListeners();
    } catch { /* non-fatal */ }
    return NextResponse.json({ ok: true, integrations: next.integrations, listeners });
  }

  if (body.action === 'listeners') {
    try {
      const { getChannelListenerStatuses, syncChannelListeners } = await import('@/lib/channel-listeners');
      if (body.resync) {
        const listeners = await syncChannelListeners();
        return NextResponse.json({ ok: true, listeners });
      }
      return NextResponse.json({ ok: true, listeners: getChannelListenerStatuses() });
    } catch (e: unknown) {
      return NextResponse.json({
        ok: false,
        error: e instanceof Error ? e.message : 'listeners unavailable',
      }, { status: 500 });
    }
  }

  if (body.action === 'disconnect-drive') {
    const { disconnectGoogleDrive } = await import('@/lib/google-oauth');
    await disconnectGoogleDrive();
    const next = await loadConfig();
    Ints.setIntegrationCreds(next.integrations || {});
    audit('integration', 'Google Drive disconnected', '');
    return NextResponse.json({ ok: true, integrations: next.integrations });
  }

  if (body.action === 'test') {
    Ints.setIntegrationCreds(body.creds || cfg.integrations || {});
    const which = body.which;
    if (which === 'github') {
      const r = await Ints.testGitHub();
      return NextResponse.json(r);
    }
    if (which === 'slack') {
      const r = await Ints.testSlack();
      return NextResponse.json(r);
    }
    if (which === 'googledrive') {
      const r = await Ints.testGoogleDrive();
      return NextResponse.json(r);
    }
    if (which === 'discord') {
      const r = await Ints.testDiscord();
      return NextResponse.json(r);
    }
    if (which === 'x') {
      const r = await Ints.testX();
      return NextResponse.json(r);
    }
    if (which === 'obsidian') {
      const r = await Ints.testObsidian(body.creds || cfg.integrations || {});
      return NextResponse.json(r);
    }
    if (which === 'vercel') {
      const r = await Ints.testVercel(body.creds || cfg.integrations || {});
      return NextResponse.json(r);
    }
    if (which === 'netlify') {
      const r = await Ints.testNetlify(body.creds || cfg.integrations || {});
      return NextResponse.json(r);
    }
  }
  return NextResponse.json({ error: 'bad action' }, { status: 400 });
}
