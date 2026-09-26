---
description: "The deliverables group map: the Host plugins that record what a turn hands to the user, explicit file deliveries and observed workspace changes, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/deliverables

English | [中文](README.zh.md)

## Summary

The deliverables family records what a turn hands to the user as durable Session events: `present` declares the model's final delivered files, and the workspace-changes recorder captures each turn's changed files with line counts from git snapshots and whole-file captures, serves each file's comparison, and can rewind working-directory code to a turn's start. `/rewind` exposes that rewind to the user without a model turn, and `tool-changes` reads a recorded turn back to the model. The Web [deliverables plugin](../client/ui-deliverables/README.md) renders the recorded changes after a turn. Choose this family for a product that shows delivered files and per-turn changes.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-present`](tool-present/README.md) | Declares existing files as final deliverables through the `present` tool | registers on `ctx.tools` |
| [`workspace-changes`](workspace-changes/README.md) | Summarizes each top-level turn's changed files from git working-tree snapshots and whole-file captures, serves their comparisons, and rewinds code to a turn's start | provides `ctx.workspaceChanges`; listens to `session/event`, appends `workspace/changes` |
| [`tool-changes`](tool-changes/README.md) | Reports one recorded turn's changed files and one listed file's comparison to the model through two read-only tools | registers on `ctx.tools` |
| [`command-rewind`](command-rewind/README.md) | Exposes `/rewind`: restores working-directory files to their content at the start of a turn | registers on `ctx.commands` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Deliverables subsystem](../../docs/subsystems/deliverables.md) — the `PresentedFile` and `WorkspaceChangesSummary` vocabulary, the two durable events, and the summary service.
- [Web deliverables](../client/ui-deliverables/README.md) — the turn-tail cards and file mentions that render these events.
- [Present declares workspace source files](../../.agents/notes/implemented/feature/2026-09-08-present-workspace-source-files.md) — the delivery decision.
- [Turn changed-files card](../../.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.md) — the snapshot design and coverage rules.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
