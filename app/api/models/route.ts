import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/persistence';
import { listAllSelectableModels } from '@/lib/grok-client';
import { resolveCloudBearer } from '@/lib/xai-oauth';

export async function GET() {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);

  const result = await listAllSelectableModels(cfg, auth);
  if (!result.ok) {
    // Always 200 so the client can read the JSON body without browser console 502 noise.
    return NextResponse.json({
      ok: false,
      models: [],
      error: result.cloudError || result.localError || 'No models available',
      cloudError: result.cloudError,
      localError: result.localError,
      hasCloudAuth: result.hasCloudAuth,
      localEnabled: result.localEnabled,
      localReachable: result.localReachable,
    });
  }

  // Grok CLI models are selectable too (agents delegate their whole run to
  // the headless CLI) — appended best-effort when the CLI is installed.
  let models = result.models;
  try {
    const { detectGrokCli, listGrokCliModels } = await import('@/lib/grok-cli');
    const cli = await detectGrokCli();
    if (cli.installed) {
      const cliModels = await listGrokCliModels();
      const extras = (cliModels.models.length ? cliModels.models : ['grok']).map((id) => ({
        id: `cli:${id}`,
        label: `${id} (Grok CLI)`,
        provider: 'cli' as const,
      }));
      models = [...models, ...extras];
    }
  } catch { /* CLI listing is optional */ }

  return NextResponse.json({
    ok: true,
    models,
    hasCloudAuth: result.hasCloudAuth,
    localEnabled: result.localEnabled,
    localReachable: result.localReachable,
    cloudError: result.cloudError,
    localError: result.localError,
  });
}
