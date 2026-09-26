---
description: "The human-facing /rewind slash command: returns to a turn with an explicit mode — restore working-directory code, branch the conversation, or both — and can replace the message that opened the turn before the branch is taken."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-rewind

English | [中文](README.zh.md)

## Summary

`dsh-command-rewind` gives users `/rewind`, which returns to a turn in a mode: `code` restores working-directory files to their content at that turn's start, `conversation` branches the Session from just before it, `both` branches first, then restores, and `--edit <text>` replaces the message that opened the turn in the branch. A conversation rewind never rewrites the source conversation — the branch is a new Session and the source keeps running — but adds a Session that stays listed until archived. Use it in interactive deployments that also mount `dsh-workspace-changes` and `dsh-api-session-controller`; the shipped Web bundle does.

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
| `/rewind code <turn>` | Restores working-directory files to their content at the start of `<turn>` |
| `/rewind conversation <turn>` | Branches the Session from just before `<turn>`, dropping the message that opened it and every later turn from the branch |
| `/rewind both <turn>` | Branches the conversation first, then restores the files |
| `/rewind conversation <turn> --edit <text>` | Same, with `<text>` replacing the message that opened `<turn>` in the branch and sent there |
| `/rewind --help` | Usage and consequences, without acting |
| Missing, unknown, or extra arguments; `--edit` with `code`; an empty `--edit` | A direct command error naming the expected form |

The mode is always required and never inferred: `/rewind 3` reports `3` as an unknown mode rather than assuming one. The turn number refers to the invoking agent's own session — the same numbering the changed-files card shows.

### Modes

- **`code`** — the working tree only. A turn with no recorded file changes, or one recorded without a git snapshot, is a direct command error.
- **`conversation`** — the conversation only; the working tree is not touched at all. The branch inherits every event through the event immediately before the named turn's `turn/start`, so the branch's history ends where that turn began. Rewinding to a turn that opens the Session has no earlier event to cut at: the branch then inherits the opening event itself, and the fork mechanism closes that still-open turn as `forked`.
- **`both`** — one branch and one file restore, in that order. Each half reports its own outcome; a failed half is named as `Incomplete —` beside the half that succeeded.

A conversation rewind works whether or not the named turn has completed, including a turn that is still running: the branch is only a prefix copy, and the source keeps running.

### What is not reversible

- **Restored file content is gone.** `restore()` diffs the named turn's turn-start tree against a fresh snapshot of the working tree and writes the result directly. Content that this rewind replaces — uncommitted edits, untracked files it deletes, content only the working tree held — is not saved anywhere by either package, so `/rewind` cannot bring it back. Only git history, committed or stashed outside this command, holds a copy. The command's own output repeats this once it has restored anything.
- **A conversation rewind is not destructive.** It never changes the source Session: history, queue, and pending work stay exactly as they were, and only `command/run` plus `command/done` lifecycle records are appended. The cost is instead an *extra* Session: the branch stays in the Session list until it is archived or deleted, and the replacement message is sent in the branch, never in the source.
- **Neither half is transactional with the other.** In `both` mode a failure after the branch was taken leaves that branch in place; the output names the failure instead of hiding it.

### Compose it

The command injects the commands registry, the workspace-changes service, and the Session Controller whose fork it takes:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: workspace-changes
  name: '@deepseek-ai/dsh-workspace-changes'
- id: session-controller
  name: '@deepseek-ai/dsh-api-session-controller'
- id: command-rewind
  name: '@deepseek-ai/dsh-command-rewind'
