import { NextRequest, NextResponse } from 'next/server';
import { saveConfig, loadConfig } from '@/lib/persistence';
import * as Ints from '@/lib/integrations';
import { audit } from '@/lib/audit-log';

export async function GET() {
  const cfg = await loadConfig();
  return NextResponse.json({ integrations: cfg.integrations });
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
    const next = await saveConfig({ integrations: partial });
    audit('integration', 'credentials saved', which || Object.keys(partial).join(', '));
    return NextResponse.json({ ok: true, integrations: next.integrations });
  }

  if (body.action === 'delete') {
    const which = body.which as string | undefined;
    if (!which) return NextResponse.json({ error: 'which is required' }, { status: 400 });
    const cleared = which === 'obsidian' ? { mode: 'local' as const } : {};
    const next = await saveConfig({ integrations: { [which]: cleared } });
    Ints.setIntegrationCreds(next.integrations || {});
    audit('integration', 'credentials removed', which);
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
  }
  return NextResponse.json({ error: 'bad action' }, { status: 400 });
}
