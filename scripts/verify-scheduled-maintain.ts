import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const lib = await import('../scripts/ci/scheduled-maintain-lib.mjs');

  assert.equal(lib.DEFAULT_SCHEDULED_GROK_MODEL, 'grok-4.6');
  assert.equal(lib.TARGET_BRANCH, 'development');
  assert.notEqual(lib.DEFAULT_SCHEDULED_GROK_MODEL, 'grok-4.5');
  assert.notEqual(lib.DEFAULT_SCHEDULED_GROK_MODEL, 'grok-code-fast-1');

  assert.equal(lib.isGrok46OrLater('grok-4.6'), true);
  assert.equal(lib.isGrok46OrLater('grok-4.6-latest'), true);
  assert.equal(lib.isGrok46OrLater('grok-4.7'), true);
  assert.equal(lib.isGrok46OrLater('grok-5'), true);
  assert.equal(lib.isGrok46OrLater('grok-latest'), true);
  assert.equal(lib.isGrok46OrLater('grok-4.5'), false);
  assert.equal(lib.isGrok46OrLater('grok-code-fast-1'), false);
  assert.equal(lib.isGrok46OrLater('grok-4'), false);

  assert.equal(lib.resolveScheduledModel({}), 'grok-4.6');
  assert.equal(lib.resolveScheduledModel({ GROK_MODEL: 'grok-4.6' }), 'grok-4.6');
  assert.equal(
    lib.resolveScheduledModel({ GROK_MODEL: 'grok-code-fast-1' }),
    'grok-4.6',
    'stale healer ids must not become the unattended default',
  );
  assert.equal(lib.resolveScheduledModel({ GROK_MODEL: 'grok-4.5' }), 'grok-4.6');
  assert.equal(lib.resolveScheduledModel({ GROK_MODEL: 'grok-5' }), 'grok-5');

  assert.equal(lib.resolveMaintainMode({ env: { MAINTAIN_MODE: 'weekly' }, argv: [] }), 'weekly');
  assert.equal(lib.resolveMaintainMode({ env: {}, argv: ['--mode=weekly'] }), 'weekly');
  assert.equal(lib.resolveMaintainMode({ env: {}, argv: [], schedule: lib.CRON_WEEKLY }), 'weekly');
  assert.equal(lib.resolveMaintainMode({ env: {}, argv: [], schedule: lib.CRON_DAILY }), 'daily');
  assert.equal(lib.resolveMaintainMode({ env: {}, argv: [] }), 'daily');

  const dailyPrompt = lib.buildMaintainPrompt('daily', { model: 'grok-4.6' });
  const weeklyPrompt = lib.buildMaintainPrompt('weekly', { model: 'grok-4.6' });
  assert.match(dailyPrompt, /vulnerability/i);
  assert.match(dailyPrompt, /development/);
  assert.doesNotMatch(dailyPrompt, /Claude/);
  assert.match(weeklyPrompt, /Claude/);
  assert.match(weeklyPrompt, /ChatGPT\/Codex/);
  assert.match(weeklyPrompt, /Cursor/);
  assert.match(weeklyPrompt, /self-improve|this scheduled automation/i);
  assert.match(weeklyPrompt, /\.github\/workflows/);
  assert.match(weeklyPrompt, /Windows and macOS/);
  assert.match(weeklyPrompt, /packages page/);
  assert.doesNotMatch(weeklyPrompt, /grok-maintain\.yml/);
  assert.notEqual(dailyPrompt, weeklyPrompt);

  const dailyBudget = lib.toolBudgetForMode('daily');
  const weeklyBudget = lib.toolBudgetForMode('weekly');
  assert.equal(dailyBudget.fetchEnabled, false);
  assert.equal(weeklyBudget.fetchEnabled, true);
  assert(weeklyBudget.maxSteps > dailyBudget.maxSteps);
  assert(dailyBudget.checks.includes('audit'));
  assert(!dailyBudget.checks.includes('build'));
  assert(weeklyBudget.checks.includes('audit'));
  assert(weeklyBudget.checks.includes('build'));

  assert.equal(lib.writeAllowedForMode('daily', '.github/workflows/grok-maintain.yml'), false);
  assert.equal(lib.writeAllowedForMode('daily', 'scripts/ci/scheduled-maintain.mjs'), false);
  assert.equal(lib.writeAllowedForMode('daily', 'package.json'), true);
  assert.equal(lib.writeAllowedForMode('weekly', '.github/workflows/grok-maintain.yml'), false);
  assert.equal(lib.writeAllowedForMode('weekly', 'scripts/ci/scheduled-maintain.mjs'), true);
  assert.equal(lib.writeAllowedForMode('weekly', 'node_modules/left-pad/index.js'), false);
  assert.equal(lib.writeAllowedForMode('daily', 'package-lock.json'), false);
  assert.equal(lib.isGithubWorkflowPath('.github/workflows/ci.yml'), true);
  assert.equal(lib.isGithubWorkflowPath('.github/ISSUE_TEMPLATE/bug_report.md'), false);

  assert.equal(lib.fetchHostAllowed('https://docs.x.ai/developers/models'), true);
  assert.equal(lib.fetchHostAllowed('https://code.claude.com/docs/en/overview'), true);
  assert.equal(lib.fetchHostAllowed('https://platform.claude.com/docs/en/agents-and-tools/overview'), true);
  assert.equal(lib.fetchHostAllowed('https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork'), true);
  assert.equal(lib.fetchHostAllowed('https://learn.chatgpt.com/docs/long-running-work'), true);
  assert.equal(lib.fetchHostAllowed('https://evil.example/steal'), false);
  assert.equal(
    lib.fetchHostAllowed('https://steal.learn.chatgpt.com.evil.example/docs'),
    false,
    'suffix spoofing of an allowlisted host must stay blocked',
  );

  const markdownDoc = lib.formatFetchedDocument({
    url: 'https://learn.chatgpt.com/docs/long-running-work.md',
    status: 200,
    finalUrl: 'https://learn.chatgpt.com/docs/long-running-work.md',
    body: '# Long-running work\n\nKeep multi-step work focused with clear outcomes and completion criteria.',
  });
  assert.match(markdownDoc, /HTTP 200/);
  assert.match(markdownDoc, /Keep multi-step work focused/);

  const jsShell = lib.formatFetchedDocument({
    url: 'https://docs.x.ai/docs/overview',
    status: 200,
    finalUrl: 'https://docs.x.ai/docs/overview',
    body: 'self.__next_f.push([1,"Grok 4.6 is the current flagship model for code, text, voice, image, and video."])',
  });
  assert.match(jsShell, /Grok 4.6 is the current flagship model/);
  assert.doesNotMatch(jsShell, /self\.__next_f\.push/);

  const bounced = lib.formatFetchedDocument({
    url: 'https://docs.x.ai/docs/overview',
    status: 302,
    finalUrl: 'https://evil.example/steal',
    body: 'secret',
  });
  assert.match(bounced, /redirect left the weekly research allowlist/);
  assert.doesNotMatch(bounced, /secret/);

  const skip = lib.skipWithoutApiKey({ GROK_API_KEY: '' });
  assert.equal(skip.skip, true);
  assert.equal(skip.message, lib.SKIP_NO_KEY_MESSAGE);
  assert.equal(lib.skipWithoutApiKey({ GROK_API_KEY: 'xai-test' }).skip, false);

  const script = path.join(ROOT, 'scripts', 'ci', 'scheduled-maintain.mjs');
  const run = (extraEnv: Record<string, string | undefined>, extraArgs: string[] = []) =>
    spawnSync(process.execPath, [script, ...extraArgs], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GROK_API_KEY: '', ...extraEnv },
    });

  const first = run({ GROK_API_KEY: '' });
  const second = run({ GROK_API_KEY: '' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const firstSkip = `${first.stdout}\n${first.stderr}`;
  const secondSkip = `${second.stdout}\n${second.stderr}`;
  assert.match(firstSkip, /scheduled-maintain: skipped \(GROK_API_KEY is not set\)/);
  assert.equal(
    firstSkip.includes(lib.SKIP_NO_KEY_MESSAGE),
    secondSkip.includes(lib.SKIP_NO_KEY_MESSAGE),
  );

  const validateDaily = run({ GROK_API_KEY: '', MAINTAIN_MODE: 'daily' }, ['--validate', '--mode=daily']);
  const validateWeekly = run({ GROK_API_KEY: '', MAINTAIN_MODE: 'weekly' }, ['--validate', '--mode=weekly']);
  assert.equal(validateDaily.status, 0, validateDaily.stderr);
  assert.equal(validateWeekly.status, 0, validateWeekly.stderr);
  assert.match(`${validateDaily.stdout}\n${validateDaily.stderr}`, /skipped \(GROK_API_KEY is not set\)/);
  assert.match(`${validateWeekly.stdout}\n${validateWeekly.stderr}`, /skipped \(GROK_API_KEY is not set\)/);

  const keyedValidateDaily = run({ GROK_API_KEY: 'xai-verify-only' }, ['--validate', '--mode=daily']);
  const keyedValidateWeekly = run({ GROK_API_KEY: 'xai-verify-only' }, ['--validate', '--mode=weekly']);
  assert.equal(keyedValidateDaily.status, 0);
  assert.equal(keyedValidateWeekly.status, 0);
  assert.match(keyedValidateDaily.stdout, /validate mode=daily model=grok-4\.6 target=development/);
  assert.match(keyedValidateWeekly.stdout, /validate mode=weekly model=grok-4\.6 target=development/);
  assert.notEqual(keyedValidateDaily.stdout, keyedValidateWeekly.stdout);

  const workflow = readFileSync(path.join(ROOT, '.github/workflows/grok-maintain.yml'), 'utf8');
  assert.match(workflow, /cron:\s*"17 6 \* \* \*"/);
  assert.match(workflow, /cron:\s*"17 7 \* \* 1"/);
  assert.match(workflow, /secrets\.GROK_API_KEY/);
  assert.match(workflow, /ref: development/);
  assert.match(workflow, /git push origin HEAD:development/);
  assert.match(workflow, /gh workflow run ci\.yml --ref development/);
  assert.doesNotMatch(workflow, /git push origin HEAD:main/);
  assert.match(workflow, /GROK_API_KEY secret is not set — scheduled maintain skipped/);

  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /Promote development → main/);
  assert.match(ci, /gh pr merge .* --auto/);
  assert.match(ci, /github\.ref == 'refs\/heads\/development'/);
  assert.match(ci, /native-windows:/);
  assert.match(ci, /native-macos:/);
  assert.match(ci, /needs: \[verify, audit, e2e, docker, native-windows, native-macos\]/);
  assert.match(
    ci,
    /Gate — production build before the functional suite[\s\S]*npm run build[\s\S]*Gate — functional suite must pass before pushing[\s\S]*npm test/,
  );

  const theme = readFileSync(path.join(ROOT, 'scripts/verify-theme.ts'), 'utf8');
  assert.match(theme, /assertProductionBuild/);
  assert.match(theme, /\.next is missing/);
  assert.match(theme, /start', '-H', '127\.0\.0\.1'/);
  assert.match(theme, /http:\/\/127\.0\.0\.1:\$\{PORT\}/);

  const runner = readFileSync(path.join(ROOT, 'scripts/ci/scheduled-maintain.mjs'), 'utf8');
  assert.match(runner, /finalizeMaintainRun\(\{ fixed: doneState\.fixed, cwd: REPO_ROOT \}\)/);
  assert.match(runner, /dropped workflow-only edits/);

  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'shiba-maintain-'));
  const git = (args: string[]) => {
    const res = spawnSync('git', args, { cwd: sandbox, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res;
  };
  try {
    git(['init']);
    git(['config', 'user.email', 'verify@shiba.local']);
    git(['config', 'user.name', 'scheduled-maintain verifier']);
    writeFileSync(path.join(sandbox, 'kept.txt'), 'original\n');
    git(['add', 'kept.txt']);
    git(['commit', '-m', 'seed']);
    writeFileSync(path.join(sandbox, 'kept.txt'), 'mutated by grok then discarded\n');
    writeFileSync(path.join(sandbox, 'scratch-edit.txt'), 'should not be committed\n');
    assert.notEqual(lib.gitPorcelain(sandbox), '', 'fixture must start dirty');

    const discarded = lib.finalizeMaintainRun({ fixed: false, cwd: sandbox });
    assert.equal(discarded.discarded, true);
    assert.equal(discarded.dirty, '', 'fixed=false must leave a clean tree');
    assert.match(readFileSync(path.join(sandbox, 'kept.txt'), 'utf8'), /original/);
    assert.doesNotMatch(readFileSync(path.join(sandbox, 'kept.txt'), 'utf8'), /mutated by grok/);
    assert.equal(lib.gitPorcelain(sandbox), '');
    assert.equal(existsSync(path.join(sandbox, 'scratch-edit.txt')), false, 'untracked Grok scratch must be cleaned');

    writeFileSync(path.join(sandbox, 'kept.txt'), 'real fix\n');
    writeFileSync(path.join(sandbox, 'new-feature.txt'), 'keep me\n');
    const kept = lib.finalizeMaintainRun({ fixed: true, cwd: sandbox });
    assert.equal(kept.discarded, false);
    assert.notEqual(kept.dirty, '', 'fixed=true must not discard a real change');
    assert.match(kept.dirty, /kept\.txt/);
    assert.match(readFileSync(path.join(sandbox, 'kept.txt'), 'utf8'), /real fix/);

    mkdirSync(path.join(sandbox, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(sandbox, '.github', 'workflows', 'ci.yml'), 'name: original\n');
    git(['add', '.github/workflows/ci.yml']);
    git(['commit', '-m', 'seed workflow']);
    writeFileSync(path.join(sandbox, '.github', 'workflows', 'ci.yml'), 'name: grok cannot push this\n');
    writeFileSync(path.join(sandbox, 'kept.txt'), 'keep alongside workflow edit\n');
    const dropped = lib.finalizeMaintainRun({ fixed: true, cwd: sandbox });
    assert.equal(dropped.revertedWorkflows, true);
    assert.match(dropped.dirty, /kept\.txt/);
    assert.doesNotMatch(dropped.dirty, /ci\.yml/);
    assert.match(readFileSync(path.join(sandbox, '.github', 'workflows', 'ci.yml'), 'utf8'), /original/);
    assert.match(readFileSync(path.join(sandbox, 'kept.txt'), 'utf8'), /keep alongside workflow edit/);

    writeFileSync(path.join(sandbox, '.github', 'workflows', 'ci.yml'), 'name: only workflow dirty\n');
    const onlyWorkflow = lib.revertGithubWorkflowChanges(sandbox);
    assert.equal(onlyWorkflow.reverted, true, 'leading-space porcelain must still see the workflow path');
    assert.match(readFileSync(path.join(sandbox, '.github', 'workflows', 'ci.yml'), 'utf8'), /original/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log('verify-scheduled-maintain: OK');
}

main().catch((error) => {
  console.error('verify-scheduled-maintain failed', error);
  process.exitCode = 1;
});
