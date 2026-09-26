---
description: "Agent kernel: one durable task contract per session, an action ledger over the tool pipeline, a capability permission engine, and a completion gate, for users and maintainers governing what the harness allows and records."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-kernel

English | [中文](README.zh.md)

## Summary

Use `dsh-agent-kernel` when a deployment must answer, from durable evidence, what a task was for, what the harness allowed, and why it stopped. It records a durable task contract per session, one decision record per tool call, a per-step control decision, and a completion gate that passes only when every required criterion does. It owns no execution, `mode: 'shadow'` (the default) changes nothing, and a session holds one task at a time. Skip it when a trusted tool surface and the session log answer those questions: it adds one audit record per tool call.

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
| `budgets` | `{}` | Ceilings every created task contract starts with; an unset field is unbounded. `maxConcurrentActions` bounds the actions one task may have in flight |
| `policy` | `{ defaults: { effect: ask }, rules: [] }` | The permission document; see [Policy rules](#policy-rules) |
| `acceptance` | `[]` | Criteria every created task contract starts with, for every class no `acceptanceByClass` entry names; without a required one the kernel runs no verification |
| `acceptanceByClass` | shipped per class | Criteria a task of one class starts from, replacing both `acceptance` and the shipped default for that class. The shipped defaults are `coding`: `typecheck`, `lint`, `test`, and `diff`; `research`: one citation criterion; `conversational` and `operations`: none. Mapping a criterion id or family to a command is the verifier package's configuration |
| `outputTruncatedRetryTokens` | `16000` | Output-token limit the step after a truncated turn is requested under, recorded in the request header the loop logs. The retry is granted once per truncation; a retry that truncates again steers the model to split its work instead |
| `verificationCacheSize` | `256` | Criterion results retained, keyed by criterion id and repository digest |
| `verificationCacheTtlMs` | `600000` | Milliseconds a retained criterion result stays reusable |
| `requireAcceptanceCriteria` | `false` | Whether a task with no criterion may complete at all |
| `allowHumanOnlyCompletion` | `false` | Whether a task whose only passing evidence is human-reported may complete |
| `maxAttemptsPerAction` | `2` | Retry cap the recovery engine reports attempts remaining against |
| `checkpointBeforeRetry` | `true` | Whether a retry is recorded as needing a checkpoint first |
| `maxPlanRevisions` | `32` | Plan revisions per task; a task that needs more is looping, and the next amendment is refused loudly |
| `untrustedContent` | `quarantine` | How a proposal whose tool declared `trust: 'untrusted'` is decided: `quarantine` caps the composed effect at `ask`, so a permission `allow` alone never authorizes external content, while `allow` leaves the document as the only authority |
| `loopOscillationRun` | `4` | Calls alternating between two tools at which the governor reads the run as oscillating and answers `stop_loop` |
| `loopSemanticDuplicateRun` | `3` | Consecutive near-duplicate call pairs at which it reads the run as repeating one intent with different words |
| `loopSemanticSimilarity` | `0.8` | Argument token overlap, in `(0, 1]`, at which two calls by one tool count as one intent |
| `loopStagnantStepRun` | `3` | Consecutive steps that moved nothing on any `StepDelta` axis at which the run is a no-progress loop |
| `loopNarrationStepRun` | `3` | Consecutive steps with no tool call and no state change at which the run is a narration-only loop |
| `loopFailureRun` | `3` | Recordings of one unresolved failure kind at which the run is a failure loop |
| `contextPressureRatio` | `0.8` | Share of the task's `budgets.maxTokens` ceiling at which the governor asks for compaction |
| `livenessWindowMs` | `180000` | Milliseconds without progress and without activity after which the liveness monitor records a `stalled` failure |
| `codingLifecycle` | all nine phases, no ceilings, review off | The §10.5 pipeline a task of class `coding` runs: `phases` (must start at `understand` and end at `complete`), `budgets` (a positive step ceiling per phase, counted from that phase's latest entry), and `review` (`enabled` and the diff `ref` the independent reviewer inspects). A phase left out of `phases` is skipped, REVIEW is skipped while `review.enabled` is false, and a task of any other class runs no pipeline |

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

Each admitted step opens a task contract: `task/created` carries the objective, constraints, acceptance criteria, the change contract the caller declared, workspace, profiles, and budget at `status: 'intake'`, `revision: 1`, and `task/transitioned` records each later move. Each tool call is recorded as one `action/decided` carrying the proposal, the rule decision, the composed authorization (and the capabilities it granted, and whether it refused the call), plus `action/committed`, which carries a governance receipt naming the sandbox mode, workspace root, the human outcome when one was asked for, and the one-action grants that ended with the settle. Each step boundary records one `governor/decided` carrying the decision, its reasons, the movement the step that just ended made, and the normalized progress score. Each turn that ends on a task with a required criterion records `verification/requested`, `verification/result`, and, when the gate refuses completion, `failure/recorded` and `recovery/decided`. Each child agent carries a `delegation/received` receipt written into its own log at creation: the capabilities, writable scopes, budget, and depth its parent handed down, with an audit copy as `delegation/issued` on the parent log.

Four decisions are separate on purpose. The rules decide `allow`, `ask`, or `deny`; the implementation's sandbox may still refuse a mutating capability outside its boundary; a child agent's delegation receipt may still withhold a capability, resource, or depth its parent never granted; and an `ask` is decided by the composed approval answerers, where a missing answerer fails closed. A refusal is recorded as `outcome: 'denied'`, never as an execution failure.

A budget is a pot the parent and its children share, not a copy each child receives. A delegation hands down what the parent can still promise — its measured remaining allowance less the holds its in-flight children placed and the spend its settled children reported — and the kernel holds that grant until the child settles: a child that ran is debited by the steps, tool calls, tokens, and wall-clock it used, and one that never opened a task releases its hold. A call that would put more actions in flight than `maxConcurrentActions` allows is composed as a denial naming the count, so the ceiling is recorded on the action rather than guessed from the model's behavior.

### Reading a task

The public surface is `ctx.agentKernel`:

| Member | What it answers |
|---|---|
| `state.view(session)` | The current task contract, budget observation, open actions, unresolved failures, latest plan, latest checkpoint, and the delegation receipt when the agent is a child |
| `viewOf(sessionId)` | The live agent's current kernel view, or undefined when no live agent or task is registered for that identity |
| `attach(agent)` | A handle whose `snapshot()` reads the live view and whose `dispose()` releases the kernel's reference; plugin unload awaits every open attachment |
| `capabilities.register(declaration)` | Declares one tool's capabilities, and optionally the trust of the content it acts on, and returns the disposer |
| `profiles.register(profile)` | Registers one agent role — its capability grant, policy profile, and ceilings — and returns the disposer |
| `registerPolicyProfileProvider(provider)` | Selects the session's policy layer, intersected with the deployment document, and returns the disposer |
| `verifiers.register(verifier)` | Supplies criterion results to the completion gate and returns the disposer |
| `lifecycle.registerReviewer(reviewer)` | Supplies the §10.5 REVIEW phase's independent reviewer and returns the disposer; `lifecycle.current(session)` reads the phase a task is in, `lifecycle.advance(session, phase)` records it, and `lifecycle.completionPredicate(session)` reports the phases a task recorded |
| `verify(agent, changedScopes)` | Records a verification request and result and returns the completion decision |
| `checkpoint(agent, reason)` | Records an index of the current kernel state at the current session sequence |
| `recordEvidence(agent, input)` | Records one observation a claim may cite and returns it |
| `recordClaim(agent, input)` | Asserts one claim against observations this session recorded and returns it |
| `recordHypothesis(agent, input)` | Records one question a task is testing and returns it |
| `readKernelMetrics(events)` | Folds one session's kernel events into the counters this plane owns (tasks, verifications, actions, failures, recovery, checkpoints) |
| `budgets.measure(task, session)` / `budgets.available(session)` | One task's measured spend and remaining allowance, and what its session can still promise once the holds its in-flight children placed and the spend they settled with are subtracted. The observation also carries `background`, what the background budget owner (`ctx.evolutionBudget`, when the profile mounts one) has spent, read beside the session's own use and debiting none of it: `guard/budgets` still enforces the in-session ceilings and the background owner still gates its own spend |
| `budgets.reserve(session, amount, runId?)` | Holds part of a session's allowance for work about to run, capped at what it has available, and returns the hold |
| `budgets.commit(reservationId, actual?)` / `budgets.release(reservationId)` | Settles a hold with what the work spent, or ends it because the work never ran |
| `startupRecovery` | The one-time read-only scan of stored sessions, with each non-terminal task classified as resumable, repairable, or blocked and the evidence reason |

Task state has no in-memory source of truth: the ledger folds `task/*`, `action/*`, `evidence/recorded`, `claim/updated`, `failure/recorded`, `verification/result`, `checkpoint/created`, `delegation/received`, `evidence/recorded`, `claim/updated`, `hypothesis/updated`, `step/start`, and `tool/call` events behind a per-session cursor, so replay reconstructs the same view. The process also exposes `startupRecovery`, a one-time read-only classification derived from persisted sessions; it never replaces the log.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the kernel learns what happened and where it intervenes; the observable behavior is fully covered in [Use this package](#use-this-package).

### Failed verification and repair

A task that reaches its configured step ceiling is granted one final step with no tools: the kernel records a `step-ceiling` failure, classifies it as `checkpoint-pause`, admits that step, and composes every call in it as a denial — the model answers from the results it already has — then the turn that step belongs to records the `before-pause` checkpoint and moves the task to `paused`. A step proposed after that is refused rather than admitted, and the failure is recorded once per task. A turn the loop closed because the model reached its output limit (`turn/end` with a `max-tokens` reason) is recorded as an `output-truncated` failure on the step that follows it, because the end reason is appended after this kernel's turn-stopping listener ran; that step's request is retried once under `Config.outputTruncatedRetryTokens`, and a retry that also truncates steers the model to split its work instead of raising the limit again. A turn that ends for any other reason answers the failure, so it no longer blocks completion. A tool call the registry rejected before any approval — a schema or JSON violation, reported as `INVALID_ARGS` — is recorded as `tool-args-malformed` from the outcome that reached the model, so the parse or schema error is what the model is answered with and no approval prompt is shown. A tool the session calls a third time with the same arguments and the same result is a `no-progress` failure: the receipt records a digest of what each call returned, and once a run of two identical calls is complete the kernel records the failure — and, in `enforce` mode, refuses the third call with a reason telling the model to consolidate instead. The kernel's own liveness monitor records `stalled` (see [Governor](#governor)).

A turn that ends with a failed verification records the failure, moves the task to `recovering`, and steers one repair message naming the gate's reasons, up to `Config.maxRepairAttempts` (default 3). Past the cap the task moves to `awaiting-user` with the same reasons, because a repair loop that cannot converge is a human decision. A later passing verification resolves the earlier `verification-failed` failure, so the passing result is what completion reads. The §8.5 regression leg makes the same check in the other direction: a criterion an earlier verification of the task passed and this one no longer does is recorded as `verification-regressed`, named in the repair message, and counted against the same `Config.maxRepairAttempts`, and because the leg compares only results the registry already produced — a criterion the result cache answered for the current repository digest is served from it — it never runs a verifier twice.

### Coding lifecycle (§10.5)

A task of class `coding` runs one recorded pipeline — UNDERSTAND → MAP → PLAN → CONTRACT → IMPLEMENT → LOCAL VERIFY → REVIEW → REGRESSION → COMPLETE — and each entry is a `task/phase` event, so the pipeline a task traversed reconstructs from its own log. `Config.codingLifecycle` decides which phases run (`phases`), the step ceiling of each (`budgets`, counted from that phase's latest entry), and whether the REVIEW phase spawns an independent reviewer (`review.enabled`, off by default). A phase left out of `phases` is skipped, and REVIEW is skipped the same way while the reviewer is switched off, because a phase whose implementer does not run is one the task does not traverse; a task of any other class runs no pipeline, and a conversational task completes as before.

The kernel drives that pipeline from the seams it already owns: an admitted step records MAP (after UNDERSTAND), a recorded plan revision records PLAN, the first settled `fs.write` or `fs.edit` action records CONTRACT and IMPLEMENT, the turn's end records LOCAL VERIFY, and a passing check runs REVIEW, REGRESSION, and COMPLETE. A failed LOCAL VERIFY, REVIEW, or REGRESSION takes the repair edge back to IMPLEMENT through the same failure, recovery decision, and single repair steer `Config.maxRepairAttempts` bounds, so a failing check is one repair rather than a loop; a phase that reached its step ceiling is not entered again, and the task moves to `awaiting-user`. The `completed` transition carries a `lifecycle-phases` precondition naming the phases the task recorded.

REVIEW runs the registered independent reviewer once per REVIEW entry, records its structured report as `task/review`, and routes its findings back into work the same way a failed check does. With `review.enabled` on and no reviewer registered the task never completes silently: the kernel records the misconfiguration and moves the task to `awaiting-user`.

### Governor

Every step boundary composes one control decision before the step runs. `composeGovernorDecision` reads the facts in this order, and the first that applies wins: a terminal task answers `stop_success` or `stop_failure`; a stall the liveness monitor reported answers `stop_timeout`; an exhausted spend ceiling (`maxSteps`, `maxToolCalls`, `maxTokens`, `maxWallMs`, or `maxCostUsd` as the snapshot's remaining allowance reports it) answers `stop_budget`; a loop detector answers `stop_loop`; reaching `contextPressureRatio` of the task's `maxTokens` answers `compact`; the newest unresolved failure answers whatever recovery the engine already decided for it — `retry`, `replan`, `compact`, `delegate`, `ask_user`, or a stop; and everything else answers `continue`. The decision is appended as `governor/decided` before it is acted on. Only the five `stop_*` decisions change behavior, and only in `mode: 'enforce'`: the kernel refuses `agent/pre-step`, which ends the turn as blocked and parks pending input for the next wake instead of discarding it.

The progress monitor measures each step as a `StepDelta`: the share of its tool calls whose tool and arguments the recent call history had not seen, whether the task advanced a revision, whether it recorded an observation or a claim, whether the session's goal moved, whether unresolved failures fell, and whether it recorded a plan revision. `progressScore` is their mean, so one step that called a novel tool and one that recorded evidence both score a fraction.

Five detectors read the same state. Oscillation is the trailing run of calls that alternate between two tools (A-B-A-B). A semantic duplicate is a call whose tool matches its predecessor's and whose arguments are at least `loopSemanticSimilarity` alike without being identical. Stagnation is a run of steps whose score stayed 0, and narration is a run of steps that called no tool and moved nothing. A failure loop is one unresolved kind recorded `loopFailureRun` times. The first detector that fires records one `no-progress` failure per episode — the episode ends when a step moves something, which is what resolves it, exactly as a new plan revision resolves plan drift.

The liveness monitor stamps `lastFrameAt` on each model frame, `lastToolEventAt` on each tool call proposed or settled, and `lastProgressAt` on each step that moved something. A quarter of `livenessWindowMs` after the last check it looks for a session whose agent is running, whose task expects progress on its own, and whose progress and activity are both older than the window, and records one `stalled` failure per quiet episode classified by what was in flight: `tool` for a call that never settled, `transport` for a request that produced no frame, `stream` for one that stopped producing frames, `child-agent` for a delegated child, and `agent` for a run with nothing in flight. A later step that moves something clears the stall, so the next decision no longer answers it.

### Automatic checkpoints (§17.1)

`checkpoint(agent, reason)` is also called automatically, so a resume never replays past a point the kernel already indexed: every turn boundary (`'turn-boundary'`, before the observed transition), the step-ceiling pause above (`'before-pause'`, before the `paused` transition), a `compaction/start` event (`'before-compaction'`, deferred one microtask past the session's own append-reentrancy boundary), a verification failure (`'verification-failure'`, before the repair steer), and an authorized call declaring `subagent.spawn` or `workflow.start` (`'before-suspension'`, before the call runs — a spawned child or workflow can run long enough to suspend the parent step). Every automatic checkpoint runs whether or not `mode` enforces, matching how `action/decided` is always recorded.

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
| Compose the step's control decision | `agent/pre-step` | Appends one `governor/decided` after admitting the step, and refuses the step for a `stop_*` decision in `enforce` mode |
| Watch a run for a stall | a timer at a quarter of `livenessWindowMs` | Records one `stalled` failure per quiet episode, classified by what was in flight |
| Issue a delegation | `agent/created` | Writes the child's receipt into its own log and the audit copy into the parent log, before either has a task |
| Decide an action | `tools/pre-execute` | Evaluates the document, composes the sandbox and the delegation receipt, and appends one `action/decided` carrying the proposal, the rule decision, the authorization, and its grants |
| Enforce an action | `tools/pre-execute` return | `deny` blocks the call, `ask` routes through the composed answerers; shadow mode always delegates |
| Observe an action | `tools/post-execute` | Appends `action/committed` with its governance receipt |
| Close a turn | `agent/turn-stopping` | Records the observation edge, then runs the completion gate over a required criterion |
| Record the coding pipeline | `agent/pre-step`, a plan revision, `tools/post-execute`, `agent/turn-stopping` | Records MAP and UNDERSTAND on an admitted step, PLAN on a plan revision, CONTRACT and IMPLEMENT on a settled `fs.write`/`fs.edit`, then LOCAL VERIFY, REVIEW, REGRESSION, and COMPLETE as the turn's check settles |
| Repair a failed check | `agent/turn-stopping` | Records the return to IMPLEMENT beside the repair steer |
| Read state | any caller | Folds the session log through a per-session cursor |

### The state machine

`state-machine.ts` owns the legal edge table and the status list itself, and `TaskClass` owns what a task of each kind starts from: `conversational` (the default) answers without an acceptance criterion and completes at turn end, while `coding`, `research`, and `operations` start from the criteria their deployment configured for the class, else the deployment's global list, else the shipped default — `coding` from `typecheck`, `lint`, `test`, and `diff`, `research` from a citation criterion — and are held to a criterion only when `requireAcceptanceCriteriaByClass` says so. The class is chosen from the caller's own statement, else the role the task runs under, else the mutation heuristic: a task that follows one which proposed a file-mutating tool is coding work. A task the class exempts from criteria completes without a verification pair, because there is nothing to verify. Every status has a producer: `intake` at task creation, `planning` while plan mode is entered, `ready` at first-step admission, `executing` and `observing` around each step, `verifying` at turn end, `recovering` when recovery starts, `awaiting-approval` from the approval linkage, `paused` from a budget or liveness stop, and the terminal three from the completion gate or a cancellation. The kernel's own driver takes `intake → ready` directly when plan mode is not entered, and records `step-admitted` as the trigger. `awaiting-approval`, `awaiting-user`, `paused`, and `cancelled` are reachable from every non-terminal state, and terminal states have no outgoing edge. `applyTransition()` enforces the compare-and-set the kernel promises: a transition must belong to the task, start from its current status, and cite its current revision, or it throws before anything is appended.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the service, and the waterfall and event listeners |
| [`src/types.ts`](src/types.ts) | Every kernel contract and the `SessionEventMap` merge for the durable event families |
| [`src/state-machine.ts`](src/state-machine.ts) | Legal task edges, the edge assertion, and the compare-and-set projection |
| [`src/governor.ts`](src/governor.ts) | The progress monitor, the loop detectors, the liveness monitor, and the per-step decision they compose |
| [`src/policy.ts`](src/policy.ts) | Glob compilation, rule evaluation, admitted-capability computation, and sandbox and delegation composition |
| [`src/delegation.ts`](src/delegation.ts) | Delegation receipts, the writable-scope narrowing, and the intersection refusal |
| [`src/capabilities.ts`](src/capabilities.ts) | The tool capability registry |
| [`src/verification.ts`](src/verification.ts) | The completion gate and the local criterion-verifier registry |
| [`src/recovery.ts`](src/recovery.ts) | The failure-kind to recovery-action table and its retry bound |
| [`src/recovery-scan.ts`](src/recovery-scan.ts) | The read-only scan over persisted sessions and its resumable/repairable/blocked classifications |
| [`src/coding-lifecycle.ts`](src/coding-lifecycle.ts) | The §10.5 phase machine, its validated configuration and step ceilings, the phase log, and the independent-reviewer port |
| [`src/ledger.ts`](src/ledger.ts) | The cursor-based fold, the budget observation, and the reservation holds a session places on its own allowance |
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

No prompt section and no tool schema is added. Exactly one conditional model-visible effect exists: in `enforce` mode, a denied call returns a tool error whose text begins `agent-kernel denied "<tool>": ` followed by the decision's reasons, and an `ask` returns the registry's own approval-driven denial when no answerer grants it. A call refused for exceeding the task's `maxConcurrentActions` ceiling reads the same way, with a reason naming the actions already in flight. A `stop_*` governor decision refuses the step before its request is built, so the model receives nothing for it: the turn ends as blocked and the next pending message waits for a later wake. In `shadow` mode the model sees nothing the kernel decided, because the action runs unchanged.

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
- **Budgets report measured token spend; cost stays unreported** — `maxTokens` remaining is the ceiling minus the session's billed tokens, derived from the same per-turn provider totals the token meter owns (`deriveSessionTokenSpend`). A ceiling the provider never reported usage for reads as unspent, and `maxCostUsd` needs a price source this package does not own, so it stays absent and `guard/budgets` keeps enforcing it. `maxConcurrentActions` is reported as configured rather than decremented: a slot in flight frees when its action settles, and the ceiling is composed into the action's decision, so it refuses a call in `enforce` mode and is recorded as a shadow denial in `shadow` mode.
- **Verifier cost control is partial** — the registry orders criteria by verifier family (assertion, diff, human, research, typecheck, lint, build, test, security, browser, review), stops at the first failed required criterion, fails a verifier that overruns `verifierTimeoutMs`, retains each `CriterionResult` by criterion id and repository digest under `verificationCacheSize`/`verificationCacheTtlMs`, and the gate skips re-verification when the turn changed no scope since a pass of the same task. The digest is the git tree id of the turn's end state, or the recorded change list when the recorder took no snapshot; a deployment whose workspace-changes recorder publishes no summary for the turn gets a per-pass digest, because this package cannot name the repository state a verifier read and will not answer one state's result for another's.
- **Class criteria are deployment-owned** — the kernel records the criteria `Config.acceptanceByClass` supplies for a class, else the deployment's `acceptance` list, else the shipped default for the class. Deriving a workspace's typecheck, lint, and test commands from its manifests is not implemented; a deployment declares the commands that answer the shipped criterion ids (`typecheck`, `lint`, `test`, `diff`) through its verifier package, and an id no verifier claims leaves the task incomplete.
- **The coding lifecycle's phases are positions, not producers** — MAP, PLAN, CONTRACT, IMPLEMENT, and REGRESSION record where a coding task stands; the repository map, the plan revision, the change contract, and the criteria the gate verifies are recorded by the packages that own them, and this pipeline restates none of them.
- **The independent reviewer is deployment-supplied** — the REVIEW phase runs only when `Config.codingLifecycle.review.enabled` is set and a mounted package registered an `IndependentReviewer`; with the review enabled and none registered, the task records the misconfiguration and moves to `awaiting-user` rather than completing without a review.
- **A delegation receipt is only as strict as the document it was issued under** — the receipt intersects capabilities, writable scopes, budget, and depth, but per-resource exactness still comes from the child's own rule evaluation against the same document. A child whose deployment document changed since the receipt was issued runs under the new rules while the receipt still names the old digest; `inheritedPolicyDigest` is how a reader tells.
- **A cold child falls back to the deployment ceilings** — when the parent session does not resolve, the receipt records no parent run or task and the child contract starts from the deployment budgets. A resumed child keeps the receipt already in its log instead of receiving a second one.
- **A reservation is live state, and its settlement is too** — holds bound what a session can promise while its children run, and a restart has no child in flight to hold for, so neither the holds nor the debits they became survive it; the durable record of what a parent handed down is its `delegation/issued` receipt and each child's own spend is measured in that child's session. Nothing reconciles the two after a restart.
- **The liveness monitor records; it does not abort a request already in flight** — a stalled step is reported, and in `enforce` mode the run refuses its next step, but the kernel holds no cancellation for the request the loop has already awaited, so a hung call still ends through its own tool deadline or the provider's timeout before the refusal takes effect.
- **Loop and stall failures resolve on the next step that moves something** — a run that never moves again keeps them unresolved, and the completion gate refuses completion while they stand, as it does for an unresolved failure of any other kind.
- **The governor's state is process-local** — the recent call history, the liveness stamps, and the step counters start fresh after a restart, so a resumed process runs its own window before it reports a stall or a loop. The durable record of either is the failure and the `governor/decided` record that answered it.
- **Concurrent children share one pot first-come** — a child inherits the parent's available allowance, so a child created while its siblings hold the whole allowance starts from the remainder, which can be zero when every axis the parent bounds is held. A deployment that runs children in parallel on a bounded parent reserves a slice per child before creating it; a parent whose `budgets` are unset bounds nothing, so it holds nothing and starves no child.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The kernel is the P0 slice of the [evolutionary agent runtime specification](../../../specs/SPEC-EVOLUTIONARY-AGENT-RUNTIME.md). Two deviations from that specification's literal text are deliberate. First, the kernel creates its task contract at the first admitted step rather than at `agent/session-start`, because the objective is only knowable once a step claims the human message, and because a session-start append would land outside an open turn. Second, `ContextCompiler`, the evidence/claim/hypothesis graph, the model router, workflow checkpointing, and evolution promotion gates are later phases and are not represented here at all.

</details>
