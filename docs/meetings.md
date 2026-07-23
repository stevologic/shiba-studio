# Meetings (Beta)

Meetings turns an agent into a colleague you sit down with. Instead of typing prompts, you hold a spoken project review: the agent leads — presenting what it has been building — while you steer with your voice. The agent puts real material on a visual stage as it talks, and the meeting ends in minutes with a todo list you can send to the Board in one click.

Think of it as a director meeting a senior engineer about the project they're delivering.

> **Beta.** The flow is functional end to end; expect rough edges around voice capture on non-Chromium browsers and long meetings.

## Starting a meeting

From the **Meetings** tab:

- **With** — the agent you're meeting. Its chat Skill personality, description, and default TTS voice carry into the room.
- **About project** — a Studio project, or *Whole workspace* to review the agent's workspace directly.
- **Focus** (optional) — what you want the session to concentrate on (e.g. *"review the auth flow before launch"*).

While the room is prepared, the agent builds a **meeting brief** on the server: project instructions and files, a Board snapshot (open and recently done cards), a bounded workspace file tree, and recent git commits. The agent then opens the meeting the way an engineer opens a delivery review — what shipped, what's in flight, what it wants feedback on.

## The room

The room has two surfaces:

- **The stage** (left) — whatever the agent is currently presenting. Earlier visuals stay one click away in the history strip below, and in the transcript.
- **The conversation rail** (right) — live transcript, suggestion chips, and the composer.

### Talking

- **Mic on** → speak naturally; pause to send (Web Speech API — Chrome/Edge). The mic pauses while the agent replies and resumes after.
- **Voice on/off** → agent replies are spoken with its Grok TTS voice (`/api/tts`), or muted for text-only reviews.
- **Stop voice** → while a reply is being read aloud, a stop control appears next to it in the transcript; stopping the audio never interrupts the meeting itself.
- Typing always works; both inputs land in the same conversation.

### Annotating visuals

**Annotate** on the stage turns on a sketch layer: draw directly over whatever is being presented to point things out while you talk. Marks are per-visual (revisit them from the history strip — annotated visuals carry a ✎), **Clear** wipes the current visual, and **Share markup** sends a note about your marks into the conversation so the agent addresses them. The sketch layer is session-local scratch space — the note is what lands in the transcript and minutes.

### What the agent can show

Every agent turn may put one visual on the stage:

| Visual | What it is |
|---|---|
| **Code** | An excerpt the server reads from the *real* workspace file (path + line range). The model cannot fabricate code — if the file doesn't resolve, nothing is shown. |
| **Diagram** | An architecture/flow diagram (nodes + edges) rendered as SVG, with emphasis on the parts under discussion. |
| **Markdown** | Notes, status tables, comparisons, checklists. |
| **Screenshot** | A live capture of a *running* app URL, taken server-side with the studio's headless browser. |

Everything shown **stays in the conversation**: recent visuals keep their full content (the code text, diagram structure, notes) in the agent's context, and each of your turns tells the server which visual is on your stage — so *"now explain this"* right after a snippet appears just works, even if you flipped back to an earlier visual first. The visual history strip lists newest first.

Markdown visuals also render **rich cards**: a fenced ` ```shiba-card ` block holding one JSON object becomes a live card — `stats` (KPI tiles with deltas), `progress` (bars), `checklist` (work states), `timeline` (milestones), or `callout` (highlighted note). The same fence works in Grok chat replies and any other agent markdown; a malformed payload just renders as code, never losing content.

### Steering

Each agent turn includes 2–4 **suggestion chips** — AI-assisted directions phrased as things you might say (*"Show me the riskiest code path"*). Click one to send it, or ignore them and drive the meeting yourself. If you stay quiet, the agent keeps leading.

## Minutes and the Board

**End meeting** asks the agent to write faithful minutes from the transcript. The meeting is also retitled from its content — `<Project>: <what the meeting covered>` — so the lobby reads like a history, not a list of dates. The minutes hold:

- **Summary** — what was reviewed and discussed.
- **Direction** — the agreed path forward.
- **Decisions** — only explicit decisions from the conversation.
- **Todos** — only what you requested or both of you agreed on, each with context for whoever picks it up.

Select todos and **Add to project board** — after an explicit confirmation, each becomes a Board card in **Todo**, labelled `meeting`, linked to the meeting in its description, and attached to the meeting's project. Conversion is idempotent: a todo can only ever create one card, and converted todos show their card key in the minutes.

Past meetings (and their minutes) stay in the lobby until you delete them. Deleting a meeting never deletes Board cards it created.

## Safety and storage

- **No audio is stored.** Speech is transcribed in the browser (Web Speech API) and only text reaches the server. This is different from the audio-upload transcription pipeline, which has its own consent and retention flow.
- Meetings live in the local SQLite store (`live_meetings` table) like every other Studio record.
- Board cards and any other durable outputs require an explicit confirmation click — ending a meeting alone never mutates the Board.
- Turns are model calls metered under Usage (source `live-meeting`).

## Voice integration scope

For how Live Meetings should reuse `/api/tts` and relate to Companion voice routes (and what must stay separate), see [Live Meetings voice integration scope (SHIB-45)](./research/live-meetings-voice-integration-scope.md).
