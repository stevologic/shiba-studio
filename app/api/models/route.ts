import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/persistence';
import { listAllSelectableModels } from '@/lib/grok-client';
import { resolveCloudBearer } from '@/lib/xai-oauth';

export async function GET() {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);

  const result = await listAllSelectableModels(cfg, auth);
  // Grok CLI models are selectable too (agents delegate their whole run to
  // the headless CLI) — appended best-effort only when the CLI is ready.
  let models = [...result.models];
  let cliReady = false;
  try {
    const { detectGrokCli, listGrokCliModels } = await import('@/lib/grok-cli');
    const cli = await detectGrokCli();
    cliReady = cli.ready === true;
    if (cliReady) {
      const cliModels = await listGrokCliModels();
      // Only advertise ids reported by the CLI. Never invent `cli:grok` when
      // model discovery returns an empty list.
      const discovered = [...cliModels.models, cliModels.defaultModel]
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim());
      const extras = [...new Set(discovered)].map((id) => ({
        id: `cli:${id}`,
        label: `${id} (Grok CLI)`,
        provider: 'cli' as const,
      }));
      models = [...models, ...extras];
    }
  } catch { /* CLI listing is optional */ }

  const ok = models.length > 0;
  return NextResponse.json({
    ok,
    models,
    ...(!ok ? {
      // Always 200 so the client can read this without browser console 502 noise.
      error: result.cloudError
        || result.localError
        || (cliReady ? 'Grok CLI is ready but did not report any selectable models' : 'No models available'),
    } : {}),
    hasCloudAuth: result.hasCloudAuth,
    localEnabled: result.localEnabled,
    localReachable: result.localReachable,
    cliReady,
    cloudError: result.cloudError,
    localError: result.localError,
  });
}
