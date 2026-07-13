# Artifact Studio

Artifact Studio turns a task-owned output file into an immutable, reviewable deliverable. Open a task and use its Artifact Studio panel to register HTML, PDF, DOCX, PPTX, XLSX, PNG/JPEG/GIF/WebP/SVG, or text output.

## Version and ownership guarantees

- The source must resolve to a regular file inside one of the task's writable workspace roots. Symlinks and path escapes are rejected.
- Every version is matched byte-for-byte to a sealed task checkpoint before its snapshot is accepted. The snapshot is stored outside the workspace, marked read-only, hashed with SHA-256, and checked again whenever it is served or verified.
- A new version cannot silently change the artifact format. Capturing unchanged bytes is rejected instead of creating a meaningless version.
- Selecting an older version and choosing **Roll back** only changes the artifact's current-version pointer; immutable history and existing evidence remain inspectable.
- Agent `fs_write` automatically registers HTML and SVG deliverables. File creation is informational until a supported renderer and a human visual review record a pass.

## Preview and review

HTML runs in a script-capable sandbox with an opaque origin and a response CSP that blocks network access, forms, popups, storage access, nested frames, and Studio-origin access. PDF and images use isolated browser previews. DOCX uses `docx-preview`; PPTX and XLSX use bounded, read-only OOXML extraction through `jszip`. ZIP entry counts and expanded size are capped. Shiba does not install the vulnerable `xlsx` package.

A pass or fail writes typed artifact evidence into the owning task's evidence ledger and records the renderer, notes, version ID, and checkpoint ID. Passing an old version does not mark a different pending current version as verified.

Annotations support normalized regions, pages, slides, tables/sheets, and A1 cells. They are bound to one immutable version and can be resolved or reopened.

## Live sources and publishing

Checking **Approve this task-owned file as a read-only live source** stores a server-issued approval timestamp. Refresh can only read that approved source and create a new immutable version; it never writes back. Integration sources remain disabled unless a connector-specific read adapter exists.

Only visually verified versions can be published. Publications expire within 30 days, are bearer-link or local/LAN audience scoped, expose no snapshot path, and use `no-store` so revocation takes effect on the next request. A publication can be revoked individually. **Takedown and archive** revokes every link and prevents further publishing.

Run the focused verifier with:

```bash
npx tsx scripts/verify-artifacts.ts
```
