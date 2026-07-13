# Enterprise auth design notes (not implemented as network clients)

These BoxyHQ capabilities are valuable for B2B but intentionally **out of scope** for this lab’s runtime (no Jackson/SCIM HTTP clients).

## SAML SSO (BoxyHQ Jackson)

- Embed `@boxyhq/saml-jackson` or point at a Jackson service URL.
- Team-scoped SSO connections (IdP metadata / ACS / entity ID).
- NextAuth provider that hands off to Jackson for SAML/OIDC.
- Feature flag: `FEATURE_TEAM_SSO`.

## Directory sync (SCIM)

- SCIM endpoints under team scope (`/api/scim` style).
- Provision/deprovision users into `TeamMember` on SCIM events.
- Feature flag: `FEATURE_TEAM_DSYNC`.

## CI mock-SAML recipe

BoxyHQ CI runs Playwright against Postgres + a mock SAML IdP. For Shiba product tests, prefer:

1. Contract tests for ACS callback parsing + role mapping.
2. Optional containerized mock IdP only in e2e job.
3. Unit-level tests for RBAC + invite domain + lockout (this lab covers that layer).

## When to implement for real

Ship Jackson/SCIM only when a customer requires SSO day-one. Until then, keep the **feature flags, RBAC resources (`team_sso`, `team_dsync`), and audit events** so the product surface can light up without a rewrite.
