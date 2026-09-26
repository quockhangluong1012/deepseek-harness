---
description: "The human-facing /review and /security-review slash commands: an independent reviewer subagent reports structured findings on a diff, and a client review panel renders them."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-review

English | [中文](README.zh.md)

## Summary

`dsh-command-review` gives users two review commands: `/review` and `/security-review`. Each starts an independent reviewer subagent — by default a fresh `spawn` child with no parent conversation, optionally another model — and renders its structured findings on a diff directly in the UI. Both commands are one implementation: spawn path, report schema, prompt builder, and rendering are shared; only the question differs. A review never reaches the parent's own model request — it is a direct command result like `/goal`. Use it in interactive deployments with a command adapter.

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
| `/security-review` | Reviews the uncommitted working-tree changes for security defects |
| `/security-review <ref>` | Reviews the diff against `<ref>` for security defects |
| `/security-review --help` | Shows usage without starting a reviewer |

`/review` reports every real defect, security issue, or correctness risk it finds. `/security-review` asks for security defects only — injection, broken authentication or authorization, missing validation at a trust boundary, exposed secrets, unsafe deserialization, path traversal, server-side request forgery, cross-site scripting, unsafe cryptography or randomness, permissive CORS, and unsafe defaults — and names the vulnerability class in each finding; it leaves style, performance, and general correctness to `/review`.

Neither command computes the diff itself: each tells the reviewer subagent which `git diff` invocation to run and lets it read the diff, and any surrounding file context it needs, with its own tools. The reviewer never edits anything — the prompt asks it not to, and no write-capable tool is required for the task.

### Findings

A completed review renders as the reviewer's one- or two-sentence summary, followed by every finding — file, optional line or range, and a one-sentence message — grouped `high`, then `medium`, then `low`. No findings prints `No findings.` after the summary. A reviewer that does not finish (cancelled, out of budget, refused, or a model/transport error) or that finishes without a valid structured report is a direct command error naming the stop reason and, when the provider supplied one, its diagnostic text.

A completed review is also recorded durably, as the log-only `review/report` event carrying the review kind, its diff target, the summary, and the findings. The command outcome cites that record, so a client review panel can render the same report as structured UI while the plain text stays the output every adapter shows.

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

Both commands run under the same configured route: one deployment, one reviewer backend. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-command-review) is the exhaustive source for every accepted field. The shipped base bundle mounts this row against the `spawn` provider, which is a fresh child with no parent conversation — the review runs with no memory of what the parent has already discussed, matching the independent-reviewer design in the target architecture (§10.6).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the commands build the reviewer's task and render its answer; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **One spawn path, two prompts.** `src/reviewer.ts` owns the reviewer seam: `runReviewer` starts the configured provider with a task's label, prompt, and output schema, awaits the run, and always disposes it; `reviewPrompt(kind, ref)` builds the question for each kind from one shared scope and target phrase. The commands are variants in a table that carry identity, kind, description, and usage — never a second prompt or a second spawn call.
- **The reviewer computes its own diff.** The prompt names the exact `git diff` invocation to run and lets the reviewer's own tools read it, rather than pre-computing the diff text and pasting it into the prompt — the reviewer can also read surrounding file context when a finding needs it, at the cost of the reviewer needing shell and file-reading tools in its composition.
- **Structured output, not free text.** The reviewer's final turn is validated against one object-rooted `outputSchema` (`summary: string`, `findings: { file, line?, severity, message }[]`) through the existing `SubagentStartRequest.outputSchema` seam — the same one `dsh-tool-subagent` model calls use — so rendering never has to parse prose.
- **Direct command result, never a model turn.** Like `/goal` and `/compact`, both commands execute in the UI command plane; the diff, the reviewer's tool calls, and its findings never enter the parent agent's own model request.
- **The report is durable.** A completed review is appended as the log-only `review/report` event and cited by the command outcome, so structured UI can render it after a reload. The event never reaches a model request.
- **The run is always disposed.** Whether the reviewer completes, fails, or the command handler itself throws, the started run's `dispose()` runs in a `finally` block.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the review variant table, command registration, the durable record, and result rendering |
| [`src/reviewer.ts`](src/reviewer.ts) | The shared reviewer seam: prompt builder, report schema, spawn path, and the `review/report` event declaration |
| — | No runtime invariant companion is published; this command adapter owns no event stream or state projection — dispatch behavior is covered by package tests, and the reviewer child's own lifecycle invariants belong to `dsh-subagent`. |

Other packages reach the same reviewer through the package root: `runReviewer`, `reviewPrompt`, `REVIEW_OUTPUT_SCHEMA`, and the `ReviewFinding`/`ReviewReport` types are exported for callers that own their own reviewer port. `dsh-agent-kernel`'s coding lifecycle is one such caller.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The commands are a thin adapter over the subagent seam; read these pages for the delegation contract and the registry they plug into.

- [Subagent service](../subagent/README.md) — the `ctx.subagents` seam, `outputSchema`, and the one-shot run contract these commands drive directly.
- [Subagent spawn provider](../subagent-spawn-in-process/README.md) — the reference backend: a fresh child with no parent conversation.
- [Model-facing delegation tool](../tool-subagent/README.md) — the sibling consumer of the same seam, for the model-authored delegation path.
- [Commands service](../../interaction/commands/README.md) — the command registry contract and dispatch.
- [Review findings panel](../../client/ui-review/README.md) — the browser surface that renders the durable report as structured UI.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-command-review) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Human review control

#### What the model sees

Nothing from the parent agent's perspective: the slash input, the reviewer's task prompt, its tool calls, and its rendered findings are absent from the parent's model requests. The reviewer child is its own agent with its own model request history, scoped to its own session.

#### Token effect

Neither command adds tokens to the parent's own model requests. The reviewer child's tool calls and turns consume its own budget, under whatever route `provider`/`model` resolve to.

#### KV Cache effect

None for the parent — the commands never change the parent's request prefix. The reviewer child follows the fresh-child KV Cache behavior of whichever provider it is configured against.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the commands are a poor fit or need special care. They are current package constraints, not a task backlog.

- **Web command adapter only in the shipped apps** — headless, ACP automation, and JSON-RPC adapters do not consume `ctx.commands`, so the commands are reachable only from the Web composer today.
- **Read-only findings** — the panel renders what the reviewer reported; accepting, dismissing, or annotating a finding is not implemented.
- **The reviewer needs its own tools** — a composition that gives the `spawn` (or configured) provider's children no shell or file-reading tools cannot produce a real review; the commands do not verify tool availability before starting the run.
- **One route per deployment** — both commands run under the configured `provider`/`model`, so asking a second backend for a second opinion in the same invocation is not possible.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. The report reaches the client as the log-only `review/report` event: any new field a panel needs belongs on that event, not in the rendered command text.

</details>
