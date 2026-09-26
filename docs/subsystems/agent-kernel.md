# Agent kernel

English | [中文](agent-kernel.zh.md)

The control plane owned by [`@deepseek-ai/dsh-agent-kernel`](../../packages/runtime/agent-kernel/README.md). The kernel observes the agent and tool seams `core/agent-loop` and `core/tools` already publish, derives one durable task contract per session from the session log, records a proposal and a composed decision for every tool call, and decides completion against the task's own acceptance criteria. It owns no execution: the loop keeps turn and step ownership, the tool registry keeps dispatch, [`sandbox-policy`](sandbox.md) keeps the file boundary, and [`user-approval`](approval.md) keeps the human decision. Declarations live in [`packages/runtime/agent-kernel/src/types.ts`](../../packages/runtime/agent-kernel/src/types.ts); the package README defines configuration and the records a session receives.

## Task contract

A task is a projection of `task/*` events, never an in-memory singleton. `TaskId` and `RunId` are [branded ids](core.md#branded-ids); `ActionId` is the tool call's own `ToolCallId` under a second brand, so a proposal, its decisions, and its receipt correlate without a second identifier.

`TaskContract` carries the objective, its constraints, its acceptance criteria, the change contract the caller declared, the workspace its file policy is bounded to, the agent and policy profiles, the resource budget, the current `TaskStatus`, and a positive `revision` that every accepted transition increments. `TaskStatus` is the closed union `intake | planning | ready | executing | observing | verifying | recovering | awaiting-approval | awaiting-user | paused | completed | failed | cancelled`, and every member has a producer: a task is `intake` when opened, `planning` while plan mode is entered, `ready` once its first step is admitted, `executing`/`observing` around each step, `verifying` at turn end, `recovering` when recovery starts, and terminal when the completion gate or a cancellation answers. The kernel drives `intake → ready → executing → observing` when plan mode is not entered.

A session holds one task at a time. A human message claimed while the current task is terminal opens the next contract, which names the task it follows in `parentTaskId`; when one is still active the message continues it. `TaskClass` decides what a task starts from: `conversational` (the default) takes no acceptance criterion and completes at turn end without a verification pair, while `coding`, `research`, and `operations` take the criteria `acceptanceByClass` configures and are held to one only when `requireAcceptanceCriteriaByClass` requires it. The class comes from the caller's own `taskClass`, else the role the task runs under, else the mutation heuristic — a task following one that proposed an `fs.write`/`fs.edit` tool is coding work.

## Agent profile

`AgentProfile` is the kernel's enforceable slice of one role: an id, the role it stands for, the capability grant that role may ever use, the policy profile its tasks resolve, and the ceilings they start from. A task records the profile name it runs under, and the kernel resolves that name through `ctx.agentKernel.profiles` — a registry a deployment fills from `Config.profiles` or from a later configuration layer through `register()`.

A role narrows, never widens: `composeAuthorization()` refuses a declared capability outside the profile's grant with the reason `the agent profile withholds capability "<capability>"`, so a permission rule that allows a capability for the deployment still does not authorize it for a role that does not declare it. A child inherits the intersection of its receipt with its own role, never the union. The model and context policy of a role belong to the packages that own models and context — the model router and the [context compiler](agent-context.md) — so the profile states only what the kernel itself enforces rather than keeping a second copy of decisions it does not make.

`StateTransition` is the durable record of one accepted move: the transition identity, the task, the `from` and `to` statuses, the `TransitionTrigger`, the evaluated `preconditions`, the committed `effects`, the task revision it was evaluated against, the revision it produced, an optional authorizing `policyDecisionId`, the `actor`, and the timestamp. `applyTransition()` in [`src/state-machine.ts`](../../packages/runtime/agent-kernel/src/state-machine.ts) rejects a transition that belongs to another task, starts from a stale status, or cites a stale revision.

## Action ledger

Each tool call produces a proposal, a rule decision, a composed authorization, an optional capability grant, and a receipt.

`ActionProposal` names the action, the agent, the tool call, the registered tool, the frozen parsed arguments, the proposal source (`model`, `workflow`, `subagent`, or `user`), the task revision, and a `TrustLabel`. `PolicyContext` adds the tool's declared `CapabilityRequest` list, whether the tool declared nothing, the delegation receipt when the acting agent is a child, and the resolved technical boundary.

`PolicyDecision` is what the permission document decided: the `effect`, the index of the winning rule or `null` for the default, the capability requests the winning rule matched, and the reasons in evaluation order. `AuthorizationDecision` is the composed runtime answer: the intersected `effect`, the decision it composes, the granted `Capability` list, the `SandboxExecutionPolicy` the action executes under, whether the kernel acted on the decision (`enforced`), the delegation the action ran under when the agent is a child, and the composed reasons. `ActionReceipt` settles the action with `succeeded`, `failed`, or `denied` and an optional `GovernanceReceipt` linking the policy decision, the sandbox mode and workspace root, the human outcome when one was recorded, and who resolved it (`user`, `policy`, or `none`).

## Permission document

`PolicyDocument` is a default `effect` plus an ordered `PolicyRule` list; each rule selects a `PolicyAction` family and a resource glob and decides `allow`, `ask`, or `deny`. `POLICY_ACTIONS` and `POLICY_EFFECTS` in [`src/policy.ts`](../../packages/runtime/agent-kernel/src/policy.ts) are the accepted vocabularies, and `compilePolicy()` rejects an unknown action, an unknown effect, or an empty resource before any action is evaluated. `Capability` is the grant vocabulary — `fs.read`, `fs.write`, `fs.edit`, `process.exec`, `terminal.interactive`, `network.read`, `network.write`, `mcp.call`, `memory.read`, `memory.write`, `subagent.spawn`, `workflow.start`, `approval.request`, and `policy.propose` — and `CapabilityDeclaration` maps one registered tool to the capabilities each invocation needs plus a pure projection from its arguments to the resource they apply to. A declaration may also carry the trust of the content its tool acts on: a package whose tool reaches outside the trust boundary declares `trust: 'untrusted'`, and a deployment that quarantines untrusted content then requires a human answer before that call runs, so a permission rule alone never authorizes external content. `PolicyProfileProvider` is the optional session-selected layer above that document: `ctx.agentKernel.registerPolicyProfileProvider()` resolves a profile name and an optional `PolicyDocument` per session, and the kernel intersects it with the deployment document, so a session can narrow its own authority but never widen it.

## Delegation

`DelegationReceipt` is the authority one parent run hands to one child run: the receipt identity, the child run, the parent run and task when the parent session resolved, the durable parent session, the allowed capabilities, the inherited resource limits, the writable scopes, the digest of the permission document the grant was computed under, the depth, the deepest admitted depth, and the timestamp. The kernel writes it into the child's own log at `agent/created`, before either side has a task, with an audit copy as `delegation/issued` on the parent log; a resumed child keeps the receipt already in its log instead of receiving a second one.

Child authority is the intersection of the receipt with the child's profile, the deployment rules, and the child's own sandbox: [`src/delegation.ts`](../../packages/runtime/agent-kernel/src/delegation.ts) refuses a capability the receipt withholds, a filesystem mutation outside its writable scopes narrowed against the child's boundary, and every action past the parent's depth cap. The child task contract keeps the receipt's run identity, names the parent task, and starts from the parent's remaining budget.

`DelegationPolicy` is what one deployment admits at the spawn boundary: `maxDepth`, `maxChildren`, `maxConcurrent`, `maxCost`, `maxTokens`, `allowedRoles`, `duplicateTaskDetection`, and `resultSchemaRequired`, resolved from a partial declaration by `resolveDelegationPolicy()` against the consumer's own child-depth setting. `delegationPolicyRefusal()` answers a spawn with one refusal sentence, `delegatedWorkerBudget()` supplies the token and cost ceilings handed to the child, and `taskOverlapDecision()` compares one delegation objective against the parent's in-flight and completed children and returns `reuse`, `merge`, `narrow`, `avoid`, or `spawn` — a deterministic token-set comparison with no model call ([`src/delegation-policy.ts`](../../packages/runtime/agent-kernel/src/delegation-policy.ts), [`src/task-overlap.ts`](../../packages/runtime/agent-kernel/src/task-overlap.ts)). `dsh-tool-subagent` is the current spawn boundary that enforces them.

## Built-in declarations

The kernel registry starts empty and fails closed. [`@deepseek-ai/dsh-agent-kernel-builtins`](../../packages/runtime/agent-kernel-builtins/README.md) is the opt-in plugin that declares every shipped product tool — the capabilities one invocation needs and a total, never-empty projection from its arguments to the resource they apply to — registering them once the injected `agentKernel` service exists, in any mount order. A spec re-derives the tool inventory from the generated [tool catalog](../tool-catalog.md) and fails when a shipped name has no declaration, so a new tool cannot arrive undeclared.

## Verification, failure, and recovery

`VerificationRequest` carries the task, the exact revision the criteria were read from, those criteria, and the changed scopes. `VerificationResult` aggregates per-criterion `CriterionResult` records into `pass`, `fail`, or `unknown`, with the commands the verifiers ran and the verifier version. `CompletionDecision` is the gate's answer: completion is allowed only when every required criterion passed, no unresolved failure remains, and no configured ceiling is exhausted.

`FailureKind` is the shared classification — `model-auth`, `model-rate-limit`, `model-context-overflow`, `tool-invalid-input`, `tool-policy-denied`, `tool-transient`, `sandbox-denied`, `approval-rejected`, `timeout`, `budget-exhausted`, `stale-write`, `verification-failed`, `subagent-failed`, `workflow-failed`, `persistence-failed`, `prompt-injection`, `output-truncated`, `tool-args-malformed`, `no-progress`, `stalled`, `step-ceiling`, `plan-drift`, `verification-regressed`, and `unknown`. The last five are amendment S4's loop-robustness classifications: each names a way a run stops making progress without failing outright, and the kernel's own detector records `step-ceiling` — with the failure's recovery, `checkpoint-pause` — when a task reaches its configured step ceiling, pausing it rather than admitting another step. `FailureRecord` names one occurrence, and `RecoveryDecision` records the `RecoveryAction` chosen for it, whether the action may be retried, the attempts remaining, whether a checkpoint must precede the retry, and why.

## Governor, progress, and liveness

`GovernorDecision` is the one control decision the kernel composes per step: `continue`, `retry`, `replan`, `compact`, `delegate`, `ask_user`, and the five stops `stop_success`, `stop_failure`, `stop_budget`, `stop_loop`, and `stop_timeout`. `StepDelta` measures the movement the step that just ended made, one axis per kind of event it produced: `toolNovelty` (the share of its tool calls the recent history had not seen), `stateDelta` (a task revision advanced), `evidenceGain` (an observation or claim was recorded), `goalProgress` (the session's goal changed), `errorReduction` (unresolved failures fell), and `planProgress` (a plan revision was recorded). Each axis is normalized to `[0, 1]`, and `progressScore` is their mean, so 0 is a step the harness observed moving nothing.

Every step boundary appends `governor/decided` with a `GovernorDecisionRecord`: the decision, its reasons in evaluation order, the step's delta, the score, the turn and step, the `TimeoutKind` when the decision answers a stall, and the timestamp. The decision is composed from budget state, progress, repetition, oscillation, the newest unresolved failure's decided recovery, context pressure, task state, subagent depth, and liveness, in that order of precedence. A step whose score is above 0 resolves the `no-progress` and `stalled` failures recorded against the steps before it. In `mode: 'enforce'` the kernel returns the refusal for a `stop_*` decision at `agent/pre-step`, which the loop reports as a blocked turn.

`TimeoutKind` names which layer went quiet when the liveness window elapsed: `tool` (a call that never settled), `transport` (a request that produced no frame), `stream` (a request that stopped producing frames), `agent` (a run with nothing in flight), or `child-agent` (a delegated child). The monitor tracks the last model frame, the last tool pipeline event, and the last progressing step, and a task that waits for a human or is parked by a stop is never reported as stalled.

## Coding lifecycle

`CodingPhase` is the §10.5 pipeline a task of class `coding` runs: `understand`, `map`, `plan`, `contract`, `implement`, `local-verify`, `review`, `regression`, `complete`. `canAdvancePhase()` and `assertPhaseTransition()` expose the machine's direct edges — the forward chain plus the repair return each check phase takes to `implement` — and a transition outside that table throws. `CodingLifecycleConfig` (`phases`, `budgets`, `review`) is validated once at load by `resolveCodingLifecycle()`, and `ResolvedCodingLifecycle` is what the service runs: the phase list starts at `understand`, ends at `complete`, repeats no phase; a `budgets` entry names a phase this deployment runs and states its positive step ceiling; the review cannot be enabled while `phases` omits `review`, and REVIEW is skipped in the pipeline while the reviewer is switched off.

`CodingPhaseRecord` is one entry: the phase, the phase it came from, the task class, the phase's ordinal in the pipeline, its trigger (`lifecycle-started`, `phase-advanced`, `phase-repaired`), the caller's `detail`, the task revision, and the timestamp. `CodeReviewRecord` is one REVIEW entry's settled report: the diff ref reviewed, the `CodeReviewReport` (`summary` plus `CodeReviewFinding[]` of file, optional line, `ReviewSeverity`, and message), the task revision, and the timestamp. `ctx.agentKernel.lifecycle` is the `CodingLifecycle` service: `phasesFor(taskClass)`, `current(session)`, `advance(session, target, detail?)`, `repair(session, detail)`, `review(agent, signal)`, `completionPredicate(session)`, and `registerReviewer(reviewer)`, which takes a deployment's `IndependentReviewer` (its `review(request: CodeReviewRequest)` answers one `CodeReviewReport`) and refuses a second registration. `PhaseAdvance` reports the entries appended and the `CodingPhaseBudget` that stopped the advance; the caller records that failure, and the kernel parks the task at `awaiting-user`.

## Research record

`Evidence` is one observation a claim may cite: which family observed it (`file`, `tool-result`, `web`, `mcp`, `test`, `user`, `model`), a reference to where the content lives, an optional digest of what was seen, the source and locator recorded for the observation itself, its `TrustLabel`, and when it was observed. The content stays in its own store; the record is the reference, so an untrusted observation remains data even when a claim cites it.

`TaskClaim` is one statement a task asserts, the `EvidenceId`s behind it, a confidence in `[0, 1]`, and a status (`proposed`, `supported`, `contradicted`, `stale`, `rejected`) — the live task's own record, distinct from the cross-session claims `evolution-graph` stores for promotion. `TaskHypothesis` is one question, the `TaskClaimId`s and `VerificationRequest`s that bear on it, and a status (`open`, `supported`, `refuted`, `inconclusive`). `recordEvidence()`, `recordClaim()`, and `recordHypothesis()` append the record as `evidence/recorded`, `claim/updated`, or `hypothesis/updated` and throw on an empty statement or question, a confidence outside `[0, 1]`, a citation this session never recorded, a `supported` claim citing no observation, or a test naming another task.

## Checkpoints and read model

`Checkpoint` indexes one task at one session sequence: the task and run identities, the session, the `sessionSeq`, the status and revision, the `BudgetSnapshot`, the open action ids, the unresolved failures, the `CheckpointReason`, and the timestamp. `KernelView` is what a reader gets back from `ctx.agentKernel.state.view(session)`: the current contract, the budget observation, the open actions, the unresolved failures, the latest plan and checkpoint when either exists, and the delegation receipt when the agent is a child.

`BudgetSnapshot` measures a task's spend and reports what each configured ceiling has left; `ctx.agentKernel.budgets` also answers what a session can still promise. `available(session)` is the measured remaining allowance less the holds the session's in-flight children placed and the spend its settled children reported; `reserve(session, amount, runId?)` holds part of that allowance for work about to run and returns the `BudgetReservation` naming the session, the run, and the ceilings it placed; `commit(reservationId, actual?)` settles a hold with what the work spent, and `release(reservationId)` ends one whose work never ran. Holds and the debits they settle into are process state: a restart has no in-flight work to hold budget for, so what a parent handed down is read from its `delegation/issued` receipts instead.

## Surfaces

Kernel records are durable session events, so every bridge that already carries the session log carries them: the [SDK protocol package](../../packages/sdk/protocol/README.md) streams them unfiltered as `session.event` notifications, and [ACP](../../packages/acp/acp/README.md) projects the durable plan revision into its own `plan` update while carrying permission requests through `session/request_permission`. Verification results, checkpoints, and action decisions have no ACP representation, so an ACP client reads them from the SDK stream or from the session log itself.

## Metrics

`readKernelMetrics(events)` folds one session's kernel events into the counters this plane owns: tasks created and their terminal outcomes, verification counts and pass rate, steps and tool calls, actions proposed/succeeded/failed/denied, policy denials and asks, rejected approvals, failures by kind, recovery decisions by action, checkpoints and resumes, retried actions, and actions that never settled. A rate whose denominator is zero is absent rather than zero, so a reader cannot mistake "nothing happened" for "everything failed". A retried action keeps its action id, so the receipt is the settled attempt and the attempts themselves show up as proposals and as the retried-action count. Metrics owned by other packages — context compaction, memory recall utility, skill utility, evolution gain — are not derived here; their owners write them.

## Durable event families

The kernel declaration-merges these into `SessionEventMap`; all are log-only and never enter model context.

| Event | Payload |
|---|---|
| `task/created` | The complete `TaskContract` at creation |
| `task/transitioned` | One `StateTransition` |
| `task/plan` | One `PlanRevision` |
| `task/phase` | One `CodingPhaseRecord` |
| `task/review` | One `CodeReviewRecord`, the independent reviewer's structured report for one REVIEW entry |
| `action/decided` | One `ActionProposal`, the `PolicyDecision` it answers, and the composed `AuthorizationDecision`, including the capabilities it granted |
| `action/committed` | One `ActionReceipt` and the one-action grants that ended with it |
| `verification/requested`, `verification/result` | The request and the aggregated result |
| `failure/recorded`, `recovery/decided` | The failure and the chosen recovery |
| `governor/decided` | One `GovernorDecisionRecord`: the decision, its reasons, the step's `StepDelta`, and the normalized progress score |
| `checkpoint/created` | One `Checkpoint` |
| `evidence/recorded` | One `Evidence` |
| `claim/updated`, `hypothesis/updated` | One `TaskClaim` or one `TaskHypothesis` |
| `delegation/received` | The `DelegationReceipt` the child acts under, in the child's own log |
| `delegation/issued` | The same receipt as an audit copy on the parent log |

The generated [persistence catalog](../persistence-catalog.md) records each declaration site, and the [Session page](session.md) owns the event-map contract they extend.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentkernel--agentkernelservice"></a>

### `ctx.agentKernel` — `AgentKernelService`

The kernel service (`ctx.agentKernel`). It attaches to the loop and tool waterfalls in its constructor. Plugin unload removes those registrations and awaits release of every open attachment.

```ts cordis-catalog
/**
 * Register the provider for session-selected policy layers.
 * @param provider - resolves the profile and optional restriction for each session.
 * @returns a disposer that removes this provider while it remains registered.
 * @throws when another policy profile provider is already registered.
 */
registerPolicyProfileProvider(provider: PolicyProfileProvider): () => void

/**
 * Persist one caller-supplied task contract before its first request.
 * @param agent - the live agent whose session owns the task.
 * @param input - the objective, constraints, acceptance, profiles, workspace and budget.
 * @returns the newly recorded contract at its initial `intake` revision.
 * @throws When the session already has a task contract.
 */
intake(agent: Agent, input: TaskInput): TaskContract

/**
 * Attach one live agent to its task contract.
 * @param agent - the live agent to attach.
 * @returns the attachment handle.
 * @throws When the agent's session holds no `task/created` event yet; the kernel creates one at the first admitted step.
 */
attach(agent: Agent): KernelAttachment

/**
 * Read one agent's task state.
 * @param agent - the live agent whose session is read.
 * @returns the current view, or undefined before task intake.
 */
snapshot(agent: Agent): Promise<KernelView | undefined>

/**
 * Read the current task view through the live agents registry.
 * The registry remains the sole owner of agent identity and disposal; this
 * method resolves it on every call and retains no agent reference.
 * @param sessionId - the identity of the session to read.
 * @returns the current view, or undefined when no live agent or task exists.
 */
viewOf(sessionId: SessionId): KernelView | undefined

/**
 * Record an initial plan or an amendment tied to one unresolved failure. A
 * revision a human approved is legal without a failure reference, because the
 * review is the justification the model's own rewrite lacks.
 * @param agent - the live agent whose task owns the plan.
 * @param steps - ordered work items in the new plan revision.
 * @param failureId - unresolved failure that justifies an amendment.
 * @param options - who approved the revision and which action recorded it.
 * @returns the durable plan revision.
 * @throws When the session has no task, a model-recorded amendment is not
 *   linked to an unresolved failure, or the task reached its revision cap.
 */
recordPlan(agent: Agent, steps: readonly string[], failureId?: FailureId, options: PlanOptions = {}): PlanRevision

/**
 * Record one observation a claim may cite.
 * @param agent - the live agent whose task observed it.
 * @param input - what was observed, where it lives, and how far it may be trusted.
 * @returns the durable evidence record.
 * @throws When the session has no task or the reference is empty.
 */
recordEvidence(agent: Agent, input: EvidenceInput): Evidence

/**
 * Assert one claim against evidence this session recorded.
 * @param agent - the live agent whose task asserts it.
 * @param input - the statement, the evidence it cites, its confidence, and its status.
 * @returns the durable claim.
 * @throws When the session has no task, the statement is empty, the confidence
 *   is outside `[0, 1]`, a cited observation was never recorded, or a
 *   `supported` claim cites no observation.
 */
recordClaim(agent: Agent, input: TaskClaimInput): TaskClaim

/**
 * Record one question a task is testing.
 * @param agent - the live agent whose task is testing it.
 * @param input - the question, the claims behind it, and the verifications run against it.
 * @returns the durable hypothesis.
 * @throws When the session has no task, the question is empty, a cited claim
 *   was never asserted, or a test does not verify this task.
 */
recordHypothesis(agent: Agent, input: TaskHypothesisInput): TaskHypothesis

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

/**
 * Follow plan mode, the producer of the `planning` status: entering it moves a
 * non-terminal task to `planning`, leaving it returns the task to `ready`. A
 * session with no task yet has nothing to move, and a status that cannot reach
 * `planning` keeps its current one. The plan-mode plugin calls this immediately
 * after it records the mode, so the status and the mode agree in the log.
 * @param session - the session whose mode changed.
 * @param active - whether plan mode is now in force.
 */
recordPlanMode(session: Session, active: boolean): void
```

Types: [Agent](core.md) · [Session](session.md) · [SessionId](core.md)

Source: [`packages/runtime/agent-kernel/src/index.ts`](../../packages/runtime/agent-kernel/src/index.ts)
<!-- END GENERATED cordis-surface -->
