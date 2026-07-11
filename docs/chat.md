# Grok Chat

Grok Chat is a working surface, not just a conversation: it streams reasoning, renders rich markdown, accepts images and files, and can act on your repo, your vault, and the web through slash commands.

<img src="images/chat.png" alt="Grok Chat: session rail, streaming reasoning, slash-command composer, and the annotation sub-browser" width="880" />

## Sessions

- Chats live in the **collapsible session rail** on the left — searchable, archivable, and scalable to hundreds of sessions. Each session keeps its own model, chat target, reasoning effort, and full history.
- **Auto-titling:** after the first exchange, a low-end model (grok-code-fast-1) summarizes the conversation into a 3–6 word title.
- **New Chat** lives in the global top bar on every page.
- Full history is sent with every prompt, so context always carries across turns.

## Chat targets

The target select chooses *who* answers:

- **Grok (default)** — plain Grok with your global uploads as context.
- **A specific agent** — chats in that agent's voice with its Skill personality and live integration context (e.g. its whole Obsidian vault). Local agents keep their real toolbelt in chat — files, shell, and the browser — so *"open example.com and read the headline"* actually drives headless Chrome, appends a screenshot of the final page to the reply, and `/annotate` lets you watch or take over the same page.
- **All agents** — every agent answers in parallel; Grok synthesizes a unified reply with per-agent perspectives. (Text-only.)

## Models, reasoning, attachments

- The **composer model pill** switches between Cloud (xAI) and Local models per session; the terminal toggle routes through the **Grok CLI** instead of the API.
- For reasoning-capable models a **reasoning effort** pill appears (off/low/med/high). Non-reasoning models hide it and never send the parameter.
- **Images & files:** drop, paste, or attach. Images render inline in the conversation — click for a full-screen lightbox.
- The **QUOTA pill** in the top bar shows spend as a share of your monthly budget (Settings → Monthly Usage Quota).

## Grok Voice — hands-free with real barge-in

The ⚡ toggle in the composer starts hands-free voice mode: speak naturally, pause to send, and replies are spoken aloud in your chosen Grok voice (speed adjustable live on the HUD).

**Interrupting works like a real conversation — just start talking.** An echo-cancelled acoustic detector watches the microphone signal itself (not the transcript), so it hears *you* while the assistant is mid-sentence and pauses the speech within a fraction of a second. Two-stage so noise can't derail a reply: speech onset pauses the audio instantly, then the recognizer confirms actual words — real speech becomes your next message (and cuts the rest of the old reply), while a cough, a door, or silence resumes the reply exactly where it stopped.

## Slash commands

Type `/` for an autocomplete menu (↑↓ navigate, Tab/Enter complete, Esc dismiss). Commands run instantly and post their result into the chat:

| Command | What it does |
| --- | --- |
| `/git status` | Branch, changed files, and recent commits of the workspace |
| `/git checkout <branch>` | Switch to a branch, or create it from HEAD |
| `/git commit <message>` | Stage everything and commit |
| `/git pr <title> \| <body>` | Push the branch and open a GitHub pull request |
| `/annotate` | Open the annotation sub-browser (below) |
| `/workspace` | Open the folder picker — bind this chat to a repo/folder (below) |
| `/workspace <path>` | Bind directly to a path; `/workspace off` detaches |
| `/search <query>` | Web search (DuckDuckGo, keyless) — results with links |
| `/fetch <url>` | Read a page as clean text into the conversation |
| `/remember <key> \| <content>` | Save a fact that persists across every chat |
| `/recall [keyword]` | List saved memories |
| `/note <path> \| <content>` | Create an Obsidian note in your vault |
| `/x <text>` | Post to X through the configured integration (agents with the X scope can post too, via `x_post`) |
| `/help` | The full reference, in chat |

Git commands run against the chat's bound workspace folder when one is set, otherwise the linked project's workspace (or the default workspace); PRs use your GitHub token from Capabilities.

## Chat workspaces — give a conversation a folder

Bind a chat to any folder on disk — typically a cloned GitHub repo — and the conversation gains hands:

1. Click the **Workspace** button in the chat top bar (or type `/workspace`).
2. Browse to the folder (git repositories are badged and sorted first) or type its path, then **Use this folder**.
3. From then on, Grok in that chat has real filesystem tools — `fs_list`, `fs_read`, `fs_write`, `fs_search` — rooted in that folder, and `/git status|checkout|commit|pr` run against it.

Ask things like *"read src/api.ts and explain the auth flow"*, *"find every usage of the deprecated helper"*, or *"fix the typo in the README and commit it"* — the model explores, edits, and answers from the actual files rather than guessing. The binding persists with the session; the active folder shows in the top bar chip, and **Detach** (or `/workspace off`) removes access.

Workspace file access is granted per-chat and only to the folder you selected. Every tool call is recorded in the audit log.

## Background tasks — long work without blocking the chat

For jobs too big to finish inline — building a whole application, migrating a codebase, extensive multi-source research — ask the chat to run it in the background ("do this as a background task", or just give it a big job and it will offer). The model calls the `background_task` tool:

- The work runs as a normal agent run: it appears on **Automations** with a live execution trace, and the standard guardrails (concurrency limits, budget caps, token caps) apply.
- The chat answers immediately with a task id and stays fully responsive — keep chatting, or close the tab entirely.
- When the run finishes, the **result is posted back into the same chat session** with a link to the full trace. Ask "how's that task going?" anytime and the model checks with `background_status`.
- If the chat has a bound workspace, the background worker operates on that same folder; if you're chatting as an agent, that agent (with its integrations) does the work.

Write background requests as complete briefs — goal, constraints, what "done" looks like — because the worker can't ask follow-up questions mid-run.

## How your prompt and context are prioritized

Chats can carry a lot of injected context: project files and instructions, global uploads, an agent's integration data (Obsidian vault, GitHub repos…), and workspace listings. The chat is explicitly instructed that **your latest message is the task** — all injected material is wrapped in labeled background-context blocks the model treats as reference data only:

- Context is used only when it's clearly relevant to what you actually asked.
- Irrelevant context is ignored — the model won't summarize it unprompted or steer the conversation toward it.
- Nothing inside context blocks can override your request or act as instructions (a note in an uploaded file saying "ignore the user" is inert data).

So you can keep large projects and vaults attached without worrying that a question about one thing gets answered about another.

## The annotation sub-browser

The killer workflow for building web apps: refine code by *pointing at the page*.

1. Click the **crosshair button** in the composer (or type `/annotate`).
2. Enter your dev server's URL (e.g. `http://localhost:5173`).
3. **Interact mode** — the whole page is live in the frame: scroll it natively like any page, follow links, and press buttons to reach the screen you care about.
4. **Annotate mode** — click any element; it's selected DevTools-style and outlined orange in a fresh screenshot.
5. Add a note ("make this container a responsive 2-column grid") and **Send to chat** — the composer receives the element's selector, size, and HTML excerpt, plus the highlighted screenshot as an image attachment.
6. Send. Grok sees exactly what you selected and refines the code.

Because it drives a real headless Chrome (puppeteer), it works with any URL — cross-origin dev servers included.

## Export & housekeeping

- **Export** downloads the conversation as Markdown (roles, models, reasoning, token counts included).
- **Clear chat** wipes the session history; workspace and project uploads stay in context.
- Assistant messages have hover actions: copy, and regenerate for the newest reply. Your own messages support edit-and-resend.
