# Self-healing CI

The `development` branch runs the full CI matrix on every push
(`.github/workflows/ci.yml`). The pipeline then heals itself when red and
promotes itself to `main` when green.

## Red run on development → Grok repairs it

The `self-heal` job runs when any CI job fails on `development`:

1. Downloads the failed jobs' logs.
2. Runs `scripts/ci/self-heal.mjs`, an agent loop against the xAI API
   (`GROK_API_KEY` repo secret; model defaults to `grok-4.6`,
   override with a `GROK_MODEL` repo variable). Grok can read/search the
   tree, rewrite files, apply surgical `search_replace` edits, and run the
   allowlisted verification commands
   (typecheck, lint, build, the verify suite, single verify scripts,
   npm audit / audit fix, npm install for lockfile sync after
   package.json edits, npm ls dependency tracing, devvit verify).
3. Gates the result on `tsc --noEmit`, `npm run build`, **and** `npm test`, then commits with a `[self-heal]`
   marker and pushes to `development`. The production build is required because
   `verify-theme` launches `next start` and fails fast when `.next` is missing.
4. Re-dispatches CI via `workflow_dispatch` so the healed commit gets a
   fresh full run (a plain `GITHUB_TOKEN` push does not retrigger CI).

Guardrails:

- **Loop cap** — after 3 consecutive `[self-heal]` commits that still fail,
  the job stops and opens an issue instead of pushing a 4th attempt.
- **Write fences** — the agent cannot write to `.github/`, `scripts/ci/`,
  `package-lock.json` (except via `npm audit fix`), or `node_modules`, and
  is instructed never to weaken the `proxy.ts` / `lib/terminal-server.ts`
  loopback-origin enforcement, delete tests, or silence errors with
  ignore comments.
- **Superseded runs** — if `development` moved while the run was in flight,
  the healer bows out and lets the newer run handle it.
- If `GROK_API_KEY` is missing the job skips with a warning instead of
  failing.

## Green run on development → auto-promotion to main

The `promote` job runs after the aggregate `CI OK` job succeeds on
`development`:

1. If `development` is ahead of `main`, it opens (or reuses) the
   "Promote development to main" PR.
2. Enables auto-merge (merge commit). `main` is branch-protected with
   `CI OK` as a required status check, so the merge only lands once that
   check is green on the PR's head commit — which the just-finished green
   run already provides.
3. Waits for that merge, then dispatches `ci.yml` on `main` through the
   Actions API (this job has no checkout, so `gh workflow run` cannot be
   used). A `github-actions` auto-merge uses `GITHUB_TOKEN` and does not
   start the main push pipeline; the dispatch is what compiles and
   publishes the stable Windows/macOS packages.

`CI OK` exists so branch protection tracks a single stable context instead
of every matrix leg name; keep it in sync with the job list in `ci.yml`.
That list includes the Windows and macOS app package jobs (`native-windows`,
`native-macos`) so a broken desktop host or packer fails the same gate as
`npm test`. Successful compiles on `main` and `development` (a direct push
or the `workflow_dispatch` re-run that self-heal and weekly maintain use)
then publish those artifacts to rolling GitHub Releases and
[the packages page](https://shiba-studio.io/packages.html) via the
`publish-packages` job (not required for CI OK, so a Pages flake
cannot block promote).

Manual escape hatches: repo admins can still push to `main` directly
(`enforce_admins` is off), and deleting the `GROK_API_KEY` secret turns the
whole healing half off without touching the workflow.

## Hands-off scheduled maintenance (Grok 4.6+)

`.github/workflows/grok-maintain.yml` keeps the tree current without a human
in the loop. It never writes `main`.

| Cadence | Cron (UTC) | Job |
| --- | --- | --- |
| Daily | `17 6 * * *` | Remediate high/critical `npm audit` findings |
| Weekly (Monday) | `17 7 * * 1` | Assess Claude / ChatGPT-Codex / Grok / Cursor, ship at most one bounded increment, and optionally improve this automation |

Both jobs:

1. Check out `development`.
2. Skip with a warning (exit 0) when `GROK_API_KEY` is unset.
3. Run `node scripts/ci/scheduled-maintain.mjs` at **Grok 4.6 or later**
   (`scripts/ci/scheduled-maintain-lib.mjs` refuses `grok-4.5` /
   `grok-code-fast-1` as the unattended default even if `GROK_MODEL` is set
   to those ids).
4. Commit and `git push origin HEAD:development` only when the tree changed.
   `.github/workflows/*` edits are dropped; `GITHUB_TOKEN` cannot push them.
5. Re-dispatch `ci.yml` on `development` so **CI OK** + the existing
   **Promote development → main** job can auto-merge.

`workflow_dispatch` accepts `mode=daily|weekly` for a manual dry fire.
Three consecutive `[scheduled-daily]` or `[scheduled-weekly]` commits abort
the loop and open an issue. If Grok calls `done(fixed=false)` after editing
files, `finalizeMaintainRun` runs `git reset --hard` and `git clean -fd` so
the workflow cannot `git add -A` those discarded edits.

Policy lives in `scripts/ci/scheduled-maintain-lib.mjs` so
`scripts/verify-scheduled-maintain.ts` can exercise the real mode split,
model default, write fences, and no-key skip without calling xAI.
Weekly `fetch_url` also allows `learn.chatgpt.com` (ChatGPT Work / Codex
product docs), prefers Markdown/`text/plain` responses, extracts prose from
JS app shells, and rejects redirects that leave the host allowlist.

## Admin and automation issues

`.github/workflows/grok-issues.yml` asks Grok to address open issues that
were filed by a repository **admin** (OWNER / MEMBER / COLLABORATOR) or by
an **enabled project automation** (`github-actions[bot]`, Dependabot,
Renovate, or any `[bot]` account). Random public issues are ignored.

| Trigger | When |
| --- | --- |
| `issues` opened / reopened | Immediately, if the author is eligible |
| Daily cron `23 6 * * *` | Oldest eligible open issue |
| `workflow_dispatch` | Optional issue number, else oldest eligible |

The job:

1. Skips with a warning (exit 0) when `GROK_API_KEY` is unset.
2. Checks out `development`.
3. Runs `node scripts/ci/address-issues.mjs --select` (the same selector the
   tests drive with `--issues-file`).
4. Labels the issue `grok-working`, asks Grok 4.6+ to implement a fix, then
   `git reset --hard` + `git clean -fd` if Grok reports no change.
5. Commits `[grok-issue-#N]` to `development` only when the tree changed,
   re-dispatches `ci.yml`, and comments (optionally closing) the issue.
   A failed or skipped push is labeled `grok-failed` and does **not** close
   the issue. `GITHUB_TOKEN` cannot update `.github/workflows/*`; those
   edits are dropped before commit.

Three consecutive commits for the same issue abort the loop. Label
`grok-skip` or `wontfix` opts an issue out. Policy lives in
`scripts/ci/address-issues-lib.mjs`.
