# Development

> New to the codebase? Start with the [feature-interaction diagram](architecture.md) — it maps every surface onto the engine pieces listed below.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · Tailwind 4 · Node ≥ 22.5 with built-in `node:sqlite` · puppeteer for browser control · node-cron inside the durable Automation engine. No native modules anywhere — the repo builds identically on Windows, macOS, and Linux.

## Repo layout

| Path | What lives there |
| --- | --- |
| `app/[[...section]]/page.tsx` | Single catch-all route rendering the whole shell — every tab is a URL segment |
| `app/api/*` | 50+ API routes: agents, runs, chat sessions/streaming, git, obsidian, sub-browser, tools, sync, usage, logs, backup, search, terminal, tts, version, … |
| `components/shiba-studio.tsx` | The shell: nav, top bar, dashboard/agents/automations/capabilities/settings tabs, modals |
| `components/grok-chat-panel.tsx` | Chat: streaming, slash commands + autocomplete, attachments, workspace binding, annotation hand-off |
| `components/sub-browser.tsx`, `components/workspace-picker.tsx` | The annotation sub-browser and chat-workspace folder picker modals |
| `lib/agent-runtime.ts` | The heart: tool definitions + the Grok tool-calling run loop |
| `lib/agent-tool-exec.ts` | Tool execution (files, shell, browser, integrations, MCP, power tools) |
| `lib/agent-power-tools.ts` | Web search/fetch, workspace grep, persistent memory, image generation |
| `lib/git-actions.ts`, `lib/browser.ts`, `lib/grok-cli.ts` | Git ops, puppeteer control, CLI detection/execution |
| `lib/db.ts`, `lib/agent-runs-store.ts`, `lib/audit-log.ts` | SQLite schema (`user_version` migrations + FTS5), run persistence, audit trail |
| `lib/routines.ts`, `lib/automation-cron.ts` | The single durable Automation engine: definitions, trigger claims, invocations, retries, leases, cron validation, and headless execution |
| `instrumentation.ts`, `app/api/boot/route.ts` | Start the same process-global Automation engine idempotently; instrumentation also starts the terminal bridge, retention pruning, channel listeners, and the mDNS responder |
| `lib/mdns.ts` | Multicast-DNS responder advertising `shiba.local` (dependency-free) |
| `lib/secure-store.ts`, `lib/persistence.ts` | AES-256-GCM sealing and config/agent stores |
| `lib/run-guards.ts`, `lib/cron-estimate.ts` | Concurrency/spend/token-cap guards, offline probe, cron-frequency estimate |
| `lib/backup.ts`, `lib/retention.ts`, `lib/global-search.ts` | One-file backup/restore, retention pruning, FTS5 search across chats/runs/logs |
| `lib/inline-tool-calls.ts` | Recovers tool calls that small local models emit as text |
| `lib/background-tasks.ts` | Chat-dispatched background tasks: fire-and-forget agent runs with results delivered back into the session |
| `lib/board.ts`, `lib/board-runner.ts` | Shared Kanban board store + card→agent-run dispatch; `components/kanban-board.tsx` is the Linear-style UI |
| `lib/voice-vad.ts` | Acoustic voice-activity detection for voice-mode barge-in (echo-cancelled mic energy; pure detector + WebAudio plumbing) |
| `lib/app-events.ts`, `lib/live-events.ts` | Live change feed: stores emit on write → `/api/events` (SSE) → shell/board refresh without polling or page reloads |
| `lib/brand.ts` | Brand source of truth: the shiba mark SVG and the 1200×630 share card that every committed icon is rendered from |
| `scripts/verify-*.ts` | The functional verification suite (`verify-all.ts` chains them) |
| `playwright.config.ts`, `e2e/*.spec.ts` | Browser E2E (nav, settings, search) — `npm run test:e2e` |

## Scripts

```bash
npm run dev       # dev server (Turbopack, binds 127.0.0.1)
npm run build     # production build
npm run start     # serve the build (binds 127.0.0.1)
npm test          # scripts/verify-all.ts — the full gate (isolated data dir)
npm run test:e2e  # Playwright browser E2E (needs `npx playwright install chromium` + a build)
```

`dev:lan` / `start:lan` bind the classified gateway on all interfaces but expose only scoped Companion/native-node routes. `dev:lan:studio` / `start:lan:studio` explicitly add the full Studio for private-network peers — see [SECURITY.md](../SECURITY.md) first.

`npm test` chains the `verify-*` scripts: theme + brand-asset + page-chrome checks, a full runtime drive of the shipped code (real agent run with tools), tool-dispatch guards, voice-VAD unit tests, shell-state, 40+ OAuth/API unit+HTTP tests, and feature structural checks. Results go to `functional-npm-test.log` in the suite's scratch dir — stdout stays quiet; exit code 0 means pass. The Playwright E2E suite is separate (`npm run test:e2e`) and not yet wired into CI.

