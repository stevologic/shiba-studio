# GrokDesk — Critical Engineering Review (2026-07-06)

Reviewer stance: principal engineer, frontier-lab quality bar. The review assesses
what GrokDesk *is*, what will hurt at scale or under stress, and what to enhance
without changing the tool's core architecture.

## What GrokDesk gets right

- **Real streaming architecture.** SSE end-to-end (xAI responses/completions →
  server mapping → client consumer) with reasoning deltas, usage propagation,
  abort handling, and a transient-network retry before first byte. This is the
  hard part and it is genuinely solid.
- **Credentials are engineered, not stored.** AES-256-GCM at rest, machine key
  outside the repo, transparent migration of legacy plaintext. Most desktop-class
  AI tools ship plaintext JSON; this one does not.
- **Provider honesty.** Cloud/local/CLI model catalogs are all discovered
  dynamically from their sources (xAI API, local `/v1/models`, `grok models`),
  scoped per route, and user-filterable. No hardcoded model lists pretending to
  be live.
- **Performance discipline.** First-load JS was measured (not guessed) and cut
  40% via code-splitting; the markdown/highlight pipeline and every tab panel are
  lazy. framer-motion was evicted from the critical path.
- **A verification culture.** `npm test` drives the built app with puppeteer,
  exercises the OAuth stack (40 assertions), and the runtime. Rare for a project
  of this age.

## Critical findings

### C1 — The god component (accepted debt, must not grow)
`components/grok-desk.tsx` is ~2,800 lines holding nav, settings, agents,
automations, workspace, and all shared state, with pervasive `any` (76 legacy
lint errors). Every feature lands here first. It works because tabs were
code-split at the render layer, but state is not isolated: a bug in settings
state can re-render the world. **Recommendation:** freeze this file's growth;
new features get their own component + state. A full store refactor (zustand or
context slices) is deliberately out of scope — it would change the core.

### C2 — One render error kills the whole app
There is no React error boundary. Any uncaught render/lazy-chunk error
white-screens every tab, losing in-flight chat state. **Implemented:** an
app-level error boundary with a branded recovery screen (error detail + reload,
try-again) so a single panel crash cannot take down the shell.

### C3 — Modals close by backdrop but not keyboard
Escape closes the confirm dialog only. Agent/run/sync/folder modals require
mouse interaction — an accessibility and power-user gap. **Implemented:** global
Escape handling that closes the topmost open surface (agent modal, run modal,
sync modal, folder browser, mobile drawer).

### C4 — Conversations are trapped in the app
No export. Users invest in long reasoning-heavy threads with zero portability —
table stakes in Claude/ChatGPT. **Implemented:** one-click "Export chat" that
downloads the transcript as Markdown, preserving roles, models, collapsible
reasoning, and token counts.

### C5 — Streaming UX loses the reader
Smart stick-to-bottom exists, but once a user scrolls up during a long stream
there is no way back except manual scrolling; new tokens arrive invisibly.
**Implemented:** a floating "Jump to latest" affordance that appears when
scrolled away from the tail and during off-screen streaming.

### C6 — Drafts evaporate
Composer text is lost on tab switch, session switch, or reload. For an agent
studio where prompts are long, this is real data loss. **Implemented:**
per-session draft persistence (localStorage), restored on mount, cleared on
send.

### C7 — The browser tab says nothing
`document.title` is static; ten GrokDesk tabs are indistinguishable and history
is useless. **Implemented:** dynamic titles per section ("Chat — GrokDesk",
"Agents — GrokDesk", …).

### C8 — No version identity
Nothing in the UI states what build is running — support and bug reports start
blind. **Implemented:** app version (from package.json) surfaced in the footer.

## Noted but deliberately not implemented (would alter the core)

- **N1 — Schema validation at API boundaries.** Routes trust request bodies
  (`body.model`, `body.agent`) with manual coercion. zod at every route is the
  right end state; retrofitting all ~30 routes is a core-surface change and a
  regression risk not taken here.
- **N2 — Scheduler lifecycle.** Cron scheduling arms via `/api/boot` (i.e., when
  the UI loads). A headless deployment never schedules. Correct fix is a
  standalone runner process — an architectural addition, noted for the roadmap.
- **N3 — Message virtualization.** Very long chats render every bubble; at
  thousands of messages the DOM will drag. Windowing (virtua/react-virtuoso)
  should ship before any "infinite history" feature.
- **N4 — Store-wide writes.** Chat/agent stores rewrite whole JSON files per
  mutation. Fine for localhost scale; move to SQLite before multi-agent
  concurrency grows further.
- **N5 — `any` erosion.** Legacy `any` usage should be burned down
  opportunistically per-file, not in one heroic pass.

## Verdict

GrokDesk is past the prototype line: streaming, security, and perf work are done
to a professional standard. Its risks are concentration risks — one giant
component, one process, one JSON store — not correctness ones. The enhancements
above (C2–C8) harden daily use without touching that core; N1–N5 define the next
architectural season.
