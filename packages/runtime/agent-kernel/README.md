---
description: "Agent kernel: one durable task contract per session, an action ledger over the tool pipeline, a capability permission engine, and a completion gate, for users and maintainers governing what the harness allows and records."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-kernel

English | [中文](README.zh.md)

## Summary

Use this package when a deployment must answer, from durable evidence, what a task was for, what the harness allowed, and why it stopped. The kernel attaches to the agent and tool waterfalls the loop already publishes and records four things: one task contract per request, one proposal/decision/authorization/commit record per tool call, a capability decision composed with the sandbox, and a completion decision that passes only when every required criterion does. It owns no execution, and `mode: 'shadow'` (the default) changes nothing. A session holds one task at a time; a message arriving after it ended opens the next contract.

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

Mount the plugin in a profile when a deployment needs a durable governance record or a completion gate. Mounted with no configuration it records in shadow mode under an `ask` default policy, which denies nothing because nothing is enforced. The shipped `web`, `headless`, `sdk`, and `acp` profiles mount it that way — kernel, builtin declarations, and the prompt-injection guard, all in `shadow` — so every session on those surfaces carries the durable record while no decision is binding yet; `@deepseek-ai/dsh-agent-governance` is the same plane as an opt-in bundle for other profiles.

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
| `maxPlanRevisions` | `32` | Plan revisions per task; a task that needs more is looping, and the next amendment is refused loudly |
| `untrustedContent` | `quarantine` | How a proposal whose tool declared `trust: 'untrusted'` is decided: `quarantine` caps the composed effect at `ask`, so a permission `allow` alone never authorizes external content, while `allow` leaves the document as the only authority |

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

Each admitted step opens a task contract: `task/created` carries the objective, constraints, acceptance criteria, workspace, profiles, and budget at `status: 'intake'`, `revision: 1`, and `task/transitioned` records each later move. Each tool call is recorded as one `action/decided` carrying the proposal, the rule decision, the composed authorization (and the capabilities it granted, and whether it refused the call), plus `action/committed`, which carries a governance receipt naming the sandbox mode, workspace root, the human outcome when one was asked for, and the one-action grants that ended with the settle. Each turn that ends on a task with a required criterion records `verification/requested`, `verification/result`, and, when the gate refuses completion, `failure/recorded` and `recovery/decided`. Each child agent carries a `delegation/received` receipt written into its own log at creation: the capabilities, writable scopes, budget, and depth its parent handed down, with an audit copy as `delegation/issued` on the parent log.

Four decisions are separate on purpose. The rules decide `allow`, `ask`, or `deny`; the implementation's sandbox may still refuse a mutating capability outside its boundary; a child agent's delegation receipt may still withhold a capability, resource, or depth its parent never granted; and an `ask` is decided by the composed approval answerers, where a missing answerer fails closed. A refusal is recorded as `outcome: 'denied'`, never as an execution failure.

### Reading a task

The public surface is `ctx.agentKernel`:

| Member | What it answers |
|---|---|
| `state.view(session)` | The current task contract, budget observation, open actions, unresolved failures, latest plan, latest checkpoint, and the delegation receipt when the agent is a child |
| `attach(agent)` | A handle whose `snapshot()` reads the live view and whose `dispose()` releases the kernel's reference |
| `capabilities.register(declaration)` | Declares one tool's capabilities, and optionally the trust of the content it acts on, and returns the disposer |
| `profiles.register(profile)` | Registers one agent role — its capability grant, policy profile, and ceilings — and returns the disposer |
| `registerPolicyProfileProvider(provider)` | Selects the session's policy layer, intersected with the deployment document, and returns the disposer |
| `verifiers.register(verifier)` | Supplies criterion results to the completion gate and returns the disposer |
| `verify(agent, changedScopes)` | Records a verification request and result and returns the completion decision |
| `checkpoint(agent, reason)` | Records an index of the current kernel state at the current session sequence |
| `recordEvidence(agent, input)` | Records one observation a claim may cite and returns it |
| `recordClaim(agent, input)` | Asserts one claim against observations this session recorded and returns it |
| `recordHypothesis(agent, input)` | Records one question a task is testing and returns it |
| `readKernelMetrics(events)` | Folds one session's kernel events into the counters this plane owns (tasks, verifications, actions, failures, recovery, checkpoints) |
| `startupRecovery` | The one-time read-only scan of stored sessions, with each non-terminal task classified as resumable, repairable, or blocked and the evidence reason |

