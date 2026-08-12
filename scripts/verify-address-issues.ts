import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

function issue(partial: Record<string, unknown>) {
  return {
    number: 1,
    title: 'Example',
    body: 'body',
    state: 'open',
    user: { login: 'stevologic', type: 'User' },
    author_association: 'OWNER',
    labels: [],
    created_at: '2026-08-01T00:00:00Z',
    ...partial,
  };
}

async function main() {
  const lib = await import('../scripts/ci/address-issues-lib.mjs');
  const script = path.join(ROOT, 'scripts', 'ci', 'address-issues.mjs');

  assert.equal(lib.TARGET_BRANCH, 'development');
  assert.equal(lib.SKIP_NO_KEY_MESSAGE, 'address-issues: skipped (GROK_API_KEY is not set)');

  assert.equal(lib.isAutomationAuthor('github-actions[bot]'), true);
  assert.equal(lib.isAutomationAuthor('dependabot[bot]'), true);
  assert.equal(lib.isAutomationAuthor('renovate[bot]'), true);
  assert.equal(lib.isAutomationAuthor('some-app[bot]'), true);
  assert.equal(lib.isAutomationAuthor('helper', 'Bot'), true);
  assert.equal(lib.isAutomationAuthor('stevologic'), false);
  assert.equal(lib.isAutomationAuthor('random-user'), false);

  assert.equal(lib.isAdminAuthor('stevologic', 'OWNER'), true);
  assert.equal(lib.isAdminAuthor('helper', 'MEMBER'), true);
  assert.equal(lib.isAdminAuthor('helper', 'COLLABORATOR'), true);
  assert.equal(lib.isAdminAuthor('stevologic', 'NONE', ['stevologic']), true);
  assert.equal(lib.isIssueEligible(issue({
    author_association: '',
    user: { login: 'stevologic', type: 'User' },
  }), { adminLogins: ['stevologic'] }), true, 'repo owner login is eligible without association');
  assert.equal(lib.isAdminAuthor('stranger', 'CONTRIBUTOR'), false);
  assert.equal(lib.isAdminAuthor('github-actions[bot]', 'CONTRIBUTOR'), false);

  assert.equal(lib.isIssueEligible(issue({})), true, 'owner-filed issues are eligible');
  assert.equal(lib.isIssueEligible(issue({
    user: { login: 'github-actions[bot]', type: 'Bot' },
    author_association: 'CONTRIBUTOR',
    title: 'Self-heal could not fix CI on development',
  })), true, 'automation-filed issues are eligible');
  assert.equal(lib.isIssueEligible(issue({
    user: { login: 'drive-by', type: 'User' },
    author_association: 'NONE',
  })), false, 'public drive-by issues are not eligible');
  assert.equal(lib.isIssueEligible(issue({ labels: [{ name: 'grok-skip' }] })), false);
  assert.equal(lib.isIssueEligible(issue({ labels: ['wontfix'] })), false);
  assert.equal(lib.isIssueEligible(issue({ labels: [{ name: 'grok-working' }] })), false);
  assert.equal(lib.isIssueEligible(issue({ labels: [{ name: 'grok-addressed' }] })), false);
  assert.equal(lib.isIssueEligible(issue({ labels: [{ name: 'grok-addressed' }] }), { allowAddressed: true }), true);
  assert.equal(lib.isIssueEligible(issue({ state: 'closed' })), false);
  assert.equal(lib.isIssueEligible(issue({ pull_request: { url: 'https://example' } })), false);

  const oldestAutomation = issue({
    number: 8,
    title: 'Self-heal could not fix CI on development',
    user: { login: 'github-actions[bot]', type: 'Bot' },
    author_association: 'CONTRIBUTOR',
    created_at: '2026-07-29T00:57:08Z',
  });
  const laterAdmin = issue({
    number: 20,
    title: 'Please add phone pairing docs',
    created_at: '2026-08-10T00:00:00Z',
  });
  const ignored = issue({
    number: 21,
    title: 'Drive-by request',
    user: { login: 'stranger', type: 'User' },
    author_association: 'NONE',
    created_at: '2026-07-01T00:00:00Z',
  });
  const picked = lib.selectIssueToAddress([laterAdmin, ignored, oldestAutomation]);
  assert.equal(picked?.number, 8, 'oldest eligible admin/automation issue wins');
  assert.equal(lib.selectIssueToAddress([laterAdmin, oldestAutomation], { requestedNumber: 20 })?.number, 20);
  assert.equal(lib.selectIssueToAddress([ignored]), null);

  assert.equal(lib.issueCommitMarker(8), '[grok-issue-#8]');
  assert.equal(lib.shouldStopIssueLoop([
    'fix: retry CI [grok-issue-#8]',
    'fix: retry CI [grok-issue-#8]',
    'fix: retry CI [grok-issue-#8]',
  ], 8), true);
  assert.equal(lib.shouldStopIssueLoop([
    'fix: retry CI [grok-issue-#8]',
    'feat: unrelated',
  ], 8), false);

  assert.equal(lib.writeAllowedForIssue('lib/foo.ts'), true);
  assert.equal(lib.writeAllowedForIssue('package.json'), true);
  assert.equal(lib.writeAllowedForIssue('package-lock.json'), false);
  assert.equal(lib.writeAllowedForIssue('node_modules/left-pad/index.js'), false);
  assert.equal(lib.writeAllowedForIssue('.git/config'), false);

  const prompt = lib.buildIssuePrompt(lib.normalizeIssue(oldestAutomation), { model: 'grok-4.6' });
  assert.match(prompt, /#8/);
  assert.match(prompt, /development/);
  assert.match(prompt, /admin or by an enabled project automation/i);
  assert.doesNotMatch(prompt, /\bmain\b.*push/i);

  const skip = lib.skipWithoutApiKey({ GROK_API_KEY: '' });
  assert.equal(skip.skip, true);
  assert.equal(skip.message, lib.SKIP_NO_KEY_MESSAGE);
  assert.equal(lib.skipWithoutApiKey({ GROK_API_KEY: 'xai-test' }).skip, false);

  const run = (extraEnv: Record<string, string | undefined>, extraArgs: string[] = []) =>
    spawnSync(process.execPath, [script, ...extraArgs], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GROK_API_KEY: '', ...extraEnv },
    });

  const skipped = run({ GROK_API_KEY: '' }, ['--validate']);
  assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
  assert.match(`${skipped.stdout}\n${skipped.stderr}`, /address-issues: skipped \(GROK_API_KEY is not set\)/);

  const keyed = run({ GROK_API_KEY: 'xai-verify-only' }, ['--validate']);
  assert.equal(keyed.status, 0, keyed.stderr || keyed.stdout);
  assert.match(keyed.stdout, /validate model=grok-4\.6 target=development/);

  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'shiba-issues-'));
  const fixture = path.join(fixtureDir, 'issues.json');
  writeFileSync(fixture, JSON.stringify([oldestAutomation, laterAdmin, ignored]));
  const selected = run({ GROK_API_KEY: '', ISSUE_SELECT_FILE: path.join(fixtureDir, 'picked.json') }, [
    '--select',
    `--issues-file=${fixture}`,
  ]);
  assert.equal(selected.status, 0, selected.stderr || selected.stdout);
  assert.match(selected.stdout, /selected #8/);
  const pickedJson = JSON.parse(readFileSync(path.join(fixtureDir, 'picked.json'), 'utf8')) as { skip: boolean; number: number };
  assert.equal(pickedJson.skip, false);
  assert.equal(pickedJson.number, 8, 'shipped --select must pick the automation issue from the fixture');

  const none = run({}, ['--select', `--issues-file=${fixture}`, '--issue=21']);
  assert.equal(none.status, 0, none.stderr || none.stdout);
  assert.match(none.stdout, /no eligible admin or automation issue/);

  const adminOnly = run({}, ['--select', `--issues-file=${fixture}`, '--issue=20']);
  assert.equal(adminOnly.status, 0, adminOnly.stderr || adminOnly.stdout);
  assert.match(adminOnly.stdout, /selected #20/);

  const workflow = readFileSync(path.join(ROOT, '.github/workflows/grok-issues.yml'), 'utf8');
  assert.match(workflow, /cron:\s*"23 \* \* \* \*"/);
  assert.match(workflow, /issues:\s*\n\s*types:\s*\[opened,\s*reopened\]/);
  assert.match(workflow, /secrets\.GROK_API_KEY/);
  assert.match(workflow, /ref: development/);
  assert.match(workflow, /git push origin HEAD:development/);
  assert.match(workflow, /gh workflow run ci\.yml --ref development/);
  assert.doesNotMatch(workflow, /git push origin HEAD:main/);
  assert.match(workflow, /GROK_API_KEY secret is not set — issue addressing skipped/);
  assert.match(workflow, /node scripts\/ci\/address-issues\.mjs --select/);
  assert.match(workflow, /node scripts\/ci\/address-issues\.mjs --issue=/);

  const runner = readFileSync(script, 'utf8');
  assert.match(runner, /repos\/\$\{repo\}\/issues\?state=open/);
  assert.match(runner, /selectIssueToAddress\(/);
  assert.match(runner, /finalizeMaintainRun\(\{ fixed: doneState\.fixed, cwd: REPO_ROOT \}\)/);
  assert.match(runner, /writeAllowedForIssue/);

  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'shiba-issue-finalize-'));
  const git = (args: string[]) => {
    const res = spawnSync('git', args, { cwd: sandbox, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res;
  };
  try {
    git(['init']);
    git(['config', 'user.email', 'verify@shiba.local']);
    git(['config', 'user.name', 'address-issues verifier']);
    writeFileSync(path.join(sandbox, 'kept.txt'), 'original\n');
    git(['add', 'kept.txt']);
    git(['commit', '-m', 'seed']);
    writeFileSync(path.join(sandbox, 'kept.txt'), 'mutated then discarded\n');
    writeFileSync(path.join(sandbox, 'scratch-edit.txt'), 'should not be committed\n');
    const discarded = lib.finalizeMaintainRun({ fixed: false, cwd: sandbox });
    assert.equal(discarded.discarded, true);
    assert.equal(discarded.dirty, '');
    assert.match(readFileSync(path.join(sandbox, 'kept.txt'), 'utf8'), /original/);
    assert.equal(existsSync(path.join(sandbox, 'scratch-edit.txt')), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  console.log('Address-issues verification passed');
}

main().catch((error) => {
  console.error('Address-issues verification failed', error);
  process.exitCode = 1;
});
