# SHIB-45 — Live Meetings voice integration scope

**Card:** SHIB-45 · Scope voice integration using TTS and companion routes  
**Requested in:** ShibaStudio: Live meetings feature enhancement planning (2026-07-23)  
**Role:** Analyst scope (no product code change required by this card)  
**Status:** Complete inventory + recommended work packages  
**Primary surfaces reviewed:** `/api/tts`, `/api/companion/*` (esp. `voice`), `/api/live-meetings/*`, `/api/meetings/*`, Meetings room UI, Companion PWA voice UI, Grok Chat voice mode

---

## 1. Executive summary

Shiba already has **three separate voice stacks**. Live Meetings only uses a **thin subset** of the Studio TTS path and **none** of the Companion voice path. That is correct for the current privacy model (browser STT → text only; no meeting audio retained), but it leaves clear enhancement room:

| Stack | Role today | Fit for Live Meetings enhancement |
| --- | --- | --- |
| **Studio TTS** (`GET/POST /api/tts`, `lib/xai-tts.ts`) | Speak agent text as MP3 (chat + meetings) | **Reuse directly.** Raise Meetings to chat-grade progressive TTS + speed + barge-in. |
| **Companion voice** (`POST /api/companion/voice` + `/api/meetings` storage) | Consent-gated remote **recording → STT → durable task** | **Do not overload for conversational turns.** Reuse patterns (consent, digest, scopes, idempotency) and optionally seed/focus a Live Meeting from a voice note. |
| **Live Meetings conversational I/O** (`/api/live-meetings/*` + Web Speech API) | Turn-based spoken project review | **Primary product surface** to upgrade; keep text as the server contract. |

**Recommendation:** Treat voice integration as **two product tracks** that share helpers, not one merged pipeline.

1. **Track A — Local room voice quality** (reuse `/api/tts` + `lib/voice-vad.ts` + utterance helpers).  
2. **Track B — Remote companion adjacency** (scoped companion actions around Live Meetings; keep `companion/voice` as async task capture).

Do **not** expose localhost-only Live Meeting or TTS routes on LAN without a new companion-authenticated contract. Do **not** store Live Meeting microphone audio by default.

---

## 2. Inventory of existing routes and code

### 2.1 Studio TTS — `/api/tts`

| Method | Contract | Notes |
| --- | --- | --- |
| `GET /api/tts` | Lists voices (`source: xai \| fallback`) | Fallback catalog in `lib/xai-tts.ts` (`eve`, `ara`, `leo`, `rex`, `sal`, `carina`). |
| `POST /api/tts` | Body: `text`, `voice_id`/`voiceId`, `speed`/`speech_speed`, `language`, `fast`, `preprocessed`, `text_normalization`, `optimize_streaming_latency` | Returns `audio/mpeg`. Requires cloud bearer. `fast=true` → 22.05 kHz / 64 kbps + streaming latency hint. |

**Shared helpers (`lib/xai-tts.ts`):**

- `textForSpeech` / `stripEmojisForSpeech` — markdown/emoji cleanup  
- `takeNextUtterance` / `splitSpeechChunks` — progressive chunking (used by chat, **not** meetings)  
- Speed clamp `0.7–1.5`

**Config:** `defaultTtsVoice`, `defaultTtsSpeed` in settings; per-agent `voiceId`.

**Security / network:**

- Bound to the Studio host surface (not in the companion LAN allowlist in `proxy.ts`).
- Auth is the host's xAI credentials, not a device key.

### 2.2 Companion routes (remote PWA)

| Route | Purpose | Voice-relevant? |
| --- | --- | --- |
| `GET/POST /api/companion/admin` | Localhost-only enable/pair/revoke | Scopes include `action:voice` |
| `POST /api/companion/pair` | One-time code → device key | Can grant `action:voice` |
| `GET /api/companion/status` | Public enabled/pairing status | No task/audio data |
| `GET /api/companion/data` | Redacted tasks/attention/routines + **sanitized voice-request status** when scoped | Status only; no transcript/audio |
| `POST /api/companion/actions` | Idempotent approve/deny/steer/cancel/routine | No live-meeting kinds today |
| `POST /api/companion/voice` | Consent + SHA-256 stream → local meeting storage → xAI STT → durable task | **Async voice capture**, not conversation |

