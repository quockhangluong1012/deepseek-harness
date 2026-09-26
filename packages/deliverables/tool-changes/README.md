---
description: "Read-only model-facing tools that report one turn's recorded workspace changes and read one listed file's diff from the record rather than from a re-run."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-changes

English | [中文](README.zh.md)

## Summary

`dsh-tool-changes` lets a model read what one turn changed in the workspace without re-running whatever made the change. `turn_changes` lists a turn's changed files with added and deleted line counts; `turn_diff` reads one listed file's recorded hunks. Both resolve the turn from the calling Session's own `workspace/changes` events and read the summary through `ctx.workspaceChanges`, so this package stores nothing and re-executes nothing. Mount `dsh-workspace-changes` beside it. A turn that recorded no changes, and a record this Host process no longer serves, are reported as failures rather than as empty answers.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package wherever a coding agent should be able to review earlier work from the recorded turn rather than by re-reading files or re-running commands.

### When to choose it

Choose it when a deployment already records turns with `dsh-workspace-changes` and the model needs that record: an agent that reviews, repairs, or reports on files another turn changed, including paths a plain `git diff` would not show — files git ignores, files outside the repository, and files outside the working directory. Skip it when the model should inspect the current content instead; the ordinary file tools own that, and the diff of work in progress is whatever the working tree currently holds.

### Configuration

The package accepts no `Config` fields. Every bound belongs to the recorder that produced the record: the file cap that limits `files`, the byte cap a comparison refuses, and the time bound that degrades a comparison to whole-file replacement.

### What the model can do

| Tool | What the model gets |
|---|---|
| `turn_changes` | The files one turn changed, in display order, each with added and deleted line counts, plus the complete changed-file count when the recorder's file cap omitted some |
| `turn_diff` | One listed file's unified hunks with three context lines, or a statement that the file is binary or over the comparison size cap |

Both tools take the turn number and omit it for the most recently recorded turn. `turn_diff` takes the file path as `turn_changes` listed it, and accepts the file's durable path as well.

### Failures and recovery

No tool call re-runs the producing command, so a failure is always about the record. A Session that recorded no turn changes, a named turn that recorded none, and a summary or comparison this Host process no longer serves — a resumed Session, or one disposed since — each fail with a message naming the condition. The tools never answer an unavailable record with an empty change list. A comparison whose snapshot read fails propagates the recorder's error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tools; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The package is one read-only adapter, built on three commitments:

- **One owner per fact.** The recorder owns snapshots, captures, summaries, and comparisons; this package owns resolution and rendering only, and declares no storage, cache, or index.
- **Reference, never re-execution.** A turn is addressed by its own `workspace/changes` sequence; a file by its index in the recorded summary. No tool call reads a working tree or runs a command.
- **Failure over fabrication.** An unavailable record fails with its condition named, because an empty list would read to a model as "the turn changed nothing".

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `inject`, turn resolution, both tool registrations |
| [`src/render.ts`](src/render.ts) | Pure model-facing rendering of both canonical values |
| [`src/types.ts`](src/types.ts) | The canonical values both tools return |
| — | No runtime invariant companion is published; the package owns no mutable state or event sequence, and the recorder's own companion covers the records it serves. |

### Turn resolution

The calling Session's log is the index: `latestTurn` walks `session.snapshotEvents()` for the last `workspace/changes` event, and `announcementSeq` walks it again for the last announcement of a named turn. The last announcement wins because a later announcement for the same turn supersedes an earlier one, including the empty announcement that retracts a record whose files were reverted before the turn ended. The sequence then addresses `ctx.workspaceChanges.summary`, and `turn_diff` resolves the file's index inside that summary before asking for its comparison, so a path the summary does not list is refused before any read starts.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-workspace-changes](../workspace-changes/README.md) — the recorder that owns the records these tools read.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-changes) — the schemas as the model receives them.
- [Deliverables group map](../README.md) — the three packages of this group and each role.
- [dsh-command-rewind](../command-rewind/README.md) — the human-facing `/rewind` command over the same records.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`turn_changes` and `turn_diff` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-changes). Each carries an optional turn number and, for `turn_diff`, the required file path.

#### Token effect

Two fixed read-only schemas are sent on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

Each successful call emits one plain-text block: `turn_changes` a header naming the turn, the counts, and the working directory, then one line per listed file; `turn_diff` a header naming the turn and file, then `@@` hunk headers with `+`, `-`, and space-prefixed lines. A refused comparison states binary or over-cap in place of lines. The generic spill policy may replace an oversized inline result with its preview, locator, and retrieval hint.

#### Token effect

Results are data-dependent and remain in logged tool history until compaction; the recorder's file cap bounds the listed files and its byte cap bounds one comparison.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A turn is reportable only after it stops** — the recorder records at turn end, so a call made inside the running turn sees the most recent completed turn, never the current one's changes.
- **The record lives in the recording process** — a Session resumed after a Host restart, or one recorded by another process, has its `workspace/changes` events but no summary; both tools fail on it.
- **Subagent Sessions are never recorded** — the recorder records top-level turns only, so a subagent's own changes are absent from this record.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
