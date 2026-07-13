# nextjs/saas-starter Assessment

**Target:** https://github.com/nextjs/saas-starter (official `nextjs` org)
**Stars:** ~16k stars / ~2.7k forks
**License:** MIT
**Last updated:** ~Dec 2025 (per prior context; canary-heavy)
**Demo:** https://next-saas-start.vercel.app/
**Stack:** Next.js 15.6.0-canary.59 + React 19 + Postgres (postgres.js) + Drizzle ORM + Stripe + shadcn/ui + Tailwind 4 + Zod + JWT cookies (jose + bcryptjs)
**Assessment date:** 2026-07-12

## Rubric Scores (1-5)

### 1. Features — 3/5
Strong baseline for a minimal SaaS:
- Email/password auth with JWT in httpOnly cookies + sliding sessions.
- Global `middleware.ts` for route protection; local Zod-validated Server Actions (`validatedAction`, `withTeam` helpers).
- Teams + basic RBAC (Owner/Member via `team_members` table).
- Stripe Checkout, Customer Portal, subscription management on `teams` table (14-day trial).
- Dashboard CRUD for users/teams; activity logging (`activity_logs` table + enum).
- Marketing landing with animated terminal, pricing page.
- Setup DX: `pnpm db:setup` (interactive .env), migrate, seed.

**Gaps:** No OAuth/social login, no admin panel, no tests/CI visible, no email templates, limited multi-tenant depth (no organizations beyond teams), no AI/agent integrations. Evidence: README + package.json + repo tree (lib/, app/ routes, drizzle schema in lib/db).

### 2. Value — 5/5
Excellent free/MIT-quality learning resource. README transparently links to paid full-featured alternatives (achromatic.dev, shipfa.st, makerkit.dev, zerotoshipped.com, turbostarter.dev). Serves as clean baseline for comparison and cherry-picking patterns rather than production-ready out-of-box. High educational value for Next.js team patterns. (Evidence: README "Other Templates" section.)

### 3. Agent-readiness — 1/5
Very low.
- No `AGENTS.md`, `CLAUDE.md`, `llms.txt`, or any AI/LLM-specific docs (confirmed via GitHub contents API 404 on .github and root).
- No CI workflows, no test scripts in package.json (only db:* and standard Next scripts).
- Small, readable codebase with good structure (lib/ for auth/db/actions, components/ui from shadcn) but no explicit contracts, skills, or agent guidance.
- Inference: Official Next.js repo, so follows their conventions, but not tuned for autonomous coding agents. (Evidence: repo contents API, package.json scripts.)

### 4. Maturity — 3/5
- High popularity (16k stars) and official backing provide credibility.
- Maintenance appears active via Vercel/Next team (leerob influence noted in history).
- **Significant risk:** Next.js 15 canary.59 — bleeding edge with known recent security bumps (e.g., Dec 2025 CVE references in prior notes). Noisy open PRs (~30) and issues (~21).
- Drizzle + Postgres solid; Stripe integration standard. Good issue health for a starter but canary makes it less production-mature. (Evidence: GitHub repo page, package.json, README.)

### 5. Shiba fit — 4/5
Excellent alignment with Shiba's Next.js core, Tailwind/shadcn, Postgres, modern React. Many patterns (validated actions, team-scoped billing, activity logs, middleware) are directly portable. However, Shiba already has deeper agent/board/MCP/infra capabilities — full adopt or fork unnecessary. Best as reference for specific improvements. (Evidence: Comparison to Shiba docs/agents.md, architecture.md; stack overlap with current project.)

**Composite Score: ~3.2/5**

## Cherry-pick List
High-value, low-risk extracts (prioritized):
1. **`validatedAction` / `validatedActionWithUser` / `withTeam` helpers** — clean Zod + user/team context for Server Actions (lib/actions.ts or similar).
2. **Team-scoped Stripe integration** (customer, subscription, portal bootstrap on teams table).
3. **`activity_logs` table + `ActivityType` enum + logging middleware** — great for audit trails.
4. **Invitations system** (table shape and flows).
5. **Sliding session cookie refresh pattern** (auth utils with jose).
6. **`pnpm db:setup` interactive env script** — excellent DX for new devs.
7. Animated terminal on landing (if reusable).

All claims attributed to README, package.json, GitHub tree/contents (fetched via API/raw), and demo.

## Recommendation: **CHERRY-PICK**

Do not ADOPT or FORK — too minimal and canary-risky for full integration. Excellent for targeted pattern adoption into Shiba's existing stack (especially action validation, team billing, logging). WATCH for stabilization post-canary. Distinct value vs prior assessments (ixartz, Wasp, ShipFree): official minimal baseline.

**Sources:**
- Primary: https://github.com/nextjs/saas-starter (README, package.json, tree)
- GitHub API checks for AGENTS.md/.github (404s)
- Demo site, prior board cards (SHIB-11, SHIB-9, SHIB-21 for comparison)

No POC code created in workspace per explicit constraints ("research + doc only"; "Do not clone/adopt into Shiba product code").

---
**Final card verdict:** CHERRY-PICK. Strong learning baseline with portable helpers for actions, teams, and billing. Low agent readiness but high Shiba relevance for selective integration. Doc complete.
