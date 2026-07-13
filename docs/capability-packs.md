# Capability Packs and Skill Workshop

Capability Packs are portable, immutable workflow bundles. The current runtime activates skills, slash-command definitions, MCP requirements, integration requirements, Routine templates, action-level permissions, supported surfaces, setup checks, and tests.

Agent templates, event hooks, and migration sections are reserved manifest fields. Proposals may preserve them for review and export, but activation and rollback fail closed while those sections are nonempty; Shiba never pretends an inert section is live. MCP entries are declarative requirements only: activation requires an exact enabled server (including any declared preset, command, arguments, and environment-key presence), but a pack never installs, starts, or invokes an MCP process. Use the separate MCP **Test** action to approve startup and tool discovery.

Open **Memories → Capability Packs & Learning Journey** to import a manifest or propose a workflow from a successful run, a public HTTPS URL, or a local/Git folder. Learning always creates an inert proposal. It never edits an active pack.

## Review and activation

Each proposal records:

- source type, reference, and SHA-256 hash;
- semantic diff from the active version;
- bounded security-scan findings;
- setup-check and test results; and
- exact permission fingerprints requested by the version.

Activation requires every high-severity scan, required setup check, and declared test to pass. The reviewer must explicitly check every new or broadened permission. Permission fingerprints include action, read/write/execute/admin class, resource/account scope, constrained parameters, confirmation policy, and supported surfaces. A changed fingerprint is a new grant; an update cannot inherit it silently.

Safe mode keeps all versions and proposals but blocks activation and runtime use.

## Registry, rollback, and removal

Approved manifests are written to the local Git-ready registry under:

```text
<SHIBA_DATA_DIR>/capability-packs/registry/<pack-id>/<version>/pack.json
```

Versions are immutable. **Roll back** restores the selected version and the exact grants approved with it. **Uninstall** disables every active skill/template while preserving version history. Export downloads a portable manifest.

Pack skills use namespaced IDs (`pack:<pack-id>:<skill-id>`) and appear in the existing agent skill catalog only while the pack is active and safe mode is off. Components whose permission references are not granted stay disabled. Routine templates require a separate explicit instantiation action.

## Safe sources

- URL learning accepts public HTTPS only, disallows credentials/custom ports, rejects private/reserved DNS answers, checks every redirect, enforces time and byte limits, and never executes fetched content.
- Folder learning is read-only, skips symlinks, `.git`, and `node_modules`, stays within the resolved root, and enforces file/depth/byte limits.
- Run learning accepts only completed successful runs.

## Learning Journey

The Learning Journey combines learned pack versions and automatically learned memories. It shows provenance, status, version, pin/archive state, usage, last success, and staleness so obsolete knowledge can be corrected, rolled back, archived, or removed.
