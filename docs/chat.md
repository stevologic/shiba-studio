# Grok Chat

Grok Chat is a working surface, not just a conversation: it streams reasoning, renders rich markdown, accepts images and files, and can act on your repo, your vault, and the web through slash commands.

## Sessions

- Chats live in the **collapsible session rail** on the left — searchable, archivable, and scalable to hundreds of sessions. Each session keeps its own model, chat target, reasoning effort, and full history.
- **Auto-titling:** after the first exchange, a low-end model (grok-code-fast-1) summarizes the conversation into a 3–6 word title.
- **New Chat** lives in the global top bar on every page.
- Full history is sent with every prompt, so context always carries across turns.

## Chat targets

The target select chooses *who* answers:

- **Grok (default)** — plain Grok with your global uploads as context.
- **A specific agent** — chats in that agent's voice with its Skill personality and live integration context (e.g. its whole Obsidian vault).
- **All agents** — every agent answers in parallel; Grok synthesizes a unified reply with per-agent perspectives. (Text-only.)

## Models, reasoning, attachments

- The **composer model pill** switches between Cloud (xAI) and Local models per session; the terminal toggle routes through the **Grok CLI** instead of the API.
- For reasoning-capable models a **reasoning effort** pill appears (off/low/med/high). Non-reasoning models hide it and never send the parameter.
- **Images & files:** drop, paste, or attach. Images render inline in the conversation — click for a full-screen lightbox.
- The **QUOTA pill** in the top bar shows spend as a share of your monthly budget (Settings → Monthly Usage Quota).

## Slash commands

Type `/` for an autocomplete menu (↑↓ navigate, Tab/Enter complete, Esc dismiss). Commands run instantly and post their result into the chat:

| Command | What it does |
| --- | --- |
| `/git status` | Branch, changed files, and recent commits of the workspace |
| `/git checkout <branch>` | Switch to a branch, or create it from HEAD |
| `/git commit <message>` | Stage everything and commit |
| `/git pr <title> \| <body>` | Push the branch and open a GitHub pull request |
| `/annotate` | Open the annotation sub-browser (below) |
| `/search <query>` | Web search (DuckDuckGo, keyless) — results with links |
| `/fetch <url>` | Read a page as clean text into the conversation |
| `/remember <key> \| <content>` | Save a fact that persists across every chat |
| `/recall [keyword]` | List saved memories |
| `/note <path> \| <content>` | Create an Obsidian note in your vault |
| `/x <text>` | Post to X through the configured integration (agents with the X scope can post too, via `x_post`) |
| `/help` | The full reference, in chat |

Git commands run against the linked project's workspace (or the default workspace); PRs use your GitHub token from Capabilities.

## The annotation sub-browser

The killer workflow for building web apps: refine code by *pointing at the page*.

1. Click the **crosshair button** in the composer (or type `/annotate`).
2. Enter your dev server's URL (e.g. `http://localhost:5173`).
3. **Interact mode** — clicks pass through to the real page: follow links, press buttons, navigate to the screen you care about.
4. **Annotate mode** — click any element; it's selected DevTools-style and outlined orange in a fresh screenshot.
5. Add a note ("make this container a responsive 2-column grid") and **Send to chat** — the composer receives the element's selector, size, and HTML excerpt, plus the highlighted screenshot as an image attachment.
6. Send. Grok sees exactly what you selected and refines the code.

Because it drives a real headless Chrome (puppeteer), it works with any URL — cross-origin dev servers included.

## Export & housekeeping

- **Export** downloads the conversation as Markdown (roles, models, reasoning, token counts included).
- **Clear chat** wipes the session history; workspace and project uploads stay in context.
- Assistant messages have hover actions: copy, and regenerate for the newest reply. Your own messages support edit-and-resend.
