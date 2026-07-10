# Contributing to Shiba Studio

Thanks for wanting to help! Shiba Studio is a local-first agent studio built on
Next.js 16 + React 19, powered exclusively by Grok/xAI. Much appreciated, very
welcome.

## Getting set up

```bash
git clone https://github.com/stevologic/shiba-studio.git
cd shiba-studio
npm install
npm run dev        # → http://127.0.0.1:3000
```

Requirements: **Node.js ≥ 22.5** (the runs/audit store uses built-in
`node:sqlite`; nothing to compile). Windows, macOS, and Linux are all
first-class targets — please don't introduce platform-specific code paths
without a fallback.

Read [docs/development.md](docs/development.md) for the repo layout and
architecture notes, and [AGENTS.md](AGENTS.md) for the one hard rule about
this Next.js version.

## Before you open a PR

1. **Typecheck:** `npx tsc --noEmit` must be clean.
2. **Lint:** `npm run lint` — don't add new errors (legacy `no-explicit-any`
   debt is tracked in [TODO.md](TODO.md); reducing it is welcome).
3. **Test:** `npm test` runs the functional verification suite. It is fully
   isolated — it writes to a temp `SHIBA_DATA_DIR`, never your live
   `~/.shiba-studio` data.
4. **Build:** `npm run build` must succeed.

CI runs all four on Windows/macOS/Linux × Node 22.5/24.

## Guidelines

- **Security first.** Anything that widens what a web page or the network can
  reach must be discussed in an issue first — read [SECURITY.md](SECURITY.md)
  for the threat model. Never weaken the origin checks (`proxy.ts`, terminal
  bridge) or the localhost binding.
- **Secrets** are AES-256-GCM encrypted via `lib/secret-store.ts` — never
  write a credential to disk in plaintext, and never log one.
- **Keep it local-first.** No telemetry, no phoning home. Outbound traffic is
  xAI plus integrations the user explicitly configures.
- **Grok-only by design.** Model connectivity goes through cloud xAI, X OAuth,
  the Grok CLI, or an OpenAI-compatible local server. PRs adding other hosted
  providers are out of scope.
- **UI conventions:** dark space-cockpit theme, `grok-btn`/`grok-input`/
  `status-pill` utility classes from `app/globals.css`, `lucide-react` icons,
  toasts via `lib/toast.ts`. Match what's already there.
- **Docs:** if you change behavior described in `docs/` or the README, update
  them in the same PR.

## Reporting bugs & requesting features

Use the issue templates. For suspected security vulnerabilities, **do not
open a public issue** — see [SECURITY.md](SECURITY.md).

## Code of conduct

Be excellent to each other — see
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Much respect, very community.
