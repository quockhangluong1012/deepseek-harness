# Agent kernel

English | [中文](agent-kernel.zh.md)

The control plane owned by [`@deepseek-ai/dsh-agent-kernel`](../../packages/runtime/agent-kernel/README.md). The kernel observes the agent and tool seams `core/agent-loop` and `core/tools` already publish, derives one durable task contract per session from the session log, records a proposal and a composed decision for every tool call, and decides completion against the task's own acceptance criteria. It owns no execution: the loop keeps turn and step ownership, the tool registry keeps dispatch, [`sandbox-policy`](sandbox.md) keeps the file boundary, and [`user-approval`](approval.md) keeps the human decision. Declarations live in [`packages/runtime/agent-kernel/src/types.ts`](../../packages/runtime/agent-kernel/src/types.ts); the package README defines configuration and the records a session receives.

## Task contract

A task is a projection of `task/*` events, never an in-memory singleton. `TaskId` and `RunId` are [branded ids](core.md#branded-ids); `ActionId` is the tool call's own `ToolCallId` under a second brand, so a proposal, its decisions, and its receipt correlate without a second identifier.

`TaskContract` carries the objective, its constraints, its acceptance criteria, the workspace its file policy is bounded to, the agent and policy profiles, the resource budget, the current `TaskStatus`, and a positive `revision` that every accepted transition increments. `TaskStatus` is the closed union `intake | understanding | retrieving | planning | ready | executing | observing | verifying | recovering | awaiting-approval | awaiting-user | paused | completed | failed | cancelled`; `intake`, `understanding`, `retrieving`, and `planning` exist for a planner the kernel does not ship, and it drives `intake → ready → executing → observing` itself.

`StateTransition` is the durable record of one accepted move: the transition identity, the task, the `from` and `to` statuses, the `TransitionTrigger`, the evaluated `preconditions`, the committed `effects`, the task revision it was evaluated against, the revision it produced, an optional authorizing `policyDecisionId`, the `actor`, and the timestamp. `applyTransition()` in [`src/state-machine.ts`](../../packages/runtime/agent-kernel/src/state-machine.ts) rejects a transition that belongs to another task, starts from a stale status, or cites a stale revision.

## Action ledger

Each tool call produces a proposal, a rule decision, a composed authorization, an optional capability grant, and a receipt.

`ActionProposal` names the action, the agent, the tool call, the registered tool, the frozen parsed arguments, the proposal source (`model`, `workflow`, `subagent`, or `user`), the task revision, and a `TrustLabel`. `PolicyContext` adds the tool's declared `CapabilityRequest` list, whether the tool declared nothing, the delegation receipt when the acting agent is a child, and the resolved technical boundary.

`PolicyDecision` is what the permission document decided: the `effect`, the index of the winning rule or `null` for the default, the capability requests the winning rule matched, and the reasons in evaluation order. `AuthorizationDecision` is the composed runtime answer: the intersected `effect`, the decision it composes, the granted `Capability` list, the `SandboxExecutionPolicy` the action executes under, whether the kernel acted on the decision (`enforced`), the delegation the action ran under when the agent is a child, and the composed reasons. `ActionReceipt` settles the action with `succeeded`, `failed`, or `denied` and an optional `GovernanceReceipt` linking the policy decision, the sandbox mode and workspace root, the human outcome when one was recorded, and who resolved it (`user`, `policy`, or `none`).

## Permission document

`PolicyDocument` is a default `effect` plus an ordered `PolicyRule` list; each rule selects a `PolicyAction` family and a resource glob and decides `allow`, `ask`, or `deny`. `POLICY_ACTIONS` and `POLICY_EFFECTS` in [`src/policy.ts`](../../packages/runtime/agent-kernel/src/policy.ts) are the accepted vocabularies, and `compilePolicy()` rejects an unknown action, an unknown effect, or an empty resource before any action is evaluated. `Capability` is the grant vocabulary — `fs.read`, `fs.write`, `fs.edit`, `process.exec`, `terminal.interactive`, `network.read`, `network.write`, `mcp.call`, `memory.read`, `memory.write`, `subagent.spawn`, `workflow.start`, `approval.request`, and `policy.propose` — and `CapabilityDeclaration` maps one registered tool to the capabilities each invocation needs plus a pure projection from its arguments to the resource they apply to.

## Delegation

`DelegationReceipt` is the authority one parent run hands to one child run: the receipt identity, the child run, the parent run and task when the parent session resolved, the durable parent session, the allowed capabilities, the inherited resource limits, the writable scopes, the digest of the permission document the grant was computed under, the depth, the deepest admitted depth, and the timestamp. The kernel writes it into the child's own log at `agent/created`, before either side has a task, with an audit copy as `delegation/issued` on the parent log; a resumed child keeps the receipt already in its log instead of receiving a second one.

Child authority is the intersection of the receipt with the child's profile, the deployment rules, and the child's own sandbox: [`src/delegation.ts`](../../packages/runtime/agent-kernel/src/delegation.ts) refuses a capability the receipt withholds, a filesystem mutation outside its writable scopes narrowed against the child's boundary, and every action past the parent's depth cap. The child task contract keeps the receipt's run identity, names the parent task, and starts from the parent's remaining budget.

## Built-in declarations

The kernel registry starts empty and fails closed. [`@deepseek-ai/dsh-agent-kernel-builtins`](../../packages/runtime/agent-kernel-builtins/README.md) is the opt-in plugin that declares every shipped product tool — the capabilities one invocation needs and a total, never-empty projection from its arguments to the resource they apply to — registering them once the injected `agentKernel` service exists, in any mount order. A spec re-derives the tool inventory from the generated [tool catalog](../tool-catalog.md) and fails when a shipped name has no declaration, so a new tool cannot arrive undeclared.

## Verification, failure, and recovery

`VerificationRequest` carries the task, the exact revision the criteria were read from, those criteria, and the changed scopes. `VerificationResult` aggregates per-criterion `CriterionResult` records into `pass`, `fail`, or `unknown`, with the commands the verifiers ran and the verifier version. `CompletionDecision` is the gate's answer: completion is allowed only when every required criterion passed, no unresolved failure remains, and no configured ceiling is exhausted.

`FailureKind` is the shared classification — `model-auth`, `model-rate-limit`, `model-context-overflow`, `tool-invalid-input`, `tool-policy-denied`, `tool-transient`, `sandbox-denied`, `approval-rejected`, `timeout`, `budget-exhausted`, `stale-write`, `verification-failed`, `subagent-failed`, `workflow-failed`, `persistence-failed`, `prompt-injection`, and `unknown`. `FailureRecord` names one occurrence, and `RecoveryDecision` records the `RecoveryAction` chosen for it, whether the action may be retried, the attempts remaining, whether a checkpoint must precede the retry, and why.

## Checkpoints and read model

`Checkpoint` indexes one task at one session sequence: the task and run identities, the session, the `sessionSeq`, the status and revision, the `BudgetSnapshot`, the open action ids, the unresolved failures, the `CheckpointReason`, and the timestamp. `KernelView` is what a reader gets back from `ctx.agentKernel.state.view(session)`: the current contract, the budget observation, the open actions, the unresolved failures, the latest plan and checkpoint when either exists, and the delegation receipt when the agent is a child.

## Durable event families

The kernel declaration-merges these into `SessionEventMap`; all are log-only and never enter model context.

| Event | Payload |
|---|---|
| `task/created` | The complete `TaskContract` at creation |
| `task/transitioned` | One `StateTransition` |
| `task/plan` | One `PlanRevision` |
| `action/proposed` | One `ActionProposal` |
| `policy/decision` | The proposal and its `PolicyDecision` |
| `action/authorized`, `action/denied` | The proposal and its composed `AuthorizationDecision` |
| `capability/grant` | The action and the granted capabilities |
| `action/committed` | One `ActionReceipt` |
| `verification/requested`, `verification/result` | The request and the aggregated result |
| `failure/recorded`, `recovery/decided` | The failure and the chosen recovery |
| `checkpoint/created` | One `Checkpoint` |
| `delegation/received` | The `DelegationReceipt` the child acts under, in the child's own log |
| `delegation/issued` | The same receipt as an audit copy on the parent log |

The generated [persistence catalog](../persistence-catalog.md) records each declaration site, and the [Session page](session.md) owns the event-map contract they extend.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentkernel--agentkernelservice"></a>

### `ctx.agentKernel` — `AgentKernelService`

The kernel service (`ctx.agentKernel`). It attaches to the loop and tool waterfalls in its constructor, so unloading the plugin unloads every listener, declaration, and attachment with it.

```ts cordis-catalog
/**
 * Attach one live agent to its task contract.
 * @param agent - the live agent to attach.
 * @returns the attachment handle.
 * @throws When the agent's session holds no `task/created` event yet; the kernel creates one at the first admitted step.
 */
attach(agent: Agent): KernelAttachment

/**
 * Verify one task revision with the registered criterion verifiers, record the
 * request and its result, and return the completion decision.
 * @param agent - the live agent whose task is verified.
 * @param changedScopes - scopes the task changed, for `diff` verifiers.
 * @returns the completion decision, or undefined when the agent has no task.
 */
verify(agent: Agent, changedScopes: readonly string[] = []): Promise<CompletionDecision | undefined>

/**
 * Record one checkpoint of an agent's current kernel state.
 * @param agent - the live agent whose task is checkpointed.
 * @param reason - why the checkpoint is recorded.
 * @returns the checkpoint, or undefined when the agent has no task.
 */
checkpoint(agent: Agent, reason: CheckpointReason): Checkpoint | undefined
```

Types: [Agent](core.md)

Source: [`packages/runtime/agent-kernel/src/index.ts`](../../packages/runtime/agent-kernel/src/index.ts)
<!-- END GENERATED cordis-surface -->