**Companion voice contract (hard constraints already shipped):**

- Header `x-recording-consent: true` required  
- `x-audio-bytes`, `x-audio-sha256` integrity check  
- MIME allowlist; **50 MB** max (`MAX_MEETING_AUDIO_BYTES`)  
- Retention fixed at **1 day** for remote uploads  
- Scope `action:voice`  
- Idempotency via `x-idempotency-key` + receipt table  
- PWA never receives raw audio/transcript; only title/phase/taskId/error  
- Restart-safe via `reconcileInterruptedCompanionVoiceActions()`

**LAN boundary (`proxy.ts`):** non-loopback peers may hit only `/api/companion/*` and `/api/native-nodes/*` (with further admin restrictions). **`/api/tts` and `/api/live-meetings/*` are blocked on LAN.**

### 2.3 Meeting audio storage (Companion substrate) — `/api/meetings/*`

Documented in `docs/api.md` as the storage/transcription layer for Companion voice (and local consent recordings). Distinct from Live Meetings:

- Streams audio to disk under retention  
- Diarized STT via xAI  
- Durable transcript citations after audio deletion  
- Board/Automation outputs only after exact confirmation  

`POST /api/companion/voice` is a thin remote facade over this stack.

### 2.4 Live Meetings (spoken project review) — `/api/live-meetings/*`

| Route | Role |
| --- | --- |
| `GET/POST /api/live-meetings` | List / create (builds brief, agent opening turn) |
| `GET/DELETE /api/live-meetings/:id` | Read / soft-delete |
| `POST /api/live-meetings/:id/turn` | Creator text (or null) → agent `say` + optional visual + suggestions |
| `POST /api/live-meetings/:id/end` | Minutes (summary/direction/decisions/todos) |
| `POST /api/live-meetings/:id/board` | Explicit todo → Board conversion |

**Server contract is text-only.** Agent turns are model JSON with a spoken `say` field (`MAX_SAY_CHARS = 4000`). No audio columns on `live_meetings`.

**Client voice (`components/meetings-panel.tsx`):**

| Direction | Mechanism | Storage |
| --- | --- | --- |
| Creator → agent | Web Speech API (Chrome/Edge) | Text only; no audio retained |
| Agent → creator | One full-turn `POST /api/tts` with `fast: true` and agent `voiceId` | Ephemeral blob URL |

**Already present:** voice on/off, stop-voice while speaking, mic pause during thinking/speaking, opening-turn speak-on-enter.

**Gaps vs Grok Chat voice mode:**

| Capability | Chat | Live Meetings |
| --- | --- | --- |
| Progressive / chunked TTS | Yes (`takeNextUtterance`) | No — waits for full model turn, one synthesis |
| Acoustic barge-in (`lib/voice-vad.ts`) | Yes | No |
| Soft resume after false barge-in | Yes | N/A |
| Studio default TTS speed | Yes | No (speed omitted from `/api/tts` body) |
| Repeat last reply | Yes | No |
| Non-Chromium mic path | Same limitation | Same (Web Speech) |
| Companion / LAN participation | N/A | No |

`docs/meetings.md` correctly documents the beta privacy model: **no Live Meeting audio is stored.**

### 2.5 Related voice surfaces (out of primary scope, for contrast)

- **Grok Chat voice mode** — gold standard for conversational TTS + barge-in.  
- **Voice group chat** (`/api/grok/voice-group-turn`, `lib/voice-group-chat.ts`) — multi-agent short spoken turns; also uses `textForSpeech`.  
- **Native companion nodes** — desktop GUI automation, not speech.

---

## 3. Integration map (as-is)

```text
[Studio host browser]
  Meetings room ──Web Speech (text)──► POST /api/live-meetings/:id/turn
  Meetings room ◄── agent.say text ──┘
  Meetings room ──POST /api/tts (full say, fast)──► xAI TTS ──► <audio>

[Companion PWA / LAN]
  Voice request UI ──POST /api/companion/voice (audio stream)──► saveMeetingAudio
       ──transcribeMeetingNow──► createTask + dispatch
  Companion data ◄── sanitized voice receipt status only

[Blocked on LAN]
  /api/tts
  /api/live-meetings/*
  generic Studio APIs
```