Task state has no in-memory source of truth: the ledger folds `task/*`, `action/*`, `evidence/recorded`, `claim/updated`, `failure/recorded`, `verification/result`, `checkpoint/created`, `delegation/received`, `evidence/recorded`, `claim/updated`, `hypothesis/updated`, `step/start`, and `tool/call` events behind a per-session cursor, so replay reconstructs the same view. The process also exposes `startupRecovery`, a one-time read-only classification derived from persisted sessions; it never replaces the log.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the kernel learns what happened and where it intervenes; the observable behavior is fully covered in [Use this package](#use-this-package).

### Failed verification and repair

A task that reaches its configured step ceiling is not admitted another step: the kernel records a `step-ceiling` failure, classifies it as `checkpoint-pause`, and moves the task to `paused` once — a later step re-admits nothing and records no second failure. A turn the loop closed because the model reached its output limit (`turn/end` with a `max-tokens` reason) is likewise recorded as an `output-truncated` failure, detected on the step that follows the truncated turn because the end reason is appended after this kernel's turn-stopping listener ran. A tool the session calls a third time with the same arguments and the same result is a `no-progress` failure: the receipt records a digest of what each call returned, and once a run of two identical calls is complete the kernel records the failure — and, in `enforce` mode, refuses the third call with a reason telling the model to consolidate instead. The remaining S4 kinds (`tool-args-malformed`, `stalled`) are classified by the same table; their detectors belong to the packages that observe those seams.

A turn that ends with a failed verification records the failure, moves the task to `recovering`, and steers one repair message naming the gate's reasons, up to `Config.maxRepairAttempts` (default 3). Past the cap the task moves to `awaiting-user` with the same reasons, because a repair loop that cannot converge is a human decision. A later passing verification resolves the earlier `verification-failed` failure, so the passing result is what completion reads.

### Design philosophy

The kernel is built on four commitments:

- **Observe existing seams; own no execution.** Every integration point is a waterfall or event the loop already publishes: `agent/created`, `agent/pre-step`, `agent/turn-stopping`, `tools/pre-execute`, and `tools/post-execute`. No new loop, no second agent identity, no parallel dispatcher.
- **The session log is the only source of truth.** Every decision is appended before it is acted on, and every read is a fold over those events. A task contract, a decision, and a receipt all reconstruct from the log alone.
- **Shadow before enforce.** The default mode records what the kernel would decide and lets execution proceed, so a deployment measures a permission document against real traffic before it can stop any of it.
- **A refusal is not a failure.** Policy denial, sandbox refusal, and approval rejection are distinct failure vocabulary from a tool that ran and errored, and a denied action is never disguised as a tool failure.

### Where each decision is made

| Concern | Seam | Kernel action |
|---|---|---|
| Open or advance a task | `agent/pre-step` | Creates the contract on the first admitted step, then moves it to `executing` |
| Issue a delegation | `agent/created` | Writes the child's receipt into its own log and the audit copy into the parent log, before either has a task |
| Decide an action | `tools/pre-execute` | Evaluates the document, composes the sandbox and the delegation receipt, and appends one `action/decided` carrying the proposal, the rule decision, the authorization, and its grants |
| Enforce an action | `tools/pre-execute` return | `deny` blocks the call, `ask` routes through the composed answerers; shadow mode always delegates |
| Observe an action | `tools/post-execute` | Appends `action/committed` with its governance receipt |
| Close a turn | `agent/turn-stopping` | Records the observation edge, then runs the completion gate over a required criterion |
| Read state | any caller | Folds the session log through a per-session cursor |

### The state machine

`state-machine.ts` owns the legal edge table and the status list itself, and `TaskClass` owns what a task of each kind starts from: `conversational` (the default) answers without an acceptance criterion and completes at turn end, while `coding`, `research`, and `operations` take the criteria their deployment configured for the class and are held to a criterion only when `requireAcceptanceCriteriaByClass` says so. The class is chosen from the caller's own statement, else the role the task runs under, else the mutation heuristic: a task that follows one which proposed a file-mutating tool is coding work. A task the class exempts from criteria completes without a verification pair, because there is nothing to verify. Every status has a producer: `intake` at task creation, `planning` while plan mode is entered, `ready` at first-step admission, `executing` and `observing` around each step, `verifying` at turn end, `recovering` when recovery starts, `awaiting-approval` from the approval linkage, `paused` from a budget or liveness stop, and the terminal three from the completion gate or a cancellation. The kernel's own driver takes `intake → ready` directly when plan mode is not entered, and records `step-admitted` as the trigger. `awaiting-approval`, `awaiting-user`, `paused`, and `cancelled` are reachable from every non-terminal state, and terminal states have no outgoing edge. `applyTransition()` enforces the compare-and-set the kernel promises: a transition must belong to the task, start from its current status, and cite its current revision, or it throws before anything is appended.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the service, and the waterfall and event listeners |
| [`src/types.ts`](src/types.ts) | Every kernel contract and the `SessionEventMap` merge for the durable event families |
| [`src/state-machine.ts`](src/state-machine.ts) | Legal task edges, the edge assertion, and the compare-and-set projection |
| [`src/policy.ts`](src/policy.ts) | Glob compilation, rule evaluation, admitted-capability computation, and sandbox and delegation composition |
| [`src/delegation.ts`](src/delegation.ts) | Delegation receipts, the writable-scope narrowing, and the intersection refusal |
| [`src/capabilities.ts`](src/capabilities.ts) | The tool capability registry |
| [`src/verification.ts`](src/verification.ts) | The completion gate and the local criterion-verifier registry |
| [`src/recovery.ts`](src/recovery.ts) | The failure-kind to recovery-action table and its retry bound |
| [`src/recovery-scan.ts`](src/recovery-scan.ts) | The read-only scan over persisted sessions and its resumable/repairable/blocked classifications |
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

- **Built-in tools are declared by a separate opt-in plugin** — mount `@deepseek-ai/dsh-agent-kernel-builtins` beside the kernel so `mode: 'enforce'` governs real traffic. The declarations live outside the tool packages because only the policy plane may extend the capability vocabulary. A deployment that renames a tool, mints `mcp__*` or `structured_output` names, or ships its own tools declares those itself; an undeclared tool stays denied.
- **Enforcing mode denies everything undeclared, by design** — a deployment that turns on `enforce` without the builtins plugin stops every tool call. Mount in `shadow` first and read the `action/denied` records.
- **No shipped criterion verifier** — `verifiers.register()` is the seam, and a task that declares a required criterion with no verifier registered records an `unknown` verification and never completes. Commands, builds, and diffs are not run by this package.
- **Token and cost ceilings are reported, not measured** — `budget.maxTokens` and `budget.maxCostUsd` appear unbounded in every budget snapshot because the token meter owns that measurement; `guard/budgets` remains their enforcement listener.
- **Retry attempts count proposals, not executions** — `maxAttemptsPerAction` compares against the number of `action/decided` records under one action id, so a provider-level retry that never re-proposes does not advance the count.
- **Startup recovery classifies; it does not resume.** Once `sessionPersistence` is available, the kernel opens every listed session through the backend, which resolves its current generation. Sessions with no task or a terminal task are excluded; an open turn or a recovery decision awaiting its required checkpoint is repairable; per-session open/read failures are blocked. A listing failure rejects the scan. `dsh task recover-scan` prints the same result.
- **`planning` is entered by two producers** — plan mode (`recordPlanMode`, which the plan-mode plugin calls after it records the mode) and the first recorded plan revision. A task with neither moves `intake → ready → executing → observing`.
- **The mutation heuristic reads tool declarations, not paths** — a task that follows one proposing an `fs.write`/`fs.edit` tool is classed `coding`; the kernel does not inspect which paths the tool actually touched.
- **Budgets report measured token spend; cost stays unreported** — `maxTokens` remaining is the ceiling minus the session's billed tokens, derived from the same per-turn provider totals the token meter owns (`deriveSessionTokenSpend`). A ceiling the provider never reported usage for reads as unspent, and `maxCostUsd` needs a price source this package does not own, so it stays absent and `guard/budgets` keeps enforcing it.
- **Verifier cost control is partial** — the registry orders criteria by verifier family (assertion, diff, human, research, build, test), stops at the first failed required criterion, fails a verifier that overruns `verifierTimeoutMs`, and the gate skips re-verification when the turn changed no scope since a pass of the same task. Caching a `CriterionResult` by criterion id and repository digest is not implemented.
- **Class criteria are deployment-owned** — the kernel records the criteria `Config.acceptanceByClass` supplies for a class. Deriving a workspace's typecheck, lint, and test commands from its manifests is not implemented; a deployment that wants them declares them.
- **A delegation receipt is only as strict as the document it was issued under** — the receipt intersects capabilities, writable scopes, budget, and depth, but per-resource exactness still comes from the child's own rule evaluation against the same document. A child whose deployment document changed since the receipt was issued runs under the new rules while the receipt still names the old digest; `inheritedPolicyDigest` is how a reader tells.
- **A cold child falls back to the deployment ceilings** — when the parent session does not resolve, the receipt records no parent run or task and the child contract starts from the deployment budgets. A resumed child keeps the receipt already in its log instead of receiving a second one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The kernel is the P0 slice of the [evolutionary agent runtime specification](../../../specs/SPEC-EVOLUTIONARY-AGENT-RUNTIME.md). Two deviations from that specification's literal text are deliberate. First, the kernel creates its task contract at the first admitted step rather than at `agent/session-start`, because the objective is only knowable once a step claims the human message, and because a session-start append would land outside an open turn. Second, `ContextCompiler`, the evidence/claim/hypothesis graph, the model router, workflow checkpointing, and evolution promotion gates are later phases and are not represented here at all.

</details>
