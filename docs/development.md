# Development

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · Tailwind 4 · Node ≥ 22.5 with built-in `node:sqlite` · puppeteer for browser control · node-cron for schedules. No native modules anywhere — the repo builds identically on Windows, macOS, and Linux.

## Repo layout

| Path | What lives there |
| --- | --- |
| `app/[[...section]]/page.tsx` | Single catch-all route rendering the whole shell — every tab is a URL segment |
| `app/api/*` | ~30 API routes: agents, runs, chat sessions/streaming, git, obsidian, sub-browser, tools, sync, usage, logs, … |
| `components/grok-desk.tsx` | The shell: nav, top bar, dashboard/agents/automations/capabilities/settings tabs, modals |
| `components/grok-chat-panel.tsx` | Chat: streaming, slash commands + autocomplete, attachments, annotation hand-off |
| `components/sub-browser.tsx` | The annotation sub-browser modal |
| `lib/agent-runtime.ts` | The heart: tool definitions + the Grok tool-calling run loop |
| `lib/agent-tool-exec.ts` | Tool execution (files, shell, browser, integrations, MCP, power tools) |
| `lib/agent-power-tools.ts` | Web search/fetch, workspace grep, persistent memory, image generation |
| `lib/git-actions.ts`, `lib/browser.ts`, `lib/grok-cli.ts` | Git ops, puppeteer control, CLI detection/execution |
| `lib/db.ts`, `lib/agent-runs-store.ts`, `lib/audit-log.ts` | SQLite schema, run persistence, audit trail |
| `lib/scheduler.ts` + `instrumentation.ts` | Cron scheduling, armed at server start |
| `lib/secure-store.ts`, `lib/persistence.ts` | AES-256-GCM sealing and config/agent stores |
| `scripts/verify-*.ts` | The functional verification suite |

## Scripts

```bash
npm run dev      # dev server (Turbopack)
npm run build    # production build
npm run start    # serve the build
npm test         # scripts/verify-all.ts — the full gate
```

`npm test` chains theme checks, a full runtime drive of the shipped code (real agent run with tools), 40 OAuth/API unit+HTTP tests, and feature structural checks. Results go to `functional-npm-test.log` in the suite's scratch dir — stdout stays quiet; exit code 0 means pass.

## Contributor notes & sharp edges

- **CSS cascade convention:** `app/globals.css` keeps responsive/media overrides at the END of the file; later equal-specificity rules win. Add page styles before that section.
- **Turbopack CSS cache:** if new CSS classes verifiably on disk don't reach the browser even after restart, delete `.next` and restart the dev server.
- **Route remounts:** navigating between tabs remounts the shell (one catch-all route). Ephemeral state that must survive navigation rides the URL (e.g. `/automations?run=<id>`).
- **React compiler lint:** `set-state-in-effect` errors on synchronous setState inside effects — set state after an `await`, or flip flags in event handlers.
- **Structural tests grep source:** some verify scripts assert literal UI strings (e.g. "xAI Grok API Key"); renaming copy can fail the suite intentionally.
- **Test isolation caveat:** the verify suite currently mutates the live data dir (creates/deletes fixture agents/projects) — entity counts change after `npm test`.
- The pre-existing `no-explicit-any` lint debt is being paid down; don't add new `any`s.

## Release roadmap

[TODO.md](../TODO.md) is the audited path to public release: security hardening (localhost binding, origin checks, approval defaults), LICENSE/branding, DB migrations, CI matrix, packaging, and docs.
