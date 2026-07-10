/**
 * Verify Netlify core integration end-to-end against SHIPPED modules:
 * catalog, tools, tool-exec (mocked Netlify API), context, UI, API route, secrets.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(SCRATCH, 'verify-netlify.log');

const lines: string[] = [];

function log(msg: string) {
  lines.push(msg);
  console.log(msg);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function read(rel: string) {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  log(`NETLIFY_VERIFY ${new Date().toISOString()}`);

  // --- Structural: catalog, icon, docs, UI, API ---
  const catalog = await import('../lib/integration-catalog');
  assert(catalog.INTEGRATION_IDS.includes('netlify'), 'catalog includes netlify');
  const meta = catalog.getIntegrationMeta('netlify');
  assert(meta?.label === 'Netlify', 'catalog meta label');
  assert(meta?.icon === '/integrations/netlify.svg', 'catalog icon path');
  log('OK catalog');

  const icon = await fs.readFile(path.join(ROOT, 'public/integrations/netlify.svg'), 'utf8');
  assert(icon.includes('<svg'), 'netlify.svg exists');
  log('OK icon');

  const types = await read('lib/types.ts');
  assert(types.includes('netlify: boolean'), 'IntegrationScope has netlify');
  assert(types.includes('netlify?:'), 'IntegrationCreds has netlify');
  assert(types.includes('defaultSite'), 'netlify defaultSite field');
  log('OK types');

  const ui = await read('components/shiba-studio.tsx');
  assert(ui.includes("integration.id === 'netlify'"), 'UI netlify card body');
  assert(ui.includes('intCreds.netlify'), 'UI netlify creds state');
  assert(ui.includes('Netlify personal access token'), 'UI token field');
  assert(ui.includes('defaultSite'), 'UI default site field');
  assert(ui.includes("key: 'token', label: 'Netlify personal access token'"), 'agent override fields');
  log('OK UI');

  const api = await read('app/api/integrations/route.ts');
  assert(api.includes("which === 'netlify'"), 'integrations API test branch');
  assert(api.includes('testNetlify'), 'integrations API calls testNetlify');
  log('OK API route');

  const toolsRoute = await read('app/api/tools/route.ts');
  assert(toolsRoute.includes('netlify_list_sites'), 'tools catalog lists netlify tools');
  assert(toolsRoute.includes('netlify: true'), 'tools catalog enables netlify scope');
  log('OK tools route');

  const persistence = await read('lib/persistence.ts');
  assert(persistence.includes("'integrations.netlify.token'"), 'token sealed at rest');
  assert(/netlify:\s*\[\s*'token'\s*\]/.test(persistence), 'agent override secret field');
  log('OK persistence');

  const approval = await read('lib/tool-approval.ts');
  assert(approval.includes("'netlify_deploy'"), 'deploy gated');
  assert(approval.includes("'netlify_set_env'"), 'set_env gated');
  log('OK tool-approval');

  const docs = await read('docs/capabilities.md');
  assert(docs.includes('**Netlify**'), 'docs mention Netlify');
  assert(docs.includes('netlify_deploy'), 'docs list deploy tool');
  log('OK docs');

  // --- Runtime tool definitions ---
  const { getToolDefinitions } = await import('../lib/agent-runtime');
  const { EMPTY_INTEGRATION_SCOPE } = await import('../lib/types');
  const off = getToolDefinitions({ ...EMPTY_INTEGRATION_SCOPE }, false, 'local');
  assert(!off.some((t) => t.function.name.startsWith('netlify_')), 'tools hidden when scope off');

  const on = getToolDefinitions({ ...EMPTY_INTEGRATION_SCOPE, netlify: true }, false, 'local');
  const names = on.map((t) => t.function.name);
  for (const n of [
    'netlify_list_sites',
    'netlify_list_deploys',
    'netlify_get_deploy',
    'netlify_deploy',
    'netlify_set_env',
  ]) {
    assert(names.includes(n), `tool definition ${n}`);
  }
  log(`OK tool definitions (${names.filter((n) => n.startsWith('netlify_')).join(', ')})`);

  // --- Client + tool-exec with mocked Netlify API ---
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });

    if (url.includes('/api/v1/user') && method === 'GET') {
      return jsonResponse({
        id: 'user-1',
        full_name: 'Verify User',
        email: 'verify@example.com',
        slug: 'verify-account',
      });
    }
    if (url.includes('/api/v1/sites?') && method === 'GET') {
      return jsonResponse([
        {
          id: 'site-abc',
          name: 'vibe-app',
          url: 'https://vibe-app.netlify.app',
          ssl_url: 'https://vibe-app.netlify.app',
          admin_url: 'https://app.netlify.com/sites/vibe-app',
          account_slug: 'verify-account',
          build_settings: {
            provider: 'github',
            repo_url: 'https://github.com/ex/vibe-app',
            repo_branch: 'main',
          },
          published_deploy: { id: 'dep-old', state: 'ready', ssl_url: 'https://vibe-app.netlify.app' },
          updated_at: '2026-07-01T00:00:00.000Z',
        },
      ]);
    }
    if (url.match(/\/api\/v1\/sites\/site-abc$/) && method === 'GET') {
      return jsonResponse({
        id: 'site-abc',
        name: 'vibe-app',
        url: 'https://vibe-app.netlify.app',
        account_slug: 'verify-account',
        build_settings: { provider: 'github', repo_url: 'https://github.com/ex/vibe-app' },
      });
    }
    if (url.includes('/api/v1/sites/site-abc/deploys') && method === 'GET') {
      return jsonResponse([
        {
          id: 'dep-1',
          state: 'ready',
          ssl_url: 'https://vibe-app.netlify.app',
          name: 'vibe-app',
          created_at: '2026-07-08T00:00:00.000Z',
          branch: 'main',
          context: 'production',
        },
      ]);
    }
    if (url.includes('/api/v1/deploys/dep-1') && method === 'GET') {
      return jsonResponse({
        id: 'dep-1',
        state: 'ready',
        ssl_url: 'https://vibe-app.netlify.app',
        name: 'vibe-app',
      });
    }
    if (url.includes('/api/v1/sites/site-abc/builds') && method === 'POST') {
      return jsonResponse({
        id: 'build-9',
        deploy_id: 'dep-new',
        deploy: {
          id: 'dep-new',
          state: 'building',
          ssl_url: 'https://deploy-preview--vibe-app.netlify.app',
        },
      });
    }
    if (url.includes('/api/v1/deploys/dep-new') && method === 'GET') {
      return jsonResponse({
        id: 'dep-new',
        state: 'building',
        ssl_url: 'https://deploy-preview--vibe-app.netlify.app',
      });
    }
    if (url.includes('/api/v1/accounts/verify-account/env') && method === 'POST') {
      return jsonResponse({ key: 'DEMO_KEY' }, 201);
    }

    return jsonResponse({ message: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;

  try {
    const netlify = await import('../lib/netlify');
    const creds = {
      netlify: {
        token: 'nfp_verify_dummy_token',
        accountSlug: 'verify-account',
        defaultSite: 'vibe-app',
      },
    };

    const noTok = await netlify.testNetlify({});
    assert(!noTok.ok, 'testNetlify fails without token');

    const who = await netlify.testNetlify(creds);
    assert(who.ok, `testNetlify ok: ${who.error || ''}`);
    assert(who.user === 'Verify User', 'testNetlify user');
    assert(who.account === 'verify-account', 'testNetlify account');
    log('OK testNetlify');

    const sites = await netlify.netlifyListSites(10, creds);
    assert(sites.length === 1 && sites[0].name === 'vibe-app', 'list sites');
    assert(sites[0].buildSettings?.provider === 'github', 'site git-linked');
    log('OK netlifyListSites');

    const site = await netlify.netlifyGetSite('vibe-app', creds);
    assert(site.id === 'site-abc', 'get site by name via list fallback or id');
    log('OK netlifyGetSite');

    const deploys = await netlify.netlifyListDeploys('vibe-app', 5, creds);
    assert(deploys.length === 1 && deploys[0].id === 'dep-1', 'list deploys');
    log('OK netlifyListDeploys');

    const dep = await netlify.netlifyGetDeploy('dep-1', creds);
    assert(dep.state === 'ready', 'get deploy');
    log('OK netlifyGetDeploy');

    const shipped = await netlify.netlifyDeploy({ site: 'vibe-app', title: 'verify' }, creds);
    assert(shipped.id === 'dep-new' || shipped.buildId === 'build-9', 'deploy result');
    assert(shipped.siteName === 'vibe-app', 'deploy site name');
    log(`OK netlifyDeploy id=${shipped.id} state=${shipped.state}`);

    const env = await netlify.netlifySetEnv(
      { site: 'vibe-app', key: 'DEMO_KEY', value: 'yes' },
      creds,
    );
    assert(env.ok && env.key === 'DEMO_KEY', 'set env');
    log('OK netlifySetEnv');

    // Tool exec path (same as agents). executeAgentTool loadConfig() reloads
    // integrations from disk — persist creds into an isolated data dir first.
    const testData = path.join(SCRATCH, 'netlify-verify-data');
    await fs.mkdir(testData, { recursive: true });
    const { setPersistenceDataDir, saveConfig } = await import('../lib/persistence');
    setPersistenceDataDir(testData);
    await saveConfig({
      xaiApiKey: 'xai-test-netlify-verify',
      integrations: creds,
    } as any);

    const { executeAgentTool } = await import('../lib/agent-tool-exec');
    const agent = {
      id: 'netlify-verify-agent',
      name: 'Netlify Verify',
      model: 'grok-3',
      description: 'verify',
      workspace: { path: process.cwd(), useWorktree: false },
      integrations: { ...EMPTY_INTEGRATION_SCOPE, netlify: true },
      peers: [],
      skills: [],
      schedules: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run = { id: 'netlify-verify-run', status: 'running' as const };
    const workDir = process.cwd();

    const listRes = await executeAgentTool('netlify_list_sites', { limit: 5 }, agent as any, run, workDir);
    assert(
      Array.isArray(listRes.result) && (listRes.result as any[]).length >= 1,
      `tool list sites: ${JSON.stringify(listRes)}`,
    );
    assert(String(listRes.sideEffect || '').toLowerCase().includes('netlify'), 'list side effect');

    const deployRes = await executeAgentTool(
      'netlify_deploy',
      { site: 'vibe-app', clear_cache: false },
      agent as any,
      run,
      workDir,
    );
    assert(deployRes.result && !(deployRes.result as any).error, `tool deploy: ${JSON.stringify(deployRes.result)}`);
    assert(String(deployRes.sideEffect || '').includes('Netlify deploy'), 'deploy side effect');

    const envRes = await executeAgentTool(
      'netlify_set_env',
      { site: 'vibe-app', key: 'DEMO_KEY', value: 'yes' },
      agent as any,
      run,
      workDir,
    );
    assert((envRes.result as any)?.ok, 'tool set env');
    log('OK agent-tool-exec netlify tools');

    // Integration context (creds already on disk + in-memory via saveConfig)
    const { buildIntegrationContext, clearIntegrationContextCache } = await import('../lib/integration-context');
    clearIntegrationContextCache();
    const ctx = await buildIntegrationContext({ ...EMPTY_INTEGRATION_SCOPE, netlify: true });
    assert(ctx.includes('### Netlify'), 'context section');
    assert(ctx.includes('vibe-app') || ctx.includes('Verify User'), 'context content');
    log('OK integration context');

    assert(calls.length > 0, 'mocked fetch was used');
    log(`OK fetch mock calls=${calls.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  log('PASS: Netlify integration fully wired');
  await fs.writeFile(LOG, lines.join('\n') + '\n');
  process.exit(0);
}

main().catch(async (e) => {
  log(`FAIL: ${e instanceof Error ? e.stack || e.message : e}`);
  await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await fs.writeFile(LOG, lines.join('\n') + '\n').catch(() => {});
  process.exit(1);
});
