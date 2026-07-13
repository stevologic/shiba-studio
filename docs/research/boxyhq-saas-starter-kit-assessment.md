# BoxyHQ SaaS Starter Kit Assessment

**Target:** https://github.com/boxyhq/saas-starter-kit
**Stars / forks:** ~4.9k / ~1.2k
**License:** Apache-2.0
**Version:** 1.6.0 (`package.json`)
**Stack:** Next.js 15.5.14 · React 18.3 · TypeScript 5.9 · Tailwind 3.4 + DaisyUI · Prisma 6.10 · Postgres · NextAuth 4.24 · Stripe 17 · BoxyHQ Jackson / Svix / Retraced / Sentry
**Assessment date:** 2026-07-12
**Method:** Research + doc only (GitHub API/raw README, package.json, schema, lib/, pages/, CI). No full local install/clone into product code.

---

## Rubric Scores (1–5)

| Dimension | Score | Notes |
| --- | --- | --- |
| Feature completeness | **4.5/5** | Best-in-class free enterprise surface (SSO, SCIM, audit, webhooks, teams, Stripe) |
| Agent / vibe-coding readiness | **1.5/5** | No AGENTS.md / CLAUDE.md / llms.txt / MCP; strong lint/test CI only |
| DX | **4/5** | Single package, Docker Postgres, clear README, feature flags; enterprise deps add setup weight |
| Stack modernity | **2.5/5** | Next 15 on **Pages Router**, NextAuth v4, React 18, Tailwind 3/DaisyUI |
| Cost / licensing | **4/5** | Apache-2.0 code; $0 path for core; paid SaaS optional for Svix/Retraced/Sentry/Jackson cloud |
| Shiba fit (patterns to steal) | **3.5/5** | Enterprise patterns transferable; full fork misaligned with App Router / agent-first stack |

**Composite: ~3.4/5** (enterprise value high; modernity + agent readiness pull down)

---

## 1. Feature completeness

### Auth — strong
- NextAuth v4 with credentials, magic link (email/SMTP), GitHub, Google, SAML SSO, IdP-initiated.
- Account lock after failed logins (`accountLock`, `MAX_LOGIN_ATTEMPTS`).
- Feature-flagged providers via `AUTH_PROVIDERS`.
- Session strategy jwt or database (`NEXTAUTH_SESSION_STRATEGY`).
- Embedded **@boxyhq/saml-jackson** (or external Jackson URL) for SAML/OIDC SSO.
- SCIM **directory sync** under `pages/api/scim` + team `directory-sync` UI.

### Multi-tenancy / teams — strong
- First-class `Team` / `TeamMember` / `Invitation` / `ApiKey` in Prisma.
- Roles: OWNER / ADMIN / MEMBER with resource-level RBAC (`lib/permissions.ts`, `lib/rbac.ts`).
- Team switcher, slug routes, domain, default role.
- Team feature flags: SSO, DSYNC, audit log, webhook, API key, payments, deletion.

### Billing — present (not flashy)
- Stripe customer bind on team (`billingId` / `billingProvider`), `Subscription` / `Service` / `Price` models, team billing + products pages, `sync-stripe` script, Stripe webhooks API.
- Payments only enable when both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set.
- README still lists “Billing & subscriptions” under **Coming Soon** while Stripe is implemented — docs lag slightly.

### Admin / enterprise ops — differentiator
- Team SSO, directory sync, audit logs (**Retraced** + viewer), outbound webhooks (**Svix**), team API keys.
- reCAPTCHA, security headers toggle, Slack notify hook, Mixpanel, OpenTelemetry metrics (`@boxyhq/metrics`).
- No global “platform super-admin” product console — tenancy is team-scoped.

### i18n — yes
- `next-i18next` + `locales/`, locale check scripts, eslint-plugin-i18next.

### AI / agent docs — none
- No AI features, agent runbooks, or LLM integration docs.

### Tests & quality gates — strong
- Jest unit tests (`__tests__/lib`), Playwright e2e (`tests/e2e`).
- CI (`.github/workflows/main.yml`): lint, format, locale check, jest, build, types, prisma migrate, Playwright with Postgres + mock SAML.
- Dependabot present; recent main commits mostly dependency bumps (healthy but not feature-velocity).

### Deploy / observability
- Vercel / Heroku / DigitalOcean one-click buttons; `docker-compose.yml` = Postgres 16 only (app not containerized in compose).
- Sentry client config + instrumentation; OTEL env knobs.

---