There is **no current edge** from Companion voice into Live Meetings, and **no edge** from Live Meetings into Companion status.

---

## 4. Goals for “voice integration” (product intent)

From the Live Meetings enhancement planning context, voice integration should mean:

1. **Higher-quality spoken room** on the host (latency, interruptibility, settings parity) without changing the text-first server model.  
2. **Clear reuse of existing TTS infrastructure** rather than a second synthesis path.  
3. **Optional remote adjacency** via Companion that respects the existing security model (scoped device keys, no workspace/file leakage, no raw transcript on the phone for voice receipts today).  
4. **Explicit non-goals** so implementers do not collapse the two meeting systems.

### In scope (recommended)

- Track A: Live Meetings TTS/VAD parity with chat, still via `/api/tts`.  
- Track B: Design (and later implement) companion-scoped **Live Meeting control** actions that stay text-based.  
- Track C: Optional “start Live Meeting focus from a Companion voice note” using existing STT task/transcript citation — not real-time duplex.  
- Docs: document `/api/live-meetings` in `docs/api.md`; keep the dual “meetings vs live meetings” distinction sharp.

### Explicitly out of scope (for this initiative)

- Real-time duplex WebRTC meeting audio.  
- Storing Live Meeting microphone audio by default.  
- Exposing unscoped `/api/tts` or `/api/live-meetings` to LAN.  
- Using Companion `action:voice` upload path as the Live Meeting turn transport (50 MB, 1-day retention, task dispatch — wrong latency and product shape).  
- Merging `live_meetings` and `meetings` tables.  
- System-audio capture for Live Meetings (see `IDEAS.md` §13 as a separate product).  
- Non-xAI TTS providers.

---

## 5. Recommended work packages (implementation-ready)

Packages are ordered for safe delivery. Each can become its own Board card.

### WP-A1 — Meetings TTS settings parity (S)

**Problem:** Room always posts `{ text, voice_id, fast: true }`; ignores Studio `defaultTtsSpeed` and does not pre-clean with shared helpers consistently.

**Change:**

- Resolve effective voice: agent `voiceId` → config `defaultTtsVoice` → `eve`.  
- Pass `speed: clampTtsSpeed(config.defaultTtsSpeed)`.  
- Optionally send `preprocessed: true` after client-side `textForSpeech` (matches chat progressive path).  

**Files:** `components/meetings-panel.tsx`; possibly small shared client helper if chat already duplicates this.

**Acceptance:**

- Changing Default Grok voice & speed in Settings affects new spoken Meeting turns.  
- Agent-specific `voiceId` still wins.  
- `verify-live-meetings` remains green; no API schema change.

### WP-A2 — Progressive spoken replies (M)

**Problem:** User waits for the full model turn **and** a single large TTS request before hearing anything.

**Change:**

- After `turn` returns, split `reply.text` with `splitSpeechChunks` / `takeNextUtterance`.  
- Queue sequential `/api/tts` calls with `fast: true` (same pattern as chat).  
- Keep stop-voice canceling the whole queue.  

**Acceptance:**

- First audio starts on first complete sentence/clause, not only after full synthesis of a long `say`.  
- Stop voice still ends playback without ending the meeting.  
- Empty/emoji-only chunks never call TTS.

**Risk:** More TTS requests → slightly higher cost; mitigate with existing max chunk sizes (~220–280 chars).

### WP-A3 — Acoustic barge-in in the room (M)

**Problem:** Creator cannot interrupt mid-speech by talking; must click Stop voice or wait.

**Change:**

- Reuse `startVoiceVad` / `createVadDetector` from `lib/voice-vad.ts`.  
- Soft pause on energy onset → hard cancel when Web Speech confirms words → send as next turn (mirror chat).  
- Do **not** barge-in during `thinking` until product decides whether mid-generation cancel is supported (today turn is atomic server-side).

