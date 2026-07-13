# BoxyHQ patterns lab (SHIB-14 POC)

**Original sample project** — not a clone or fork of [boxyhq/saas-starter-kit](https://github.com/boxyhq/saas-starter-kit).
Reimplements the highest-value **enterprise SaaS patterns** from that kit in a tiny, zero-runtime-dep TypeScript lab so we can evaluate and cherry-pick for Shiba.

Assessment write-up: `docs/research/boxyhq-saas-starter-kit-assessment.md`

## Why this exists

BoxyHQ’s starter is Pages Router + NextAuth v4 + Jackson/Svix/Retraced — strong enterprise surface, weak agent/vibe fit for greenfield App Router work.
This lab extracts the **portable ideas** (RBAC, feature flags, lockout, team API keys, audit + webhook outbox, invite domain allowlists) into readable code you can steal without inheriting the stack.

## Patterns covered

| Pattern | Module | BoxyHQ analogue |
| --- | --- | --- |
| Team RBAC (OWNER / ADMIN / MEMBER) | `src/policy/rbac.ts` | `lib/permissions.ts` / `lib/rbac.ts` |
| `FEATURE_TEAM_*` env gates (+ Stripe for payments) | `src/config/feature-flags.ts` | `.env` feature toggles |
| Account lockout after failed logins | `src/security/login-lockout.ts` | account lock / max attempts |
| Hashed team API keys | `src/security/team-api-keys.ts` | team API key model |
| Audit log (in-memory store) | `src/observability/audit-log.ts` | Retraced-shaped events |
| Webhook outbox (in-memory) | `src/observability/webhook-outbox.ts` | Svix-shaped emit |
| Invitation `allowedDomains` | `src/tenancy/invitations.ts` | multi-domain invite control |
| Unified authorize + audit-on-deny | `src/policy/authorize.ts` | role + flag guard |

SAML/SCIM/CI mock-SAML are **design notes only** in `src/notes/enterprise-auth.md` (no network clients).

## Run

```bash
cd pocs/boxyhq-patterns-lab
npm install
npm test
npm run demo
```

Requires Node ≥ 20. Dev deps only (`tsx`, `typescript`, `@types/node`).

## Verdict (lab purpose)

**CHERRY-PICK** these modules into product code when B2B compliance lands.
**Do not** fork the full BoxyHQ Pages Router kit for agent-first greenfield.

## License

This original sample is part of Shiba Studio and follows the repository's
AGPL-3.0-or-later license. The evaluated BoxyHQ SaaS Starter Kit is separately
Apache-2.0 licensed; no BoxyHQ source code is copied into this lab.
