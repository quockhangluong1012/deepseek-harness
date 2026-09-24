---
description: "The read-only kernel command line: dsh task and dsh policy commands over the kernel record a stored session already carries, plus dsh evolution replay over a recorded experiment envelope."
kind: "package-bundle"
---

# @deepseek-ai/dsh-kernel-ops

English | [中文](README.zh.md)

## Summary

Read recorded kernel state from `dsh` without starting an agent. `dsh task show`, `verify`, `checkpoint`, `metrics`, `recover-scan`, and `dsh policy explain` report one session's contract, verification, checkpoints, counters, recovery status, or policy decision. `dsh evolution replay` reads one recorded experiment. All commands are read-only.

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

The `dsh` CLI routes the `task` and `policy` families here: each invocation boots the `kernel-ops` profile — `dsh-base` plus this bundle — with the command line intact.

```text
dsh task show <session-id> [--json]
dsh task verify <session-id> [--json]
dsh task checkpoint <session-id> [--json]
dsh task metrics <session-id> [--json]
dsh task recover-scan [--json]
dsh policy explain <session-id> <action-id> [--json]
dsh evolution replay <run-id> [--json]
```

An id-based `task` or `policy` command needs the named session and its kernel record. `dsh task recover-scan` instead reports every stored non-terminal or unreadable kernel session from the one-time startup scan; it needs a profile mounting `@deepseek-ai/dsh-agent-kernel` and session persistence. `evolution replay` reads a run id from the lineage store and reports `the evolution lineage store is not mounted` when a deployment omits it.

`dsh task recover-scan` exits non-zero when any entry is repairable or blocked; an empty result or resumable entries exit zero. `dsh task verify` exits non-zero when the stored gate is blocked or no verification was recorded. `dsh task checkpoint` prints the newest checkpoint and exits non-zero when none was recorded.

### What you get

| Command | Prints |
|---|---|
| `task show` | Objective, status, revision, profiles, workspace, plan revision and steps, step and tool-call counts, open actions, unresolved failures, evidence/claim/hypothesis counts, newest checkpoint |
| `task verify` | The newest recorded verification result, each criterion's outcome, the unresolved failures, and the completion gate's verdict |
| `task checkpoint` | The newest checkpoint's identity, reason, status, revision, session sequence, and creation time |
| `task metrics` | The counters this session's kernel events imply: tasks and terminal outcomes, verification counts and pass rate, steps and tool calls, action outcomes, policy denials and asks, rejected approvals, failures by kind, recovery decisions, checkpoints and resumes |
| `task recover-scan` | Every non-terminal or unreadable stored kernel session, its resumable/repairable/blocked classification, and the evidence reason |
| `policy explain` | The proposal (`tool`, `source`, `trust`, task revision, arguments), the composed decision (effect, enforcement, capability grants, sandbox mode and root, reasons), the approval outcome, and whether the action is still open |
| `evolution replay` | The recorded experiment's skill, outcome, operator, candidate, tasks, measured triple, regressions, dependency versions, and the seeds it ran, from `ctx.evolutionLineage` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`task show`, `task verify`, `task checkpoint`, `task metrics`, and `policy explain` open a read handle through `ctx.sessionPersistence` and fold the selected log with `readKernelRecord`. `task recover-scan` awaits `ctx.agentKernel.startupRecovery`, the same one-time scan started when persistence becomes available. `evolution replay` reads `ctx.evolutionLineage`. The fold is the kernel's own, so a command reports the state the live kernel derived from those events.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The command line: one action per command, reading, folding, printing, then requesting the launcher's exit |
| [`src/report.ts`](src/report.ts) | The text and JSON projections of a folded record, so both surfaces read one shape |
| [`src/internals.ts`](src/internals.ts) | The writers tests substitute for stdout and stderr |
| [`cordis.patch.yml`](cordis.patch.yml) | The rows this bundle inserts into its profile: the command line and the evolution-lineage store |
| — | No runtime invariant companion is published; the commands add no invariant beyond the kernel's own, which its package owns. |

A command never infers: a gate that cannot be decided from the log is `unknown` or `never run`, and a missing checkpoint is a non-zero exit rather than an empty print.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent kernel](../../runtime/agent-kernel/README.md) — the ledger, the completion gate, and the event families these commands read.
- [app-boot](../../boot/app-boot/README.md) — how the `kernel-ops` profile resolves its bundles.
- [dsh CLI](../../../apps/cli/README.md) — the launcher that routes `dsh task` and `dsh policy` here.

-----

<a id="model-experience"></a>
## Model Experience

None, as the commands run outside any agent, reach no model, and append no session events.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Read-only by construction.** Pausing, resuming, or checkpointing a LIVE run belongs to the process that owns that agent; this command line reports the recorded state of stored sessions and appends nothing.
- **A record, not a re-evaluation.** `task verify` reports the criteria outcomes the session recorded; it does not re-run the verifiers.
- **Whole-log reads.** Single-session commands read the complete selected log; the startup scan reads each stored log once, so its cost grows with the persisted corpus.
- **`evolution replay` polls, not injects, its store.** The lineage store mounts as an ordinary sibling row rather than a hard plugin dependency, so `task`/`policy` commands keep working in a deployment that omits it; the command polls for up to 300ms before reporting it unmounted, covering the store's own async startup without blocking the whole command line on it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
