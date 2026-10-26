# Maintenance pilot

The feature normally merges the seven main-only commits with the two development-
only commits. Both histories are preserved; main/development are untouched by the
draft. No branch rename/force push occurs. PR50 remains held at action_required;
PR51's proposed --omit=dev audit narrowing remains a separate review decision.

The shared [contract 1.1.1](https://github.com/stevologic/oss-deps-explorer/blob/bf9289390aa6304c4ed81596fb0d7dfba712608b/actions/maintenance/README.md)
uses a full immutable SHA and local JSON policy. It is GET-only/dry-run, with all
write/deploy/cleanup and optional AI disabled. Shiba retains its current xAI
provider/model policy and custom strategy/self-heal/content/release jobs.

Traffic moves from daily to weekly (no configured credential currently means a
green no-op). Grok strategy moves from weekly to monthly using its legacy weekly
mode; vulnerability mode gets an explicit weekly schedule and manual urgency.
PR/push/full npm audit/security/review/native gates remain intact. Promotion stops
the ten-minute idle wait and reports the actual PR state. A trusted completion/
approval/merge workflow checks an actual same-repo development merge at current
main, avoids duplicate main CI dispatch, and never merges or checks out PR code.
workflow_run also handles GitHub-token activity whose ordinary events are suppressed.
Promotion reads explicit locked PRs from the exact tested integration commit and
stops for PR50's owner hold or any security/review hold label. A moved development
head also stops; neither a green dispatch nor auto-merge can bypass these holds.

Native Dependabot version proposals target development: weekly root/Devvit npm and
Docker, monthly Actions. Security proposals remain default-main targeted, timely
and independent of version cadence. Majors require quarterly/urgent security review.

Compatible security fixes update root sharp, proxy-addr, source-map-js, Hono and
ip-address; full root audit is zero. Devvit gets compatible Hono/js-yaml/brace-
expansion/lock patches. **Its remaining 16 advisories (9 high, 7 moderate) need
Devvit CLI/toolchain migration review**; no forced major, dependency alias, audit
omission or fabricated clean report hides them. A root green audit does not clear
this nested backlog. Existing PR51 narrows audit instead; this draft preserves full
root coverage and documents the separate nested work.

Local lint passes with 3 pre-existing warnings; TypeScript and scheduler verification
pass. Devvit typecheck/9 tests/Vite build pass. Windows Turbopack build hits a child-
process startup panic after font access succeeds; the exact Ubuntu PR build/full
functional/Playwright/Docker gates remain required. The supported webpack diagnostic
exposed an existing invalid Next route helper export. That helper now lives in
lib/run-cancellation.ts, preserving cancellation semantics; its real optimistic
heartbeat/completion race suite and the complete webpack production build pass.
Shared local browsers, native
packagers, UI/game/test resources and Docker daemon were not used.

Offline inventory produced three merged-topic cleanup candidates whose exact tips
were contained in both main and development. Separately approved execution repeated
fresh owner/open-PR/protection/ancestry reads and used the tested advertised-SHA
atomic deletion guard without force push. All three are verified absent:
chore/consolidate-into-development (merged PR42),
cursor/shiba-studio-project-stewardship-5b54 (merged PR39), and
cursor/windows-ios-packages-894d (merged PR29). Their commits remain in both histories.
The scheduled common action stays read-only; protected/active/unmerged topics remain.
Production schedule/config activation waits for reviewed integration and main PR.

Standard Ubuntu CI exposed global Tailwind preflight emitted into the IDE CSS module
after the Devvit package linked this root checkout into its nested node_modules.
The root-only Docker/browser builds pass. CI now installs that bridge at its own
verification stage, after the root build and functional suite. Both lockfiles and
every root/bridge gate remain required. A native Tailwind reused-processor test
verifies global preflight/tokens and unchanged module declarations. The standard
compiler, native PostCSS configuration and current design remain intact.
