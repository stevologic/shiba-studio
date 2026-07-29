# Self-healing CI

The `development` branch runs the full CI matrix on every push
(`.github/workflows/ci.yml`). The pipeline then heals itself when red and
promotes itself to `main` when green.

## Red run on development → Grok repairs it

The `self-heal` job runs when any CI job fails on `development`:

1. Downloads the failed jobs' logs.
2. Runs `scripts/ci/self-heal.mjs`, an agent loop against the xAI API
   (`GROK_API_KEY` repo secret; model defaults to `grok-code-fast-1`,
   override with a `GROK_MODEL` repo variable). Grok can read/search the
   tree, rewrite files, and run the allowlisted verification commands
   (typecheck, lint, build, the verify suite, single verify scripts,
   npm audit / audit fix, npm install for lockfile sync after
   package.json edits, npm ls dependency tracing, devvit verify).
3. Gates the result on `tsc --noEmit`, then commits with a `[self-heal]`
   marker and pushes to `development`.
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

`CI OK` exists so branch protection tracks a single stable context instead
of every matrix leg name; keep it in sync with the job list in `ci.yml`.

Manual escape hatches: repo admins can still push to `main` directly
(`enforce_admins` is off), and deleting the `GROK_API_KEY` secret turns the
whole healing half off without touching the workflow.