```

The shipped Web bundle mounts this row beside `workspace-changes` and `session-controller`, at the host level rather than per agent preset — the same placement as the services it calls.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command finds a turn and renders the outcome; the restore semantics themselves belong to [`dsh-workspace-changes`'s own README](../workspace-changes/README.md#rewind), and branching belongs to the Session Controller.

### Design

- **Turn number, not event sequence.** A human names a turn by its number; the command scans the invoking session's own log for the lowest-sequence `workspace/changes` event announcing that turn number and passes that event's sequence to `restore()` — the same lookup the changed-files card uses to find a turn's summary. The conversation half resolves the named turn's `turn/start` event instead, and cuts one event before it.
- **Every precondition is resolved before anything acts.** Mode, turn, and replacement text are parsed strictly; the turn's announcement and its `turn/start` are located; only then does the command branch and restore. A rejected invocation cannot restore half the files or leave a branch behind.
- **The branch runs before the files.** The branch is the non-destructive half, so a failing restore is never preceded by a write; a failing branch never blocks a requested file restore.
- **The conversation half is the existing branch mechanism.** `ctx.sessionController.fork()` takes the branch: it builds the seed from the exact event prefix, creates the child with `parentSession` set, and attaches it to the source's workspace. The command never edits the log itself and never opens a second history path.
- **A replacement message is admitted, not injected.** With `--edit`, the command sends the replacement as the branch's next prompt through `ctx.sessionController.prompt()`, so it lands as an ordinary logged `user/message` that the loop claims; the model-visible text and the log agree by construction. The prompt carries a command-minted request id. The original message is untouched in the source log, and the whole input line is recorded by `command/run`, so the replacement stays reconstructable from the log even when the branch's prompt fails.
- **Direct command result, never a model turn.** Like `/goal`, `/compact`, and `/review`, `/rewind` executes in the UI command plane; the outcome never enters the parent agent's own model request.
- **Every skip is reported, not silently dropped.** A binary file, an oversized file, or one `restore()` could not write back appears in the rendered output with its reason, alongside every file that was restored.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: command registration, input parsing, turn-to-sequence lookup, branch and restore orchestration, result rendering |
| — | No runtime invariant companion is published; this command adapter owns no event stream or state projection — dispatch behavior is covered by package tests, and the restore operation's own invariants belong to `dsh-workspace-changes` while branching belongs to `dsh-api-session-controller`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace changes](../workspace-changes/README.md#rewind) — the `restore()` method the code half calls, and its full rewind semantics.
- [Sessions](../../../docs/subsystems/session.md) — the append-only log, fork boundaries, and `buildForkSeed`.
- [Web Chat turn tail](../../client/ui-chat/README.md) — the in-place rewind dialog that dispatches this command.
- [Commands service](../../interaction/commands/README.md) — the command registry contract and dispatch.
- [Deliverables subsystem](../../../docs/subsystems/deliverables.md) — the `WorkspaceChanges` service and `WorkspaceRestoreResult` vocabulary.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/rewind` control

#### What the model sees

Nothing from the code half or from the parent's own conversation: the slash input, the located turn, the branch, and the file outcome are absent from the parent agent's model requests. Two records do stay in the parent's log and stay out of its surface: `command/run` (the exact input line, including any `--edit` text) and `command/done` (the outcome), both log-only. Restored files reach the model only indirectly, the next time it reads or edits them. A replacement message from `--edit` is model-visible *in the branch*: the branch inherits the prefix through the event before the named turn, and the replacement enters as an ordinary `user/message` that the branch's loop claims and derives its history from, so the parent's conversation never contains it.

#### Token effect

`/rewind` adds no tokens to the parent's own model requests. A branch with `--edit` starts a new Session whose first request re-reads the inherited prefix; that cost belongs to the branch, not to the Session that ran the command.

#### KV Cache effect

None for the parent — the command never changes the parent's request prefix. The branch is a separate Session with its own request series, so it builds its own cache from the inherited history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the command is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Web command adapter only in the shipped apps** — headless, ACP automation, and JSON-RPC adapters do not consume `ctx.commands`, so `/rewind` is reachable only from the Web composer and from the Web Chat turn-tail dialog today.
- **The host must mount the Session Controller** — the conversation half is unavailable without `ctx.sessionController`, and this package does not register without it.
- **The branch arrives through the Session list** — the command returns the branch's id in its text; the composer's dialogs do not open it for you, unlike the in-chat branch action. Switching to it is a sidebar selection.
- **A turn that opens the Session has no clean conversation cut** — the branch inherits the opening `turn/start` event and the fork mechanism closes that turn as `forked`, so the branch shows one empty turn before the replacement. Later turns cut cleanly.
- **`--edit` needs a served model route** — the replacement is admitted through the ordinary prompt path, so a deployment with no adapter for the source's selected provider fails that half (the branch itself is already taken and the output says so). Attachments cannot be part of a replacement: `--edit` takes text only.
- **`--edit` text runs to the end of the line** — there is no quoting or escaping; a replacement containing the literal token ` --edit ` keeps everything after the first occurrence.
- **Every constraint of `restore()` applies** — git-only, binary/oversized skip, and the other limits `dsh-workspace-changes` documents apply here unchanged; this command adds no new constraint of its own.
- **File restoration is not sandboxed** — it is a human-initiated Host action, the same trust boundary `dsh-workspace-changes` documents for `restore()`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided: whether a conversation rewind should also be offered by headless and ACP adapters once they consume `ctx.commands`, and whether the branch should be auto-selected by the Web dialog that dispatched the command.

</details>
