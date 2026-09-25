---
description: "The human-facing /rewind slash command for users and maintainers who want to restore working-directory code to its content at the start of a turn, without editing the conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-rewind

English | [中文](README.zh.md)

## Summary

`dsh-command-rewind` gives users the `/rewind` command: it locates the turn a number names, and restores every file changed since that turn's start back to its content at that moment, through [`dsh-workspace-changes`](../workspace-changes/README.md)'s `restore()`. This is the code half of "rewind to a turn" (§31.1 D3) — the conversation half is the existing Session "Branch" action; combining both in one action remains Client UI work. Use this package in interactive deployments that also mount `dsh-workspace-changes`; the shipped Web bundle mounts both.

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

### Command reference

| Input | Result |
|---|---|
| `/rewind <turn>` | Restores working-directory files to their content at the start of `<turn>` |
| `/rewind --help` | Shows usage without restoring anything |
| `/rewind` (no argument), a non-numeric argument, or a turn below `1` | A direct command error naming the expected form |

The turn number refers to the invoking agent's own session — the same numbering the changed-files card shows. A turn with no recorded file changes (it does not exist, or made no changes) is a direct command error rather than a silent no-op.

### Compose it

The command injects the commands registry and the workspace-changes service:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: workspace-changes
  name: '@deepseek-ai/dsh-workspace-changes'
- id: command-rewind
  name: '@deepseek-ai/dsh-command-rewind'
```

The shipped Web bundle mounts this row beside `workspace-changes`, at the host level rather than per agent preset — the same placement as the service it calls.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command finds a turn and renders the outcome; the restore semantics themselves belong to [`dsh-workspace-changes`'s own README](../workspace-changes/README.md#rewind).

### Design

- **Turn number, not event sequence.** A human names a turn by its number; the command scans the invoking session's own log for the lowest-sequence `workspace/changes` event announcing that turn number and passes that event's sequence to `restore()` — the same lookup the changed-files card uses to find a turn's summary.
- **Direct command result, never a model turn.** Like `/goal`, `/compact`, and `/review`, `/rewind` executes in the UI command plane; the restore outcome never enters the parent agent's own model request.
- **Every skip is reported, not silently dropped.** A binary file, an oversized file, or one `restore()` could not write back appears in the rendered output with its reason, alongside every file that was restored.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: command registration, turn-to-sequence lookup, result rendering |
| — | No runtime invariant companion is published; this command adapter owns no event stream or state projection — dispatch behavior is covered by package tests, and the restore operation's own invariants belong to `dsh-workspace-changes`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace changes](../workspace-changes/README.md#rewind) — the `restore()` method this command calls, and its full rewind semantics.
- [Commands service](../../interaction/commands/README.md) — the command registry contract and dispatch.
- [Deliverables subsystem](../../../docs/subsystems/deliverables.md) — the `WorkspaceChanges` service and `WorkspaceRestoreResult` vocabulary.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/rewind` control

#### What the model sees

Nothing: the slash input, the located turn, and the rewind outcome are absent from the parent agent's model requests. Restored files reach the model only indirectly, the next time it reads or edits them.

#### Token effect

`/rewind` adds no tokens to the parent's own model requests.

#### KV Cache effect

None — the command never changes the parent's request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the command is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Web command adapter only in the shipped apps** — headless, ACP automation, and JSON-RPC adapters do not consume `ctx.commands`, so `/rewind` is reachable only from the Web composer today.
- **Code only, not conversation** — `/rewind` never touches the Session log or the model's context; rewinding the conversation too means also using the existing "Branch" action. A combined action is deferred Client UI work.
- **Every constraint of `restore()` applies** — git-only, binary/oversized skip, and the other limits `dsh-workspace-changes` documents apply here unchanged; this command adds no new constraint of its own.
- **No mode picker** — unlike the target design's "code only, conversation only, or both" choice, this command is code-only by construction; there is no argument that also branches the conversation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided: a combined code-and-conversation rewind, and a Desktop/Web UI trigger point beside the changed-files card, are both deferred Client work, not a change to the command's own contract above.

</details>
