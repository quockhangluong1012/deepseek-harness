---
description: "Durable kernel-task surface: one Chat node per agent-kernel task contract, folding the kernel's own records into status, plan, budget, verification, checkpoint, and research facts."
kind: "client-ui"
---

# @deepseek-ai/dsh-client-ui-kernel-task

English | [中文](README.zh.md)

## Summary

Render the [agent kernel](../../runtime/agent-kernel/README.md)'s task record as one Chat node. The node folds the kernel's own durable events — status transitions, plan revisions, verification results, checkpoints, open actions, unresolved failures, and the research record — so a reader sees the task's objective, how far it got, and what the completion gate decided without opening the session log. The node is a view: the kernel and the log stay the owners of every fact it shows.

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

The Web app mounts it as one client row (`ui-kernel-task`); nothing else is required. The node appears where the profile's kernel wrote a `task/created` event, and it stays absent — not empty — when a profile runs no kernel.

| Collapsed | Expanded |
|---|---|
| Objective, status dot, status label, revision, open-action count, unresolved-failure count | Agent and policy profile, budget ceilings, plan revision with its steps, verification status with each criterion, newest checkpoint with its reason and covered sequence, and the research counts |

A task that never reached a terminal status inside a **closed** turn or step renders as interrupted: the log holds no further events, so the run cannot still be progressing. That is a reading of the log, not a second state machine — a still-open location keeps rendering as in progress.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Role |
|---|---|
| [`src/client/task-definition.ts`](src/client/task-definition.ts) | The Conversation Node Definition: which events it claims, the fold, and the projected renderer data |
| [`src/client/KernelTaskPanel.tsx`](src/client/KernelTaskPanel.tsx) | The keyed Chat renderer |
| [`src/client/locales.ts`](src/client/locales.ts) | The `kernelTask` dictionary pair |
| [`src/index.ts`](src/index.ts) | Host half; the feature is entirely browser-side |

The Definition claims `task/created` as its start and every later kernel record that names the same task through its event metadata. A kernel record written without that metadata belongs to a prefix the node cannot claim, so it is ignored rather than attached to the wrong task.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent kernel](../../runtime/agent-kernel/README.md) — the records this node renders and the gate that decides completion.
- [Client group map](../README.md) — every browser package.

-----

<a id="model-experience"></a>
## Model Experience

None, as the node renders persisted kernel events and adds no prompt content of its own.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Read-only.** The node shows what the kernel recorded; pausing, resuming, or approving stays with the surfaces that own those actions.
- **No evidence bodies.** It counts evidence, claims, and hypotheses; the records themselves live in the session log and the storage domain.
- **One node per task.** A session that opened several tasks renders one node each, anchored at its own `task/created`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
