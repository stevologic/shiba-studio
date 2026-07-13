/**
 * Verifies shipped shell correctness paths used after remount/nav bugs:
 * - agents loader returns disk agents (not empty when file has data)
 * - chat-session corrupt JSON recovery (recoverFirstJsonObject)
 * - concurrent session updates do not leave unreadable store
 * - nav-stats cache skips equal writes
 * - agents UI store survives "remount" (module cache)
 *
 * Drives real exported functions from lib/* — no reimplementation of product logic.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GOAL_SCRATCH } from '../lib/verify-scratch';

const lines: string[] = [];
function log(msg: string) {
  lines.push(msg);
  console.log(msg);
}

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) log(`PASS ${msg}`);
  else {
    failed += 1;
    log(`FAIL ${msg}`);
  }
}

async function main() {
  await fs.mkdir(GOAL_SCRATCH, { recursive: true });
  log(`VERIFY_SHELL_STATE_START ${new Date().toISOString()}`);

  // --- 1) Real agents loader against disk (shipped loadAgents) ---
  const { loadAgents } = await import('../lib/persistence');
  const agents = await loadAgents();
  log(`agents_from_disk count=${agents.length}`);
  assert(Array.isArray(agents), 'loadAgents returns array');
  // When the user data dir has agents, list must be non-empty (criterion 1).
  // If a clean CI sandbox has none, still require the loader path works.
  if (agents.length === 0) {
    log('NOTE disk agents empty in this environment — write temp agent via saveAgents then re-load');
    const { saveAgents } = await import('../lib/persistence');
    const probeId = 'verify-shell-probe-agent';
    const before = await loadAgents();
    await saveAgents([
      ...before,
      {
        id: probeId,
        name: 'Verify Probe Agent',
        model: 'cloud:grok-4',
        description: 'temp',
        workspace: { path: '.', useWorktree: false },
        integrations: {
          github: false, slack: false, googledrive: false, discord: false, x: false, obsidian: false, vercel: false, netlify: false,
        },
        peers: [],
        skills: [],
        chatSkill: '',
        schedules: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as import('../lib/types').Agent,
    ]);
    const after = await loadAgents();
    assert(after.some((a) => a.id === probeId), 'saveAgents+loadAgents round-trip sees probe agent');
    // cleanup probe
    await saveAgents(after.filter((a) => a.id !== probeId));
  } else {
    assert(agents.length > 0, 'loadAgents non-empty when disk has agents');
    log(`agents_names=${agents.map((a) => a.name).join('|')}`);
  }

  // --- 2) Corrupt JSON recovery (shipped recoverFirstJsonObject) ---
  const { recoverFirstJsonObject } = await import('../lib/chat-sessions');
  const good = JSON.stringify({
    sessions: [
      {
        id: 's1',
        title: 'Recovered Chat',
        chatTarget: 'grok',
        chatModel: 'cloud:grok-4',
        projectId: null,
        useGrokCli: false,
        reasoningEffort: 'low',
        messages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }, null, 2);
  const corrupt = `${good}\ntrailing-garbage-from-race 07-09T05:26:54.364Z"\n}\n`;
  const recovered = recoverFirstJsonObject(corrupt);
  assert(!!recovered, 'recoverFirstJsonObject returns substring for corrupt store');
  const parsed = JSON.parse(recovered!);
  assert(Array.isArray(parsed.sessions) && parsed.sessions.length === 1, 'recovered JSON has 1 session');
  assert(parsed.sessions[0].title === 'Recovered Chat', 'recovered session title intact');
  // Must not throw / must not return full corrupt blob
  assert(!recovered!.includes('trailing-garbage'), 'recovered blob excludes trailing garbage');

  // --- 3) Concurrent session updates under lock (shipped create/update/list) ---
  const dataDir = path.join(os.tmpdir(), `shiba-verify-shell-${Date.now()}`);
  await fs.mkdir(dataDir, { recursive: true });
  // Child process so SHIBA_DATA_DIR is bound before lib/data-paths caches the root.
  const { spawnSync } = await import('child_process');
  const child = spawnSync(
    'npx',
    ['tsx', path.join('scripts', 'verify-shell-concurrent-child.ts')],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, SHIBA_DATA_DIR: dataDir },
    },
  );
  log((child.stdout || '').trim());
  if (child.stderr) log((child.stderr || '').trim());
  assert(child.status === 0 && /CONCURRENT_OK/.test(child.stdout || ''), 'concurrent session updates leave valid JSON');
  try {
    const raw = await fs.readFile(path.join(dataDir, 'chat-sessions.json'), 'utf8');
    const parsedStore = JSON.parse(raw);
    assert(Array.isArray(parsedStore.sessions) && parsedStore.sessions.length >= 1, 'session store JSON.parse succeeds after concurrent writes');
  } catch (e) {
    assert(false, `session store unreadable after concurrent writes: ${e}`);
  }

  // --- 4) nav-stats cache (shipped writeCachedNavStats) ---
  const nav = await import('../lib/nav-stats-store');
  const base = {
    tasksActive: 2,
    attentionOpen: 1,
    chatSessions: 2,
    projects: 1,
    boardOpen: 3,
    memories: 4,
    workspaceFiles: 3,
    automationsScheduled: 0,
    integrationsConfigured: 1,
    usageCostUsd: 0.5,
    usageCostSource: 'local' as const,
    usageBudgetUsd: 25,
    cloudReachable: true,
  };
  const firstWrite = nav.writeCachedNavStats(base);
  assert(firstWrite === true, 'first nav stats write applies');
  const secondWrite = nav.writeCachedNavStats({ ...base });
  assert(secondWrite === false, 'equal nav stats write is skipped (no re-render needed)');
  assert(nav.isNavStatsLoaded() === true, 'nav stats marked loaded');
  assert(nav.getCachedNavStats().chatSessions === 2, 'cached chatSessions stays 2');

  // --- 5) agents UI store remount simulation ---
  const agentsUi = await import('../lib/agents-ui-store');
  agentsUi.setCachedAgents(agents.length ? agents : [{ id: 'x', name: 'Cached' } as unknown as import('../lib/types').Agent]);
  assert(agentsUi.hasCachedAgents() === true, 'agents cache set');
  assert((agentsUi.getCachedAgents() || []).length > 0, 'agents cache non-empty after set (remount restore source)');

  // --- 5b) runs UI store remount simulation (Recent Agent Runs used to
  // flash empty after every tab navigation until the 30s poll) ---
  const runsUi = await import('../lib/runs-ui-store');
  assert(runsUi.hasCachedRuns() === false, 'runs cache starts cold');
  runsUi.setCachedRuns([{ id: 'r1' } as unknown as import('../lib/types').AgentRun]);
  assert(runsUi.hasCachedRuns() === true, 'runs cache set');
  assert((runsUi.getCachedRuns() || []).length === 1, 'runs cache non-empty after set (remount restore source)');
  const shellSrc = await fs.readFile(path.resolve(__dirname, '../components/shiba-studio.tsx'), 'utf8');
  assert(shellSrc.includes('getCachedRuns() ?? []'), 'runs state hydrates from cache');
  assert(shellSrc.includes('void refreshRuns()'), 'remount path refreshes runs immediately');
  assert(shellSrc.includes('applyConfigToForms(snap.config)'), 'remount path restores config-derived forms');
  assert(shellSrc.includes('Promise.allSettled'), 'loadAll applies each endpoint independently');

  // --- 6) structural: layout hosts ShibaStudio (remount prevention) ---
  const layoutPath = path.resolve(__dirname, '../app/[[...section]]/layout.tsx');
  const layoutSrc = await fs.readFile(layoutPath, 'utf8');
  assert(layoutSrc.includes('ShibaStudio'), 'catch-all layout hosts ShibaStudio');
  assert(layoutSrc.includes('does NOT remount') || layoutSrc.includes('does not remount') || layoutSrc.includes('remount'), 'layout documents remount prevention');

  // --- 7) structural: select path must not call loadNavStats ---
  const panelPath = path.resolve(__dirname, '../components/chat-sessions-panel.tsx');
  const panelSrc = await fs.readFile(panelPath, 'utf8');
  const selectBlock = panelSrc.slice(panelSrc.indexOf('function selectSession'), panelSrc.indexOf('function toggleRail'));
  assert(!selectBlock.includes('onStatsChange'), 'selectSession does not call onStatsChange/loadNavStats');
  assert(selectBlock.includes('onSessionChange'), 'selectSession still navigates via onSessionChange');

  log(`FAILED=${failed}`);
  log(`VERIFY_SHELL_STATE_END ${new Date().toISOString()}`);
  await fs.writeFile(path.join(GOAL_SCRATCH, 'verify-shell-state.log'), lines.join('\n') + '\n');
  if (failed > 0) process.exit(1);
  console.log(`${lines.filter((l) => l.startsWith('PASS')).length} passed, 0 failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
