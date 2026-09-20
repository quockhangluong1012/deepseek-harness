---
description: "Agent kernel: one durable task contract per session, an action ledger over the tool pipeline, a capability permission engine, and a completion gate, for users and maintainers governing what the harness allows and records."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-kernel

English | [中文](README.zh.md)

## Summary

Use this package when a deployment must answer, from durable evidence, what a task was for, what the harness allowed, and why it stopped. The kernel attaches to the agent and tool waterfalls the loop already publishes and records four things: a task contract per session, one proposal/decision/authorization/commit record per tool call, a capability permission decision composed with the technical sandbox, and a completion decision that passes only when every required acceptance criterion does. It owns no execution. `mode: 'shadow'` (the default) records every decision and changes no behavior.

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

Mount the plugin in a profile when a deployment needs a durable governance record or a completion gate. Mounted with no configuration it records in shadow mode under an `ask` default policy, which denies nothing because nothing is enforced.

### When to choose it

Choose it when work must be attributable after the fact — an unattended run, a multi-agent composition, or a task whose "done" must be evidence rather than a model statement. Avoid it when the tool surface is fully trusted and a session log already carries everything you read, because the kernel adds one audit record per tool call.

### Configuring the permission document

```yaml
- name: '@deepseek-ai/dsh-agent-kernel'
  config:
    mode: shadow
    policy:
      defaults:
        effect: ask
      rules:
        - action: read
          resource: 'workspace/**'
          effect: allow
        - action: write
          resource: 'workspace/**'
          effect: allow
        - action: shell
          resource: 'git status *'
          effect: allow
    budgets:
      maxSteps: 100
      maxToolCalls: 200
    acceptance:
      - id: build
        description: the package builds
        verifier: build
        required: true
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `shadow` records decisions and changes nothing; `enforce` returns them to the tool pipeline |
| `agentProfile` / `policyProfile` | `default` | Names recorded on every task contract this kernel creates |
| `budgets` | `{}` | Ceilings every created task contract starts with; an unset field is unbounded |
| `policy` | `{ defaults: { effect: ask }, rules: [] }` | The permission document; see [Policy rules](#policy-rules) |
| `acceptance` | `[]` | Criteria every created task contract starts with; without a required one the kernel runs no verification |
| `requireAcceptanceCriteria` | `false` | Whether a task with no criterion may complete at all |
| `allowHumanOnlyCompletion` | `false` | Whether a task whose only passing evidence is human-reported may complete |
| `maxAttemptsPerAction` | `2` | Retry cap the recovery engine reports attempts remaining against |
| `checkpointBeforeRetry` | `true` | Whether a retry is recorded as needing a checkpoint first |

A nonempty `resource: ''`, an unknown `action`, an unknown `effect`, or an unknown default effect fails plugin load with a clear error, so a permission document is never silently inert. Every accepted field is listed in the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-kernel).

<a id="policy-rules"></a>
### Policy rules

A rule selects an action family and a resource glob. `**` matches any run of characters including `/`, `*` matches a run without `/`, `?` matches one character without `/`, and every other character is literal. Evaluation is broad-to-specific with the **last** matching rule winning, so a narrow exception follows the broad rule it narrows.

| Action family | Capabilities that select it |
|---|---|
| `read` | `fs.read` |
| `write` | `fs.write` |
| `edit` | `fs.edit` |
| `shell` | `process.exec`, `terminal.interactive` |
| `network` | `network.read`, `network.write` |
| `mcp` | `mcp.call` |
| `delegate` | `subagent.spawn` |
| `workflow` | `workflow.start` |
| `memory` | `memory.read`, `memory.write` |
| `policy` | `approval.request`, `policy.propose` |

A rule never names a tool. The package that owns a tool declares what one invocation needs through `ctx.agentKernel.capabilities.register()`, projecting the resource from the call's own parsed arguments. A tool with no declaration resolves to `undefined` and is denied, never granted implicitly.

### What you get

Each admitted step opens a task contract: `task/created` carries the objective, constraints, acceptance criteria, workspace, profiles, and budget at `status: 'intake'`, `revision: 1`, and `task/transitioned` records each later move. Each tool call is recorded as `action/proposed`, `policy/decision`, `action/authorized` or `action/denied`, an optional `capability/grant`, and `action/committed` — the last carrying a governance receipt that names the sandbox mode, workspace root, and the human outcome when one was asked for. Each turn that ends on a task with a required criterion records `verification/requested`, `verification/result`, and, when the gate refuses completion, `failure/recorded` and `recovery/decided`.

Three decisions are separate on purpose. The rules decide `allow`, `ask`, or `deny`; the implementation's sandbox may still refuse a mutating capability outside its boundary; and an `ask` is decided by the composed approval answerers, where a missing answerer fails closed. A refusal is recorded as `outcome: 'denied'`, never as an execution failure.

### Reading a task

The public surface is `ctx.agentKernel`:

| Member | What it answers |
|---|---|
| `state.view(session)` | The current task contract, budget observation, open actions, unresolved failures, latest plan, and latest checkpoint |
| `attach(agent)` | A handle whose `snapshot()` reads the live view and whose `dispose()` releases the kernel's reference |
| `capabilities.register(declaration)` | Declares one tool's capabilities and returns the disposer |
| `verifiers.register(verifier)` | Supplies criterion results to the completion gate and returns the disposer |
| `verify(agent, changedScopes)` | Records a verification request and result and returns the completion decision |
| `checkpoint(agent, reason)` | Records an index of the current kernel state at the current session sequence |

The kernel keeps no state outside the session log. Its ledger folds `task/*`, `action/*`, `capability/grant`, `failure/recorded`, `verification/result`, `checkpoint/created`, `step/start`, and `tool/call` events behind a per-session cursor, so a replayed log reproduces the same view.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the kernel learns what happened and where it intervenes; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The kernel is built on four commitments:

- **Observe existing seams; own no execution.** Every integration point is a waterfall or event the loop already publishes: `agent/pre-step`, `agent/turn-stopping`, `tools/pre-execute`, and `tools/post-execute`. No new loop, no second agent identity, no parallel dispatcher.
- **The session log is the only source of truth.** Every decision is appended before it is acted on, and every read is a fold over those events. A task contract, a decision, and a receipt all reconstruct from the log alone.
- **Shadow before enforce.** The default mode records what the kernel would decide and lets execution proceed, so a deployment measures a permission document against real traffic before it can stop any of it.
- **A refusal is not a failure.** Policy denial, sandbox refusal, and approval rejection are distinct failure vocabulary from a tool that ran and errored, and a denied action is never disguised as a tool failure.

### Where each decision is made

| Concern | Seam | Kernel action |
|---|---|---|
| Open or advance a task | `agent/pre-step` | Creates the contract on the first admitted step, then moves it to `executing` |
| Propose an action | `tools/pre-execute` | Appends `action/proposed` before any evaluation, so a crash still records what was asked |
| Decide an action | `tools/pre-execute` | Evaluates the document, composes the sandbox, appends `policy/decision` and the authorization |
| Enforce an action | `tools/pre-execute` return | `deny` blocks the call, `ask` routes through the composed answerers; shadow mode always delegates |
| Observe an action | `tools/post-execute` | Appends `action/committed` with its governance receipt |
| Close a turn | `agent/turn-stopping` | Records the observation edge, then runs the completion gate over a required criterion |
| Read state | any caller | Folds the session log through a per-session cursor |

### The state machine

`state-machine.ts` owns the legal edge table. The staged chain `intake → understanding → retrieving → planning → ready` is available to a planner; the kernel's own driver takes `intake → ready` directly because the loop exposes no plan phase to observe, and records `step-admitted` as the trigger. `awaiting-approval`, `awaiting-user`, `paused`, and `cancelled` are reachable from every non-terminal state, and terminal states have no outgoing edge. `applyTransition()` enforces the compare-and-set the kernel promises: a transition must belong to the task, start from its current status, and cite its current revision, or it throws before anything is appended.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the service, and the waterfall and event listeners |
| [`src/types.ts`](src/types.ts) | Every kernel contract and the `SessionEventMap` merge for the durable event families |
| [`src/state-machine.ts`](src/state-machine.ts) | Legal task edges, the edge assertion, and the compare-and-set projection |
| [`src/policy.ts`](src/policy.ts) | Glob compilation, rule evaluation, and sandbox composition |
| [`src/capabilities.ts`](src/capabilities.ts) | The tool capability registry |
| [`src/verification.ts`](src/verification.ts) | The completion gate and the local criterion-verifier registry |
| [`src/recovery.ts`](src/recovery.ts) | The failure-kind to recovery-action table and its retry bound |
| [`src/ledger.ts`](src/ledger.ts) | The cursor-based fold and the budget observation |
| — | No runtime invariant companion is published; the kernel's fold re-derives its view from the same events an independent companion would read, so the two could not diverge. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the kernel's own contract to the seams it observes and the loop it must not replace.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/pre-execute` and `tools/post-execute` waterfalls and the `PreToolDecision` values the kernel returns.
- [Sandbox subsystem reference](../../../docs/subsystems/sandbox.md) — the technical boundary the kernel intersects its decisions with.
- [Approval subsystem reference](../../../docs/subsystems/approval.md) — the composed answerers that resolve an `ask`, and their fail-closed outcome.
- [Session subsystem reference](../../../docs/subsystems/session.md) — the `SessionEventMap` the kernel declares its durable families on.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-kernel) — every accepted field and its source declaration.
- [runtime group map](../README.md) — the sibling runtime packages.

-----

<a id="model-experience"></a>
## Model Experience

### Denied or deferred tool call

#### What the model sees

No prompt section and no tool schema is added. Exactly one conditional model-visible effect exists: in `enforce` mode, a denied call returns a tool error whose text begins `agent-kernel denied "<tool>": ` followed by the decision's reasons, and an `ask` returns the registry's own approval-driven denial when no answerer grants it. In `shadow` mode the model sees nothing the kernel decided, because the action runs unchanged.

#### Token effect

Zero tokens added in shadow mode. In `enforce` mode a denied call replaces that tool's result with one short reason line, which is smaller than the result the tool would have produced.

#### KV Cache effect

Independent: the kernel registers no prompt section and no schema, so it never changes the request prefix and cannot invalidate a reused entry. A denied call changes only the continued conversation after the tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the kernel is a poor fit. They are current package constraints, not a task backlog.

- **No built-in tool declarations ship here** — `ctx.agentKernel.capabilities.register()` is the seam, but no in-repo package calls it yet, so every built-in tool is undeclared and therefore denied under `mode: enforce`. Declaring capabilities in `dsh-tool-fs`, `dsh-tool-bash`, `dsh-tool-pwsh`, `dsh-tool-web`, `dsh-tool-subagent`, and `dsh-tool-workflow` is the prerequisite for enforcing mode on a real deployment.
- **Enforcing mode denies everything undeclared, by design** — a deployment that turns on `enforce` before declaring its tools stops every tool call. Mount in `shadow` first and read the `action/denied` records.
- **No shipped criterion verifier** — `verifiers.register()` is the seam, and a task that declares a required criterion with no verifier registered records an `unknown` verification and never completes. Commands, builds, and diffs are not run by this package.
- **Token and cost ceilings are reported, not measured** — `budget.maxTokens` and `budget.maxCostUsd` appear unbounded in every budget snapshot because the token meter owns that measurement; `guard/budgets` remains their enforcement listener.
- **Retry attempts count proposals, not executions** — `maxAttemptsPerAction` compares against the number of `action/proposed` events under one action id, so a provider-level retry that never re-proposes does not advance the count.
- **Crash recovery is not implemented** — the kernel records `checkpoint/created` and re-reads the log on resume, but no boot scanner classifies persisted sessions as resumable, repairable, or blocked.
- **The state machine has no planner** — `understanding`, `retrieving`, and `planning` are legal but nothing drives them, so a kernel task moves `intake → ready → executing → observing` and back.
- **Delegation receipts are not attached** — a child agent's kernel starts its own task contract; the parent's grant is not intersected into it, so a subagent's authority is bounded only by its own sandbox and approval policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The kernel is the P0 slice of the [evolutionary agent runtime specification](../../../specs/SPEC-EVOLUTIONARY-AGENT-RUNTIME.md). Two deviations from that specification's literal text are deliberate. First, the kernel creates its task contract at the first admitted step rather than at `agent/session-start`, because the objective is only knowable once a step claims the human message, and because a session-start append would land outside an open turn. Second, `ContextCompiler`, the evidence/claim/hypothesis graph, the model router, workflow checkpointing, and evolution promotion gates are later phases and are not represented here at all.

</details>
