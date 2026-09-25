---
description: "The human-facing /review slash command for users and maintainers who want an independent reviewer subagent's structured findings on a diff, without sending the diff or the review to the parent agent's own model."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-review

English | [中文](README.zh.md)

## Summary

`dsh-command-review` gives users the `/review` command: it starts an independent reviewer subagent — by default a fresh `spawn` child with no parent conversation, optionally a different model — asks it to inspect a diff with its own tools, and renders its structured findings directly in the UI. The review never reaches the parent's own model request: it is a direct command result, like `/goal` and `/compact`. Use this package in interactive deployments with a command adapter; headless and automation apps without one do not need it.

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

Use `dsh-command-review` in interactive deployments that mount a command adapter and at least one `ctx.subagents` provider — the shipped base composition (`spawn`) is the reference.

### Command reference

| Input | Result |
|---|---|
| `/review` | Reviews the uncommitted working-tree changes |
| `/review <ref>` | Reviews the diff between the working tree and `<ref>` — a branch or a commit |
| `/review --help` | Shows usage without starting a reviewer |

The command does not compute the diff itself: it tells the reviewer subagent which `git diff` invocation to run and lets it read the diff, and any surrounding file context it needs, with its own tools. The reviewer never edits anything — the prompt asks it not to, and no write-capable tool is required for the task.

### Findings

A completed review renders as the reviewer's one- or two-sentence summary, followed by every finding — file, optional line or range, and a one-sentence message — grouped `high`, then `medium`, then `low`. No findings prints `No findings.` after the summary. A reviewer that does not finish (cancelled, out of budget, refused, or a model/transport error) or that finishes without a valid structured report is a direct command error naming the stop reason and, when the provider supplied one, its diagnostic text.

### Compose it

The command injects the commands registry and the subagents runtime; it needs at least one registered `ctx.subagents` provider to delegate to:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
  config:
    providerName: spawn
- id: command-review
  name: '@deepseek-ai/dsh-command-review'
  config:
    subagentProvider: spawn
```

| Field | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | `ctx.subagents` provider name the review delegates to |
| `provider` | inherits the parent's | LLM provider route override for the reviewer child |
| `model` | inherits the parent's | Model id override for the reviewer child |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-command-review) is the exhaustive source for every accepted field. The shipped base bundle mounts this row against the `spawn` provider, which is a fresh child with no parent conversation — the review runs with no memory of what the parent has already discussed, matching the independent-reviewer design in the target architecture (§10.6).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command builds the reviewer's task and renders its answer; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **The reviewer computes its own diff.** The command prompt names the exact `git diff` invocation to run and lets the reviewer's own tools read it, rather than pre-computing the diff text and pasting it into the prompt — the reviewer can also read surrounding file context when a finding needs it, at the cost of the reviewer needing shell and file-reading tools in its composition.
- **Structured output, not free text.** The reviewer's final turn is validated against an object-rooted `outputSchema` (`summary: string`, `findings: { file, line?, severity, message }[]`) through the existing `SubagentStartRequest.outputSchema` seam — the same one `dsh-tool-subagent` model calls use — so rendering never has to parse prose.
- **Direct command result, never a model turn.** Like `/goal` and `/compact`, `/review` executes in the UI command plane; the diff, the reviewer's tool calls, and its findings never enter the parent agent's own model request.
- **The run is always disposed.** Whether the reviewer completes, fails, or the command handler itself throws, the started run's `dispose()` runs in a `finally` block.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: command registration, reviewer prompt, output schema, result rendering |
| — | No runtime invariant companion is published; this command adapter owns no event stream or state projection — dispatch behavior is covered by package tests, and the reviewer child's own lifecycle invariants belong to `dsh-subagent`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The command is a thin adapter over the subagent seam; read these pages for the delegation contract and the registry it plugs into.

- [Subagent service](../subagent/README.md) — the `ctx.subagents` seam, `outputSchema`, and the one-shot run contract this command drives directly.
- [Subagent spawn provider](../subagent-spawn-in-process/README.md) — the reference backend: a fresh child with no parent conversation.
- [Model-facing delegation tool](../tool-subagent/README.md) — the sibling consumer of the same seam, for the model-authored delegation path.
- [Commands service](../../interaction/commands/README.md) — the command registry contract and dispatch.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-command-review) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/review` control

#### What the model sees

Nothing from the parent agent's perspective: the slash input, the reviewer's task prompt, its tool calls, and its rendered findings are absent from the parent's model requests. The reviewer child is its own agent with its own model request history, scoped to its own session.

#### Token effect

`/review` adds no tokens to the parent's own model requests. The reviewer child's tool calls and turns consume its own budget, under whatever route `provider`/`model` resolve to.

#### KV Cache effect

None for the parent — the command never changes the parent's request prefix. The reviewer child follows the fresh-child KV Cache behavior of whichever provider it is configured against.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the command is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Web command adapter only in the shipped apps** — headless, ACP automation, and JSON-RPC adapters do not consume `ctx.commands`, so `/review` is reachable only from the Web composer today.
- **No Desktop review panel** — findings render as plain command text; there is no dedicated per-finding UI, inline diff annotation, or accept/dismiss workflow.
- **The reviewer needs its own tools** — a composition that gives the `spawn` (or configured) provider's children no shell or file-reading tools cannot produce a real review; the command does not verify tool availability before starting the run.
- **One review per invocation** — there is no `/security-review` variant with a different prompt, and no way to ask for a second opinion from a different model in the same invocation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided: a `/security-review` prompt variant and a Desktop review panel are both deferred UI/prompt work, not a change to the delegation contract above.

</details>
