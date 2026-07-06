import { NextRequest, NextResponse } from 'next/server';
import { loadConfig, saveConfig } from '@/lib/persistence';
import { getOAuthPublicStatus, resolveCloudBearer } from '@/lib/xai-oauth';
import { secretKeyLocation } from '@/lib/secure-store';
import type { CloudAuthMode } from '@/lib/types';

export async function GET() {
  const cfg = await loadConfig();
  const oauth = await getOAuthPublicStatus();
  const auth = await resolveCloudBearer(cfg);
  const safe = {
    ...cfg,
    xaiApiKey: cfg.xaiApiKey ? (cfg.xaiApiKey.slice(0, 6) + '…' + cfg.xaiApiKey.slice(-4)) : '',
    hasKey: !!cfg.xaiApiKey,
    hasOAuth: oauth.connected,
    hasCloudAuth: auth.hasCloudAuth,
    cloudAuthMode: (cfg.cloudAuthMode || 'api_key') as CloudAuthMode,
    activeCloudSource: auth.source,
    oauthStatus: oauth,
    secretKeyLocation: secretKeyLocation(),
  };
  return NextResponse.json(safe);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (body.xaiApiKey !== undefined) {
    const cfg = await saveConfig({ xaiApiKey: body.xaiApiKey });
    const auth = await resolveCloudBearer(cfg);
    return NextResponse.json({ ok: true, hasKey: !!cfg.xaiApiKey, hasCloudAuth: auth.hasCloudAuth });
  }
  if (body.cloudAuthMode === 'api_key' || body.cloudAuthMode === 'oauth') {
    const cfg = await saveConfig({ cloudAuthMode: body.cloudAuthMode });
    const auth = await resolveCloudBearer(cfg);
    return NextResponse.json({
      ok: true,
      cloudAuthMode: cfg.cloudAuthMode,
      activeCloudSource: auth.source,
      hasCloudAuth: auth.hasCloudAuth,
    });
  }
  if (body.defaultWorkspace) {
    await saveConfig({ defaultWorkspace: body.defaultWorkspace });
  }
  if (body.defaultGrokModel !== undefined) {
    const cfg = await saveConfig({ defaultGrokModel: String(body.defaultGrokModel || '') });
    return NextResponse.json({ ok: true, defaultGrokModel: cfg.defaultGrokModel });
  }
  if (body.localModelAllowlist !== undefined) {
    const allowlist = Array.isArray(body.localModelAllowlist)
      ? body.localModelAllowlist.map((m: unknown) => String(m).trim()).filter(Boolean)
      : [];
    const cfg = await saveConfig({ localModelAllowlist: allowlist });
    return NextResponse.json({ ok: true, localModelAllowlist: cfg.localModelAllowlist });
  }
  // Must run before the settings-save branch below: the test request carries
  // localGrokBaseUrl but must never write config (it used to coerce
  // localGrokEnabled to false via !!undefined).
  if (body.action === 'testLocalGrok') {
    const { listLocalGrokModels } = await import('@/lib/grok-client');
    const base = body.localGrokBaseUrl as string | undefined;
    const r = await listLocalGrokModels(base);
    return NextResponse.json({ ok: r.ok, models: r.models, error: r.error });
  }
  if (body.localGrokEnabled !== undefined || body.localGrokBaseUrl !== undefined) {
    const cfg = await saveConfig({
      localGrokEnabled: !!body.localGrokEnabled,
      localGrokBaseUrl: body.localGrokBaseUrl ? String(body.localGrokBaseUrl) : undefined,
    });
    return NextResponse.json({
      ok: true,
      localGrokEnabled: cfg.localGrokEnabled,
      localGrokBaseUrl: cfg.localGrokBaseUrl,
    });
  }
  if (
    body.toolApprovalMode !== undefined
    || body.globalInstructions !== undefined
    || body.useAgentsMd !== undefined
  ) {
    const cfg = await saveConfig({
      ...(body.toolApprovalMode === 'ask' || body.toolApprovalMode === 'yolo'
        ? { toolApprovalMode: body.toolApprovalMode }
        : {}),
      ...(body.globalInstructions !== undefined ? { globalInstructions: String(body.globalInstructions) } : {}),
      ...(body.useAgentsMd !== undefined ? { useAgentsMd: !!body.useAgentsMd } : {}),
    });
    return NextResponse.json({
      ok: true,
      toolApprovalMode: cfg.toolApprovalMode,
      globalInstructions: cfg.globalInstructions,
      useAgentsMd: cfg.useAgentsMd,
    });
  }
  const cfg = await loadConfig();
  return NextResponse.json({ ok: true });
}