## 2. Agent / vibe-coding readiness

| Signal | Present? |
| --- | --- |
| AGENTS.md / CLAUDE.md / llms.txt | **No** (root 404) |
| Skills / MCP configs | **No** |
| Explicit agent guardrails | **No** |
| Lint / format / typecheck scripts | **Yes** (`check-lint`, `check-format`, `check-types`, `test-all`, knip) |
| CI as safety net | **Yes** (full pipeline) |
| Structured `lib/` + models | **Yes** — readable for agents once guided |
| App Router / Server Actions idioms | **No** — pages + API routes era |

**Score: 1.5/5.** Production guardrails exist (eslint, prettier, tests, RBAC). Zero first-class AI-agent onboarding. Agents will reverse-engineer from README + tree; higher token cost and Pages-router friction vs modern App Router starters.

---

## 3. DX

**Setup (minimal path):**
1. `npm install`
2. `cp .env.example .env` + Postgres (Docker: `docker-compose up -d`)
3. `npx prisma db push`
4. `npm run dev` (port **4002**)

**Pros**
- Single package (not monorepo) — simpler mental model.
- Excellent feature toggles in env (turn off SSO/audit/webhooks until needed).
- Prisma Studio, seed, delete-team utility, sync-stripe.
- TypeScript `strict: true` (note: `noImplicitAny: false` softens strictness).

**Cons**
- Enterprise surface area is large; full stack needs many third-party accounts (SMTP, Stripe, Svix, Retraced, OAuth apps, optional Jackson SaaS).
- DaisyUI/Formik/Yup stack is coherent but less “2026 shadcn/RSC default” than competitors.
- Jackson embedded can bloat local mental/runtime cost vs thin SSO adapters.

**Setup time estimate:** core auth+teams ~30–60 min; full enterprise surface half-day+.

---

## 4. Stack modernity & lock-in