**Acceptance:**

- Talking over the agent stops TTS within ~250–400 ms when AEC is available.  
- Cough/noise resumes speech (soft barge-in).  
- Existing `verify-voice-vad` still covers detector; add a structural check that meetings-panel imports VAD (optional `verify-backlog-features` assertion).

**Constraint:** Barge-in cannot cancel an in-flight `/api/live-meetings/:id/turn` without a new server cancel path — scope barge-in to **playback only** unless a follow-on card adds turn cancellation.

### WP-A4 — Mic resilience / UX polish (S)

- Surface a clearer non-Chromium fallback message (already toasts; align copy with docs).  
- Optional: manual “push to talk” hold mode for noisy rooms.  
- Optional: repeat-last-agent-turn control (client-only re-TTS of last agent `say`).

### WP-B1 — Companion Live Meeting **read** projection (M) — design then build

**Problem:** Remote users can approve tasks / send voice notes, but cannot see that a Live Meeting is active.

**Design constraints:**

- New scope, e.g. `read:live-meetings` (do not overload `action:voice`).  
- Projection must be redacted like other companion data: title, agent name, status, last turn **preview** (short, sanitized), not full brief/workspace paths/code visuals.  
- Serve only via `GET /api/companion/data` extension or a dedicated `GET /api/companion/live-meetings` behind the same auth.

**Out of this WP:** remote stage screenshots/code (workspace leakage risk).

### WP-B2 — Companion Live Meeting **steer** actions (M)

**Problem:** Phone user cannot contribute text turns to an active room.

**Proposal:**

- New companion action kind, e.g. `live_meeting_turn`, under scope `action:live-meeting` (or `action:steer` if deliberately shared — prefer a dedicated scope).  
- Body: `{ meetingId, text, revision/version, idempotencyKey }`.  
- Server calls the same `runLiveMeetingTurn` used by the Studio room.  
- Host room already polls/applies meeting updates after turns; ensure live event or poll path refreshes companion-originated turns.

**Do not:** accept audio on this action; keep text only.

### WP-B3 — Companion-spoken agent replies (L — optional / later)

Two options; pick one in implementation design:

| Option | How | Pros | Cons |
| --- | --- | --- | --- |
| **B3a Client-side** | Companion calls a new `POST /api/companion/tts` that reuses xAI TTS under device auth + narrow scope | Phone hears agent | New LAN-safe TTS facade required; cost/abuse controls needed |
| **B3b Host-only** | Phone shows text; only Studio host speaks | No new audio API | Weaker remote meeting UX |

**Recommendation:** defer B3 until B1/B2 prove value. If built, **never** open raw `/api/tts` on LAN; always wrap with companion auth, rate limits, and text length caps (`textForSpeech` max).

### WP-C1 — Voice note → Live Meeting seed (S/M)

**Problem:** Companion voice today always becomes a durable **task**. Operators sometimes want a spoken brief that starts a project review instead.

**Proposal:**

- After companion voice transcription (existing path), optional metadata flag or post-step: “Use as Live Meeting focus”.  
- Creates/links a Live Meeting with `focus` = transcript summary (truncated), `projectId` chosen on host or encoded in title convention.  
- Keeps audio retention rules of the meetings store unchanged.  
- Live Meeting still runs text/Web-Speech on host; companion voice is only the **seed**, not the turn pipe.

**Acceptance:**

- Default remains task dispatch (no behavior change without explicit opt-in).  
- Transcript citation remains available via existing meeting citation URL.  
- No audio bytes enter `live_meetings`.

---

## 6. Security & privacy checklist (must hold for all WPs)

| Rule | Rationale |
| --- | --- |
| Live Meetings remain text-at-rest | Documented product promise; differs from Companion recording |
| Companion voice keeps consent + digest + 50 MB + 1-day retention | Legal/safety posture already audited in configuration docs |
| LAN never gains unscoped Studio APIs | `proxy.ts` companion boundary |
| Companion projections stay redacted | No workspace roots, code bodies, integration secrets |
| TTS always uses host cloud credentials | Device keys must not become xAI keys |
| Idempotency on all companion mutations | Existing receipt model |
| Board mutations still require explicit confirmation | Minutes → Board already gated |

