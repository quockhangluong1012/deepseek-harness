---
description: "Agent-backed acceptance-criterion verifiers for the agent-kernel completion gate: one independent subagent decides each security, browser, and review criterion, for users who need a task's 'done' to rest on a fresh-context verdict."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-verifiers

English | [中文](README.zh.md)

## Summary

Use this package when an acceptance criterion cannot be answered by a shell command. The `security`, `browser`, and `review` families each ask a question only a fresh context can answer: is this change exploitable, does the scenario still work, does an independent reviewer see a defect. This plugin starts one reviewer subagent per such criterion, consumes its structured report, and records the verdict the kernel's completion gate decides on. Every family starts its child through the reviewer helper the review commands share, so `/review`, `/security-review`, and these verifiers ask one question in one place.

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

Mount this plugin beside `@deepseek-ai/dsh-agent-kernel`, the agent registry, and a subagent service. The kernel injects its verifier registry, so mount order never matters; the registry supplies the Agent each reviewer starts from. The plugin claims nothing else: a criterion of another family is left for the verifier that answers it.

### Minimal composition

```yaml
- name: '@deepseek-ai/dsh-agent-kernel'
  config:
    acceptance:
      - id: code-review
        description: an independent reviewer finds no high-severity defect in the change
        verifier: review
        required: true
      - id: settings-scenario
        description: the settings page saves without a reload, at http://localhost:3000/settings
        verifier: browser
        required: true
- name: '@deepseek-ai/dsh-agent-verifiers'
  config:
    subagentProvider: spawn
    minSeverity: high
    reviewRef: HEAD
```

### The families this package answers

| Family | What the reviewer decides | Report it returns |
|---|---|---|
| `security` | whether the changed lines introduce or expose an exploitable defect | findings, each with severity |
| `browser` | whether the scenario the criterion describes held when the reviewer exercised it | whether it passed, with observations |
| `review` | whether an independent reviewer finds a real defect or correctness risk | findings, each with severity |

### Which criterion a reviewer answers

A criterion is claimed by its `verifier` family alone: this plugin answers every criterion whose family is `security`, `browser`, or `review`, and no other. It reads no per-criterion configuration, so a deployment that wants one criterion reviewed by a particular provider mounts a second composition rather than adding a field here. A criterion of another family stays unresolved, and the kernel reports it `unknown` rather than passing it.

### Configuration

| Field | Required | Meaning |
|---|---|---|
| `subagentProvider` | no | `ctx.subagents` provider name every reviewer starts through. Defaults to `spawn`, a fresh context with no parent history. |
| `provider` | no | Provider route override for the reviewer child. Absent inherits the parent agent's route. |
| `model` | no | Model id override for the reviewer child. Absent inherits the parent agent's model, and a different one here is the independent reviewer §10.6 asks for. |
| `minSeverity` | no | Lowest finding severity that fails a `security` or `review` criterion: `high`, `medium`, or `low`, defaulting to `high`. |
| `reviewRef` | no | Ref the reviewer diffs the working tree against, defaulting to `HEAD`, whose diff is the uncommitted change set. |

Every accepted field is listed in the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-verifiers).

### What you get

| Reviewer outcome | Verdict |
|---|---|
| Finishes with a report whose worst finding is below `minSeverity` | `pass`, carrying the summary, the findings, and the files they name |
| Finishes with a finding at or above `minSeverity` | `fail`, carrying the report and naming the threshold it crossed |
| Finishes with `passed: false` for a `browser` criterion | `fail`, carrying what the reviewer observed |
| Does not finish, or finishes without the family's report | `fail`, naming the stop reason or the missing report |
| Cannot start, or no Agent is active to start it from | `fail`, naming why no review happened |

Every verdict records the criterion id, the report's own text, and the references the verdict rests on, so a reader of the session log can reconstruct what the reviewer was asked and why the criterion decided as it did. The reviewer child's own session holds the prompt and the child's work.

---

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how a criterion becomes a verdict; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