## Brand assets (favicon, iOS icon, link previews)

Everything a browser, a phone, or a link crawler renders is drawn from `lib/brand.ts` and committed as a static file — nothing is generated at request time, because crawlers and iOS both fetch with short timeouts and Studio has to serve them offline.

```bash
npm run generate:brand   # re-render every icon + the share card from lib/brand.ts
npm run test:brand       # verify the committed files (also part of `npm test`)
```

| File | Emitted as | Notes |
| --- | --- | --- |
| `app/favicon.ico` | `<link rel="icon">` | Six PNG frames (16→256). **Frames must be RGBA** — Next's ICO decoder fails the whole page render on 24-bit RGB |
| `app/icon.svg` | `<link rel="icon" type="image/svg+xml">` | Crisp tab icon for modern browsers; byte-compared against `shibaMarkSvg()` by the verifier |
| `app/apple-icon.png` | `<link rel="apple-touch-icon" sizes="180x180">` | The iOS home-screen icon. Opaque and **full bleed** — iOS composites alpha onto black and applies its own squircle mask, so shipping our own rounding leaves black wedges |
| `app/manifest.ts` | `/manifest.webmanifest` | `minimal-ui`, not `standalone`: a home-screen launch stays in a browser context so OAuth redirects and downloads keep working. Companion keeps its own scoped manifest |
| `app/opengraph-image.png`, `app/twitter-image.png` | `og:image` / `twitter:image` | 1200×630 card, flat RGB so no client composites it onto white. `*.alt.txt` supplies the alt text |
| `public/icons/icon-{192,512}.png`, `icon-maskable-512.png` | manifest `icons` | The maskable variant pulls the art into the centre safe zone Android may crop to |

The `proxy.ts` matcher exempts these paths (`PUBLIC_BRAND_ROUTES` in `lib/brand.ts` mirrors the list). Without that, a phone adding Studio to its home screen — a LAN client — hits the companion redirect and gets HTML where the icon should be, and shared links unfurl blank.

Card text is rasterised with the generating machine's system fonts, so re-rendering on another OS can reflow it slightly; eyeball the card before committing.

## Contributor notes & sharp edges

- **CSS cascade convention:** `app/globals.css` keeps responsive/media overrides at the END of the file; later equal-specificity rules win. Add page styles before that section.
- **Turbopack CSS cache:** if new CSS classes verifiably on disk don't reach the browser even after restart, delete `.next` and restart the dev server.
- **Route remounts:** navigating between tabs remounts the shell (one catch-all route). Ephemeral state that must survive navigation rides the URL (e.g. `/automations?run=<id>`).
- **React compiler lint:** `set-state-in-effect` errors on synchronous setState inside effects — set state after an `await`, or flip flags in event handlers.
- **Structural tests grep source:** some verify scripts assert literal UI strings (e.g. "xAI Grok API Key"); renaming copy can fail the suite intentionally.
- **Test isolation:** `npm test` points every child script at a fresh `SHIBA_DATA_DIR` under the suite's scratch dir — it never touches `~/.shiba-studio`. Set `SHIBA_TEST_DATA_DIR` to reuse a persistent test store instead.
- **DB migrations:** `lib/db.ts` stamps `PRAGMA user_version`; schema changes bump `SCHEMA_VERSION` and add an entry to `MIGRATIONS` — never edit the baseline DDL.
- **Same-origin guard:** `proxy.ts` rejects cross-origin `/api/*` requests; if you add an endpoint the browser must call from another origin (don't), it needs an explicit exemption there.
- **Brand assets are not app routes:** the matcher exemptions in `proxy.ts` are for static artwork only. Keep them narrow — `verify-brand-assets.ts` asserts `/`, `/companion`, and `/api/*` are all still matched.
- **Tool-list aliasing:** `filterToolsByDisabled` must return a *fresh* array — callers reset the input in place (`tools.length = 0; push(...)`), so returning the same reference empties the result and the model gets no tools (`verify-tool-dispatch.ts` guards this).
- **Lint debt:** `lib/`, `app/api/`, `scripts/`, and `types/` are `no-explicit-any`-clean — keep them that way. Remaining debt is confined to `components/*.tsx` (the god component + panels); don't add new `any`s anywhere.

## Release roadmap

[TODO.md](../TODO.md) is the audited path to public release: security hardening (localhost binding, origin checks, approval defaults), LICENSE/branding, DB migrations, CI matrix, packaging, and docs.