| Area | Reality | Risk |
| --- | --- | --- |
| Routing | **Pages Router** only (`pages/`, `pages/api/`) | Maintainers discussed App Router with **no timeline** (discussion #1623, Feb 2026) |
| Auth | NextAuth **v4** | Behind Auth.js v5 / NextAuth 5 ecosystem |
| React | **18.3** | Not React 19 |
| CSS | Tailwind **3** + DaisyUI | Not Tailwind 4 / shadcn |
| ORM | Prisma + Postgres | Solid, portable |
| Enterprise deps | Jackson, Retraced, Svix, BoxyHQ UI | **High product lock-in** if you lean on full suite; optional via feature flags |
| Next version | 15.5.14 stable (not canary) | Safer than nextjs/saas-starter canary |

**Bottom line:** Dependencies are patched and current, but architecture is **legacy-Next** relative to 2026 App Router norms. Fork-and-ship means inheriting a future migration tax or accepting Pages Router long-term.

---

## 5. Cost to run & licensing

| Component | $0 path? |
| --- | --- |
| Starter code | Yes — **Apache-2.0** |
| Postgres | Yes — local Docker / free tiers |
| NextAuth email/password + magic link | Yes if you self-host SMTP (or free Resend/etc. tiers) |
| GitHub/Google OAuth | Yes (free developer apps) |
| Stripe | Test mode free; production % fees only |
| SAML Jackson | **Yes if embedded/self-hosted**; BoxyHQ cloud optional |
| Svix webhooks | Free tier / self-host alternatives; disable with `FEATURE_TEAM_WEBHOOK` |
| Retraced audit | Self-host or cloud; disable with `FEATURE_TEAM_AUDIT_LOG` |
| Sentry | Free tier / omit DSN |

**$0 path exists** for a credible multi-tenant SaaS with email+OAuth auth and teams. Full enterprise compliance story pushes toward Jackson/Retraced/Svix ops cost (time or SaaS $).

---

## 6. Pros / cons vs peers

### vs Open SaaS (Wasp)
| | BoxyHQ | Open SaaS (Wasp) |
| --- | --- | --- |
| Stack control | Plain Next.js — agents know the stack | Wasp DSL/framework — strong conventions, extra abstraction |
| Enterprise (SSO/SCIM/audit) | **Wins clearly** | Weaker / not the pitch |
| Vibe-coding | Weaker (no agent docs; Pages) | Often better starter DX for greenfield features |
| Lock-in | BoxyHQ ecosystem optional | Wasp framework lock-in |

### vs ixartz SaaS-Boilerplate
| | BoxyHQ | ixartz |
| --- | --- | --- |
| Enterprise auth | **Wins** (SAML/SCIM/audit) | More marketing/boilerplate breadth |
| Modern Next | Loses (Pages) | Typically more App-Router-aligned |
| Agent readiness | Both weak without AGENTS.md; ixartz structure often simpler for greenfield |

### vs nextjs/saas-starter (prior SHIB assessment)
- BoxyHQ is **far more feature-complete** (enterprise + tests + i18n).
- Official nextjs starter is **more modern baseline** (App Router-ish canary stack) but thin.
- nextjs starter scored CHERRY-PICK for helpers; BoxyHQ is CHERRY-PICK for **enterprise modules**, not full stack adopt.

### vs FlareStarter / BoringStack / stickerdaniel (series context)
- BoxyHQ’s unique wedge is **compliance-grade tenancy** (SSO, directory sync, audit, webhooks), not AI/vibe DX.
- Expect lower agent friendliness than AI-ready or opinionated “boring” modern kits if those ship App Router + agent files.

---

## 7. Cherry-pick list (high value)

1. **Team RBAC matrix** (`lib/permissions.ts` + resource actions) — clean, portable.
2. **Env feature flags** for team enterprise modules (`FEATURE_TEAM_*`).
3. **SAML/SCIM integration shape** via Jackson (if shipping B2B enterprise).
4. **Account lock / max login attempts** pattern.
5. **Team-scoped API keys** model + hashed keys.
6. **Audit log + webhook event emission** design (even if reimplemented without Retraced/Svix).
7. **CI recipe**: mock SAML + Playwright + Postgres service for enterprise auth e2e.
8. **Invitation allowedDomains** multi-domain invite control.

---

## Verdict

### **CHERRY-PICK** (not full fork-and-ship for Shiba / agent-first greenfield)

**Confidence: high (≈0.85)**

**Why not fork-and-ship**
- Pages Router + NextAuth v4 + React 18 is a modernization debt bomb for new AI-agent products on App Router.
- Heavy BoxyHQ-centric enterprise deps unless carefully stripped.
- Zero agent-oriented docs; poor vibe-coding baseline vs purpose-built modern starters.

**Why not pass**
- Best free OSS enterprise Next kit in this assessment series for SSO / SCIM / audit / team webhooks.
- Production-grade tests, RBAC, and ops toggles worth stealing.
- Apache-2.0 and active dependency maintenance.

**When to fork-and-ship instead**
- You are building **B2B enterprise SaaS** where SAML + SCIM + audit are day-one requirements **and** you accept Pages Router (or budget a full App Router migration).

**Shiba Studio recommendation**
- Do **not** replace Shiba’s stack with this kit.
- Cherry-pick RBAC, feature flags, audit/webhook patterns, and enterprise auth design notes into Shiba product work when B2B compliance features land.
- Watch for official App Router migration before reconsidering full adoption.

---

## Evidence sources
- https://github.com/boxyhq/saas-starter-kit (README, package.json, prisma/schema.prisma, lib/*, pages/*, .github/workflows/main.yml, .env.example, docker-compose.yml)
- GitHub contents API 404s for AGENTS.md / CLAUDE.md
- Discussion #1623 (App Router timeline: planned, no date)
- Prior assessment: `docs/research/nextjs-saas-starter-assessment.md` (SHIB nextjs/saas-starter)

---

## Deliverables (SHIB-14)

1. **This assessment** — `docs/research/boxyhq-saas-starter-kit-assessment.md`
2. **Original sample POC** — `pocs/boxyhq-patterns-lab/` (own code; not a fork of the BoxyHQ repo)

### POC verification

```bash
cd pocs/boxyhq-patterns-lab
npm install
npm test    # 24 passed
npm run demo
```

### What the POC implements (cherry-picks)

| Pattern | Path |
| --- | --- |
| RBAC matrix OWNER/ADMIN/MEMBER | `src/policy/rbac.ts` |
| `FEATURE_TEAM_*` + Stripe-gated payments | `src/config/feature-flags.ts` |
| Account lockout | `src/security/login-lockout.ts` |
| Hashed team API keys | `src/security/team-api-keys.ts` |
| Audit log + webhook outbox | `src/observability/*` |
| Invitation `allowedDomains` | `src/tenancy/invitations.ts` |
| Role+flag guard with audit-on-deny | `src/policy/authorize.ts` |
| Wired façade | `src/app/team-console.ts` |

SAML/SCIM/CI mock-SAML: design notes only in `src/notes/enterprise-auth.md`.