---

## 7. API / docs gaps discovered during scoping

1. **`docs/api.md` omits `/api/live-meetings/*`** while `docs/meetings.md` documents the product. Implementers should add a Live Meetings section when WP-A or WP-B lands.  
2. **Naming collision:** “Meetings” in API docs refers to **audio storage** (`/api/meetings`), while the UI “Meetings” tab is **Live Meetings**. Scope language should always say **Live Meeting** vs **meeting recording**.  
3. **Architecture diagram** (`docs/architecture.md`) does not yet show Meetings / Companion voice; optional follow-up.

---

## 8. Suggested Board breakdown (after this scope card)

| Suggested card | Depends on | Size |
| --- | --- | --- |
| SHIB-?? Meetings TTS settings parity (WP-A1) | — | S |
| SHIB-?? Progressive Live Meeting TTS (WP-A2) | A1 helpful | M |
| SHIB-?? Live Meeting barge-in via voice-vad (WP-A3) | A2 helpful | M |
| SHIB-?? Document live-meetings in api.md | — | S |
| SHIB-?? Companion live-meeting read scope + projection (WP-B1) | design review | M |
| SHIB-?? Companion live-meeting text turn action (WP-B2) | B1 | M |
| SHIB-?? Optional voice-note → meeting focus seed (WP-C1) | — | S/M |
| SHIB-?? Companion TTS facade (WP-B3) | B2 + abuse review | L |

**Suggested first ship slice:** **A1 + A2 + api.md note**. Highest user-visible quality for the existing Meetings tab with zero security-boundary expansion.

---

## 9. Validation performed for this scope card

| Check | Result |
| --- | --- |
| Read `app/api/tts/route.ts`, `lib/xai-tts.ts` | TTS GET/POST, fast mode, helpers confirmed |
| Read `app/api/companion/voice/route.ts`, `components/companion-voice-request.tsx` | Consent/digest/task dispatch confirmed |
| Read `lib/live-meeting-types.ts`, `lib/live-meetings.ts`, `app/api/live-meetings/**` | Text-only server model confirmed |
| Read `components/meetings-panel.tsx` speak/mic path | Single-shot TTS, Web Speech input, stop-voice present |
| Read `lib/voice-vad.ts`, `docs/chat.md` barge-in | Chat-grade VAD available for reuse |
| Read `proxy.ts` LAN companion boundary | TTS + live-meetings blocked on LAN |
| Read `docs/meetings.md`, `docs/api.md`, `docs/configuration.md` | Dual meeting systems + companion voice docs confirmed |
| `scripts/verify-live-meetings.ts` / `verify-voice-vad` presence | Covered by `scripts/verify-all.ts` |

No production code was modified for SHIB-45 (analysis-only).

---

## 10. Decision record (for implementers)

| Decision | Choice |
| --- | --- |
| Primary TTS path for Live Meetings | Keep **`POST /api/tts`** only |
| Progressive speech | Client-side chunking with existing helpers |
| Barge-in | Reuse **`lib/voice-vad.ts`**; playback-only cancel first |
| Companion conversational audio | **Out** of first slices |
| Companion remote participation | New scopes + text actions; not `action:voice` overload |
| Companion voice upload | Remains async task capture; optional seed only |
| Audio retention for Live Meetings | **None** by default |

---

## 11. Residual risks / open questions

1. **Should companion-originated turns interrupt an in-progress host turn?** Today `runLiveMeetingTurn` 409s when already responding — remote clients need clear UX.  
2. **Usage metering:** progressive TTS increases request count; confirm whether Usage should tag `source: live-meeting-tts` (today client TTS may be unmetered beyond xAI billing).  
3. **Safari/Firefox Live Meetings:** still blocked on Web Speech; server STT for host mic would change the privacy model — treat as a separate product decision.  
4. **WP-B3 cost abuse:** a paired device synthesizing arbitrary TTS needs rate limits and max chars.

---

*End of SHIB-45 scope. Ready for review and for implementation cards to be cut from §8.*
