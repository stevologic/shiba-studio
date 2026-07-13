import './verify-isolate';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-transient-integrity-'));
  const data = path.join(root, 'data');
  const temporaryRoot = path.join(root, 'tmp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  process.env.SHIBA_DATA_DIR = data;
  process.env.SHIBA_SECRET_KEY = 'e4'.repeat(32);
  process.env.TMP = temporaryRoot;
  process.env.TEMP = temporaryRoot;
  process.env.TMPDIR = temporaryRoot;

  const dbModule = await import('../lib/db');
  const persistence = await import('../lib/persistence');
  const types = await import('../lib/types');
  const catalog = await import('../lib/skills-catalog');
  const skills = await import('../lib/custom-skills');
  const companion = await import('../lib/companion-auth');
  const native = await import('../lib/native-nodes');
  const xaiOAuth = await import('../lib/xai-oauth');
  const redditOAuth = await import('../lib/reddit-oauth');
  const transient = await import('../lib/transient-resource-integrity');
  const coordinator = await import('../lib/integrity-coordinator');

  xaiOAuth.setOAuthDataDir(data);
  redditOAuth.setRedditOAuthDataDir(data);
  try {
    const custom = await skills.createCustomSkill({
      name: 'Transient ownership verifier',
      category: 'automation',
      description: 'Ensures deleted catalog owners do not strand agent tags.',
    });
    const builtInId = catalog.SKILL_PRESETS[0].id;
    const agent = types.normalizeAgent({
      id: 'skill-owner-agent',
      name: 'Skill owner agent',
      model: 'local:test',
      workspace: { path: root, useWorktree: false },
      integrations: {},
      peers: [],
      skills: [builtInId, custom.id],
      schedules: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await persistence.saveAgents([agent]);
    await skills.deleteCustomSkill(custom.id);
    assert(!((await persistence.loadAgents())[0].skills || []).includes(custom.id),
      'custom-skill deletion detaches every agent reference before returning');

    await persistence.mutateAgents((agents) => {
      agents[0].skills = [builtInId, builtInId, 'missing-custom-skill'];
    });
    const skillRepair = await skills.reconcileAgentSkillReferences();
    assert.equal(skillRepair.referencesDetached, 2, 'periodic repair removes duplicates and ownerless ids');
    assert.deepEqual((await persistence.loadAgents())[0].skills, [builtInId]);

    companion.ensureCompanionSchema();
    native.ensureNativeNodeSchema();
    const db = dbModule.getDb();
    const nowMs = Date.now();
    const old = new Date(nowMs - 2 * 60 * 60_000).toISOString();
    const future = new Date(nowMs + 5 * 60_000).toISOString();
    const insertCompanion = db.prepare(`
      INSERT INTO companion_pairings
        (id, codeHash, requestedScopes, createdAt, expiresAt, consumedAt, attempts, maxAttempts)
      VALUES (?, 'hash', '[]', ?, ?, ?, ?, 6)
    `);
    insertCompanion.run('companion-expired', old, old, null, 0);
    insertCompanion.run('companion-consumed', old, future, old, 1);
    insertCompanion.run('companion-fresh', new Date(nowMs).toISOString(), future, null, 0);
    const insertNative = db.prepare(`
      INSERT INTO native_node_pairings
        (id, codeHash, capabilities, createdAt, expiresAt, consumedAt, attempts, maxAttempts)
      VALUES (?, 'hash', '[]', ?, ?, ?, ?, 6)
    `);
    insertNative.run('native-expired', old, old, null, 0);
    insertNative.run('native-attempts', old, future, null, 6);
    insertNative.run('native-fresh', new Date(nowMs).toISOString(), future, null, 0);

    await xaiOAuth.saveOAuthPending({
      state: 'expired-xai-state',
      codeVerifier: 'expired-verifier',
      redirectUri: 'http://127.0.0.1:3000/callback',
      createdAt: new Date(nowMs - 20 * 60_000).toISOString(),
    });
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, 'reddit-oauth-pending.json'), JSON.stringify({
      state: 'expired-reddit-state',
      redirectUri: 'http://127.0.0.1:3000/api/reddit-oauth/callback',
      clientId: 'client',
      createdAt: new Date(nowMs - 20 * 60_000).toISOString(),
    }));

    const oldHome = path.join(temporaryRoot, 'shiba-grok-isolated-ABC123');
    const freshHome = path.join(temporaryRoot, 'shiba-grok-isolated-def456');
    const decoyHome = path.join(temporaryRoot, 'shiba-grok-isolated-ABC123-extra');
    const oldPrompt = path.join(temporaryRoot, 'shiba-grok-cli-prompt-1700000000000-abcdefgh.txt');
    const freshPrompt = path.join(temporaryRoot, 'shiba-grok-cli-prompt-1700000000001-ijklmnop.txt');
    const decoyPrompt = path.join(temporaryRoot, 'shiba-grok-cli-prompt-1700000000002-qrstuvwx.json');
    await Promise.all([
      fs.mkdir(oldHome), fs.mkdir(freshHome), fs.mkdir(decoyHome),
      fs.writeFile(oldPrompt, 'old'), fs.writeFile(freshPrompt, 'fresh'), fs.writeFile(decoyPrompt, 'decoy'),
    ]);
    const oldDate = new Date(nowMs - 2 * 60 * 60_000);
    await Promise.all([
      fs.utimes(oldHome, oldDate, oldDate),
      fs.utimes(decoyHome, oldDate, oldDate),
      fs.utimes(oldPrompt, oldDate, oldDate),
      fs.utimes(decoyPrompt, oldDate, oldDate),
    ]);

    const report = await transient.reconcileTransientResources({
      nowMs,
      pairingRetentionMs: 60 * 60_000,
      grokTemporaryMinAgeMs: 60 * 60_000,
      temporaryRoot,
    });
    assert.deepEqual(report.errors, []);
    assert.equal(report.companionPairingsRemoved, 2);
    assert.equal(report.nativePairingsRemoved, 2);
    assert.equal(report.xaiOAuthPendingRemoved, 1);
    assert.equal(report.redditOAuthPendingRemoved, 1);
    assert.equal(report.grokCli.isolatedHomesRemoved, 1);
    assert.equal(report.grokCli.promptFilesRemoved, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM companion_pairings').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM native_node_pairings').get() as { count: number }).count, 1);
    assert.equal(await exists(oldHome), false);
    assert.equal(await exists(oldPrompt), false);
    assert.equal(await exists(freshHome), true, 'age guard retains a live-looking isolated home');
    assert.equal(await exists(freshPrompt), true, 'age guard retains a live-looking prompt file');
    assert.equal(await exists(decoyHome), true, 'strict prefix shape ignores lookalike directories');
    assert.equal(await exists(decoyPrompt), true, 'strict extension guard ignores lookalike files');

    await xaiOAuth.saveOAuthPending({
      state: 'fresh-xai-state',
      codeVerifier: 'fresh-verifier',
      redirectUri: 'http://127.0.0.1:3000/callback',
      createdAt: new Date(nowMs).toISOString(),
    });
    await fs.writeFile(path.join(data, 'reddit-oauth-pending.json'), JSON.stringify({
      state: 'fresh-reddit-state',
      redirectUri: 'http://127.0.0.1:3000/api/reddit-oauth/callback',
      clientId: 'client',
      createdAt: new Date(nowMs).toISOString(),
    }));
    const freshReport = await transient.reconcileTransientResources({
      nowMs,
      pairingRetentionMs: 60 * 60_000,
      grokTemporaryMinAgeMs: 60 * 60_000,
      temporaryRoot,
    });
    assert.equal(freshReport.xaiOAuthPendingRemoved, 0, 'fresh xAI challenge remains live');
    assert.equal(freshReport.redditOAuthPendingRemoved, 0, 'fresh Reddit challenge remains live');
    assert.equal(await exists(path.join(data, 'xai-oauth-pending.json')), true);
    assert.equal(await exists(path.join(data, 'reddit-oauth-pending.json')), true);

    console.log('transient resource integrity verification passed');
  } finally {
    xaiOAuth.setOAuthDataDir(null);
    redditOAuth.setRedditOAuthDataDir(null);
    await coordinator.stopDataIntegritySchedule();
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
