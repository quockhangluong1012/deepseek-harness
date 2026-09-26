# AGENTS.md — Recorded-session snapshots

This tree contains only tests whose committed session JSONL is replay input and expected persisted output. Keep non-session ARIA, geometry, generator, CLI, and unit expected output with its owning app, script, or package and its tier (`test:expected`, `test:web`, `test`).

Every process under test starts through the `dsh` CLI with a shipped profile and optional scenario patches; test clients may drive a public protocol or browser interface. Do not add another application entrypoint, hidden CLI mode, or executable scenario driver.

Each scenario owns or references one primary Session role plus contiguous child roles. Canonical parent filenames are `session[.vN].jsonl` and children `session.<ordinal>[.vN].jsonl`; v0 omits `.v0`, positive versions use lowercase `.vN`, and every filename agrees with its header. Of several retained generations, replay, record, and refresh select the numerically highest; record and refresh write version-named outputs without renaming or deleting a committed generation, and the owner alone records or refreshes the selected role. For a one-shot case, derive the user task and replay script from the selected JSONL instead of duplicating them in `input.json`. Shared references are read-only, acyclic, point to the owner's selected parent generation, and serve only another interface intentionally rendering that recorded behavior.

A `snapshot.yml` declaring an exact `sessionFormat.version` and closed migration `coverage` names keeps a historical generation or retired-tool recording; record and refresh never rewrite it; `retired-tools` pins removed capabilities independently of migration coverage. Otherwise record and refresh write current-writer output, and replay accepts the retained V3 baseline or the current generation. The [corpus policy](../scripts/session-snapshot-corpus-policy.ts) requires V3 inputs for direct upgrade coverage and explicit V0–V2 migration coverage; a writer bump alone does not refresh fixtures.

Committed sessions are normalization fixed points: replace volatile identities with typed relationship-preserving tokens, replace request system prompts and tool schemas with tokens, and keep exactly one readable sidecar owner per header class. Never redact arbitrary user or tool text that merely resembles an identifier.

An adapter-local symlink may expose a cross-profile prompt or schema sidecar only when `snapshot.yml` names that source; the corpus gate resolves and checks the declared target. The required snapshot lane runs these aliases on macOS and Linux.

Workspace seeds stay scenario-local. A scenario that mutates the workspace sets `workspace.final: true` and commits the complete result under `workspace.expected/`; use only the ignored `.empty` marker for an empty result. Record and refresh do not rewrite this independent oracle.

`pnpm run test:snapshot` replays without writes. Recording and refresh use the explicit snapshot scripts, and every resulting JSONL, prompt, schema, protocol, UI, and workspace diff is reviewed before commit.
