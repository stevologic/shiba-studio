# Meetings and voice notes

The Meetings page provides consent-first microphone capture and user-selected audio upload. It does not capture desktop, meeting-app, or system audio automatically.

## Consent and privacy

- The recording and upload controls remain disabled until the user confirms that everyone whose consent is required has consented and accepts responsibility for applicable recording laws.
- The server independently requires that consent confirmation; bypassing the browser control does not bypass the gate.
- Audio is written to the local Shiba data directory with a generated filename. Browser filenames never determine a filesystem path.
- Uploads are streamed to disk, restricted to supported audio media types, and stopped at 50 MB even when `Content-Length` is absent or incorrect.
- Audio is addressed by meeting ID through a range-capable route. Arbitrary local paths are never accepted.

## Transcription

Transcription is a separate explicit action after upload. The server sends the local audio to the xAI batch speech-to-text endpoint at `POST /v1/stt`, requesting `format=true` and `diarize=true`. xAI API-key or OAuth credentials are resolved on the server and never sent to the browser.

The stored result includes every word's start/end time and detected speaker ID. Adjacent words are assembled into speaker turns without discarding the original word timing. Review generation produces an editable summary, decisions, owners, and action items. Model-suggested citations are matched back to the local transcript so their timestamps come from the transcription result rather than generated text.

## Review, citations, and follow-up work

- Each transcript turn links to `/meetings?meeting=<id>&t=<seconds>&end=<seconds>`. Opening the link selects the meeting and seeks the local audio to that exact moment when audio is still retained.
- Agents can call the read-only `meeting_search` tool in later chats. Results contain the speaker turn, exact start/end seconds, and the same stable citation URL.
- Saving a review does not create work. The user selects reviewed action items, chooses Board cards and/or durable manual Routines, and confirms a second dialog before any output is created.
- Output claims are unique per meeting, action item, and output type, so retries cannot create duplicates. Created output links are recorded as task evidence.
- Every meeting owns a durable task. Its completion contract requires both a speaker-aware transcript and review evidence.

## Retention and deletion

The user chooses an audio retention period. Expired audio is pruned locally while the reviewed transcript, citations, and output links remain. “Delete audio” applies the same audio-only deletion immediately; “Delete meeting” removes the local recording and soft-deletes its transcript/review record.

Automatic system-audio capture is intentionally shown as unsupported. Users may upload a mixed recording only when they are authorized to record it.