A family is a question, not a command, so the verifier owns no shell line and no per-criterion table: `supports()` matches the criterion's family, and `verify()` starts exactly one reviewer through `runReviewer` from `@deepseek-ai/dsh-command-review`. That helper is the only spawn path — `/review`, `/security-review`, the kernel's lifecycle reviewer, and this plugin all reach `ctx.subagents.start` through it — so a change to how reviewers start, or to the report schema the findings families return, lands once. The prompt is the family's whole model-facing contract and carries the criterion's id and statement, which is what makes a criterion-scoped verdict possible from a diff-scoped reviewer. The reviewer's structured output is model-generated JSON, so every field is checked before a verdict rests on it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`, the injections, `Config`, and the registering effect |
| [`src/families.ts`](src/families.ts) | The families this package answers, as one list a deployment can read |
| [`src/contracts.ts`](src/contracts.ts) | Each family's prompt and required report schema |
| [`src/verifier.ts`](src/verifier.ts) | The `CriterionVerifier`: family match, the reviewer start, and the verdicts |
| [`src/types.ts`](src/types.ts) | The family vocabulary and the browser family's report |
| — | No runtime invariant companion is published; the verifier owns no state beyond its configuration and derives every verdict from one reviewer's report, so a second observation could not diverge from it. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the family decision to the gate that consumes its verdicts and the reviewer machinery it starts.

- [Agent kernel subsystem reference](../../../docs/subsystems/agent-kernel.md) — the acceptance criterion, the completion gate, and the ordering and timeout the verifier registry applies to registered verifiers.
- [Review commands](../../subagent/command-review/README.md) — `runReviewer`, the shared spawn path and report schema this package starts its reviewers through.
- [Subagent subsystem reference](../../../docs/subsystems/subagent.md) — the provider registry, the one-shot run handle, and the structured result a verdict is read from.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-verifiers) — every accepted field of this plugin.

-----

<a id="model-experience"></a>
## Model Experience

### The reviewer's task prompt

#### What the model sees

Each criterion this package answers becomes one model request in a fresh child context: the family's review instructions, the diff target (`reviewRef`), and the criterion's own id and statement, delivered as the child's user message. The child sees the repository and its tools, not the parent's conversation, and reports back through the family's output schema — findings with severities, or whether the scenario held. The parent model sees the child's report only as the criterion's recorded verdict and as the kernel's repair message when the criterion fails.

#### Token effect

Additive and bounded by what the deployment declares: one child turn per criterion in this family, whose input is the prompt plus whatever the child reads, and whose output is one report. The parent's own requests grow by nothing.

#### KV Cache effect

Independent: no prompt section and no tool schema is registered on the parent, so its request prefix never changes. Each reviewer runs in its own context with its own prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the plugin is a poor fit. They are current package constraints, not a task backlog.

- **The verification seam carries no `AbortSignal`** — `VerificationRequest` has no cancellation channel, so the reviewer is started with an already-unsignalled controller and is stopped only by finishing, by the kernel's `verifierTimeoutMs` ceiling (which abandons the verdict but not the child), or by composition teardown.
- **The reviewer must be started from an Agent** — `ctx.subagents.start` requires a parent Agent, which the verifier reads from the active initiator boundary the agent loop establishes around every turn. A verification driven outside such a boundary (a direct `agentKernel.verify` call from a host, a replay) fails the criterion with that reason instead of guessing a parent.
- **One criterion, one reviewer** — a task declaring ten `review` criteria starts ten children, each with its own context; there is no batching or sharing of a review across criteria.
- **The severity floor is the only pass rule** — a `review` criterion passes whenever no finding reaches `minSeverity`; a deployment that needs a specific defect class excluded must state it in the criterion's description, which reaches the reviewer as part of its prompt.
- **A `browser` criterion needs a reachable application** — the reviewer can only exercise what its tools can reach, so the criterion must name the URL, command, or fixture that starts the application; an unreachable application fails the criterion rather than passing it.
- **Criteria cannot name a per-criterion reviewer route** — the provider and model overrides are plugin configuration, so every criterion in this family reviews through the same route.
- **A failed reviewer blocks completion** — the verdict is `fail`, not `unknown`, so a task whose reviewer could not run stays incomplete until the cause is fixed. That is deliberate: a criterion no reviewer decided must never look like a pass.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The alternatives were a single `agent-verifiers` family that infers its question from the criterion's text, and a third provider of reviewer children inside this package. The first makes the deployment's intent a prompt-parsing guess and hides the three questions behind one name; the second is the second spawn path §10.6 and the reviewer extraction exist to prevent. Three named families over the one shared `runReviewer` keeps each question visible in the criterion, and keeps reviewer startup and its report schema owned where the review commands already own them.

</details>
