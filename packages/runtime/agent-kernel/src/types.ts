/**
 * Contracts of the agent kernel: the durable task contract, the action ledger,
 * the capability and policy vocabulary, the verification gate, and the recovery
 * and checkpoint records. This module declares types only — the kernel service
 * and its runtime decisions live in `index.ts`.
 *
 * Every record here is either a durable `SessionEventMap` payload (the source of
 * truth) or a pure input/output value of a kernel decision. Nothing in this
 * module is stored outside the session log when it affects completion,
 * authority, or recovery.
 *
 * @module @deepseek-ai/dsh-agent-kernel/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Stable identity of one durable task contract. */
export type TaskId = Branded<'TaskId'>

/** Stable identity of one kernel run: the executor lifetime of one task. */
export type RunId = Branded<'RunId'>

/** Identity of one proposed action, shared by its proposal, decision, and receipt. */
export type ActionId = Branded<'ActionId'>

/** Identity of one recorded task-state transition. */
export type TransitionId = Branded<'TransitionId'>

/** Identity of one recorded policy decision. */
export type PolicyDecisionId = Branded<'PolicyDecisionId'>

/** Identity of one recorded checkpoint. */
export type CheckpointId = Branded<'CheckpointId'>

/** Identity of one recorded failure. */
export type FailureId = Branded<'FailureId'>

/**
 * How far content or a decision may be trusted. Untrusted content is data: it
 * never becomes an instruction authority and never widens a grant.
 */
export type TrustLabel = 'trusted' | 'untrusted' | 'unknown'

/** Who caused a durable kernel record. */
export type ActorKind = 'user' | 'model' | 'kernel' | 'tool' | 'system'

/** Where a kernel record's content came from. */
export interface Provenance {
  /** Emitting subsystem or external boundary. */
  readonly source: 'user' | 'model' | 'repo' | 'tool' | 'web' | 'mcp' | 'subagent' | 'policy' | 'kernel'
  /** Repository-relative path, URL, or tool call id locating the content, when one exists. */
  readonly locator?: string
  /** Content digest recorded for audit, when the producer computed one. */
  readonly digest?: string
}

/**
 * Task lifecycle state. The kernel owns these; `turn/step` state stays with
 * `core/agent-loop` and is not duplicated here.
 */
export type TaskStatus =
  | 'intake'
  | 'understanding'
  | 'retrieving'
  | 'planning'
  | 'ready'
  | 'executing'
  | 'observing'
  | 'verifying'
  | 'recovering'
  | 'awaiting-approval'
  | 'awaiting-user'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** One bound the objective must respect. */
export interface Constraint {
  /** Stable lower-kebab-case classification chosen by the intake source. */
  readonly kind: string
  /** Non-empty statement of the bound. */
  readonly statement: string
}

/** One criterion a completion decision must satisfy. */
export interface AcceptanceCriterion {
  /** Stable identity within the task contract. */
  readonly id: string
  /** Non-empty statement of what must hold. */
  readonly description: string
  /** Which verifier family can evaluate the criterion. */
  readonly verifier: 'test' | 'build' | 'diff' | 'assertion' | 'human' | 'research'
  /** Whether a failed or unknown result blocks completion. */
  readonly required: boolean
}

/** Ceilings one task may spend. An absent field is unbounded. */
export interface ResourceBudget {
  /** Model steps the task may take. */
  readonly maxSteps?: number
  /** Tool calls the task may dispatch. */
  readonly maxToolCalls?: number
  /** Measured request tokens the task may consume. */
  readonly maxTokens?: number
  /** Wall-clock milliseconds the task may run. */
  readonly maxWallMs?: number
  /** Priced cost in USD the task may spend. */
  readonly maxCostUsd?: number
  /** Delegation depth the task may reach. */
  readonly maxSubagentDepth?: number
}

/** Observed resource use of one task, plus what remains of its configured budget. */
export interface BudgetSnapshot {
  /** `step/start` events observed for the task's session. */
  readonly steps: number
  /** `tool/call` events observed for the task's session. */
  readonly toolCalls: number
  /** Wall-clock milliseconds since the task was created. */
  readonly wallMs: number
  /** Remaining allowance per configured ceiling; an unbounded ceiling is absent. */
  readonly remaining: ResourceBudget
}

/** The repository scope a task's writes are bounded to. */
export interface WorkspaceRef {
  /** Absolute workspace root the task's file policy resolves against. */
  readonly root: string
}

/**
 * The runtime-owned objective: what the task is for, what bounds it, and what
 * must hold before it may complete. The durable source of truth is the
 * `task/created` and `task/transitioned` session events; a `TaskContract` value
 * is always a projection of them.
 */
export interface TaskContract {
  /** Stable task identity. */
  readonly taskId: TaskId
  /** Stable run identity of the executor lifetime. */
  readonly runId: RunId
  /** The human- or caller-stated objective. */
  readonly objective: string
  /** Bounds the objective must respect. */
  readonly constraints: readonly Constraint[]
  /** Criteria a completion decision must satisfy. */
  readonly acceptance: readonly AcceptanceCriterion[]
  /** Workspace the task's file policy is bounded to, when the session has one. */
  readonly workspace?: WorkspaceRef
  /** Enclosing task, when this task was delegated. */
  readonly parentTaskId?: TaskId
  /** Agent profile the task runs under. */
  readonly agentProfile: string
  /** Policy profile the task runs under. */
  readonly policyProfile: string
  /** Ceilings the task may spend. */
  readonly budget: ResourceBudget
  /** Current lifecycle state. */
  readonly status: TaskStatus
  /** Positive revision; every accepted transition increments it. */
  readonly revision: number
}

/** Caller-supplied intake for a new task. */
export interface TaskInput {
  /** The human- or caller-stated objective; empty when none was stated yet. */
  readonly objective: string
  /** Bounds the objective must respect. */
  readonly constraints?: readonly Constraint[]
  /** Criteria a completion decision must satisfy. */
  readonly acceptance?: readonly AcceptanceCriterion[]
  /** Workspace the task's file policy is bounded to. */
  readonly workspace?: WorkspaceRef
  /** Enclosing task, when this task was delegated. */
  readonly parentTaskId?: TaskId
  /** Agent profile the task runs under. */
  readonly agentProfile: string
  /** Policy profile the task runs under. */
  readonly policyProfile: string
  /** Ceilings the task may spend. */
  readonly budget?: ResourceBudget
}

/** Why the kernel moved a task between states. */
export interface TransitionTrigger {
  /** Stable lower-kebab-case trigger name. */
  readonly kind: TransitionKind
  /** Free-form detail for humans and models. */
  readonly detail?: string
}

/** Every trigger the kernel records as a transition cause. */
export type TransitionKind =
  | 'task-intake'
  | 'step-admitted'
  | 'turn-ended'
  | 'verification-requested'
  | 'verification-passed'
  | 'verification-failed'
  | 'human-required'
  | 'recovery-started'
  | 'cancelled'
  | 'paused'
  | 'budget-exhausted'

/** One precondition recorded with a transition, and whether it held. */
export interface Predicate {
  /** Stable lower-kebab-case precondition name. */
  readonly kind: string
  /** Whether the precondition held when the transition was evaluated. */
  readonly satisfied: boolean
  /** Free-form detail for humans and models. */
  readonly detail?: string
}

/** One side effect the transition committed. */
export interface StateEffect {
  /** Stable lower-kebab-case effect name. */
  readonly kind: string
  /** Free-form detail for humans and models. */
  readonly detail?: string
}

/**
 * One accepted task-state transition. The kernel rejects a transition whose
 * `from` is not the task's current status, whose edge is not in the legal
 * table, or whose `taskRevision` is stale.
 */
export interface StateTransition {
  /** Stable identity of this transition record. */
  readonly transitionId: TransitionId
  /** Task the transition belongs to. */
  readonly taskId: TaskId
  /** Status the task held before the transition. */
  readonly from: TaskStatus
  /** Status the task holds after the transition. */
  readonly to: TaskStatus
  /** Why the transition happened. */
  readonly trigger: TransitionTrigger
  /** Preconditions evaluated for this transition. */
  readonly preconditions: readonly Predicate[]
  /** Effects committed by this transition. */
  readonly effects: readonly StateEffect[]
  /** Task revision the transition was evaluated against. */
  readonly taskRevision: number
  /** Task revision produced by the transition. */
  readonly revision: number
  /** Policy decision that authorized the transition, when one did. */
  readonly policyDecisionId?: PolicyDecisionId
  /** Who caused the transition. */
  readonly actor: ActorKind
  /** Unix epoch milliseconds of the transition. */
  readonly at: number
}

/** One revision of the plan a task executes. */
export interface PlanRevision {
  /** Positive plan revision; every amendment increments it. */
  readonly revision: number
  /** Ordered plan steps. */
  readonly steps: readonly string[]
  /** Failure this revision was produced to recover from. */
  readonly failureId?: FailureId
  /** Unix epoch milliseconds the revision was recorded. */
  readonly createdAt: number
}

/**
 * One capability a tool needs. Capabilities are grants, not tool names: the
 * kernel intersects the requested capability with the task grant, the
 * deployment sandbox, and the approval outcome before execution.
 */
export type Capability =
  | 'fs.read'
  | 'fs.write'
  | 'fs.edit'
  | 'process.exec'
  | 'terminal.interactive'
  | 'network.read'
  | 'network.write'
  | 'mcp.call'
  | 'memory.read'
  | 'memory.write'
  | 'subagent.spawn'
  | 'workflow.start'
  | 'approval.request'
  | 'policy.propose'

/** One capability request against one resource selector. */
export interface CapabilityRequest {
  /** Capability the action needs. */
  readonly capability: Capability
  /** Resource the capability applies to: a workspace path, host, or command. */
  readonly resource: string
}

/**
 * A tool's capability declaration, registered by the package that owns the
 * tool. `resources` is a pure projection from parsed arguments, so the kernel
 * never guesses a resource from a tool name.
 */
export interface CapabilityDeclaration {
  /** Registered tool name the declaration applies to. */
  readonly tool: string
  /** Capabilities every invocation of the tool needs. */
  readonly capabilities: readonly Capability[]
  /**
   * Pure projection from parsed arguments to the resource each capability
   * applies to. Must be total: a throwing or empty projection leaves the
   * resource unresolved, which the policy engine treats as the unrestricted
   * selector.
   * @param args - the call's parsed, frozen arguments.
   * @returns the resource selector for this invocation.
   */
  resources(args: unknown): string
}

/** One action the model, a workflow, a subagent, or a human proposed. */
export interface ActionProposal {
  /** Identity shared by the proposal, its decisions, and its receipt. */
  readonly actionId: ActionId
  /** Session whose agent proposed the action. */
  readonly agentId: SessionId
  /** The exact tool call, when the proposal came from the tool pipeline. */
  readonly callId?: ToolCallId
  /** Registered tool name. */
  readonly toolName: string
  /** Parsed arguments, frozen by the tool registry before policy runs. */
  readonly arguments: JsonValue
  /** Who proposed the action. */
  readonly source: 'model' | 'workflow' | 'subagent' | 'user'
  /** Task revision the proposal was made against. */
  readonly taskRevision: number
  /** How far the proposal's content may be trusted. */
  readonly trust: TrustLabel
}

/** The action families a permission rule selects. */
export type PolicyAction =
  | 'read'
  | 'write'
  | 'edit'
  | 'shell'
  | 'network'
  | 'mcp'
  | 'delegate'
  | 'workflow'
  | 'memory'
  | 'policy'

/** What a policy rule or default decides. */
export type PolicyEffect = 'allow' | 'ask' | 'deny'

/** One permission rule. The last matching rule wins. */
export interface PolicyRule {
  /** Action family the rule selects. */
  readonly action: PolicyAction
  /** Resource glob the rule selects; `**` matches any run of characters. */
  readonly resource: string
  /** Decision the rule makes for a matching action. */
  readonly effect: PolicyEffect
}

/**
 * A deployment's complete permission document. The rule list is a mutable
 * array because it is also the `Config.policy` field's shape, which the
 * configuration schema produces; nothing in this package mutates it.
 */
export interface PolicyDocument {
  /** Decision for an action no rule matches. */
  readonly defaults: {
    /** Effect applied when no rule matches an action. */
    readonly effect: PolicyEffect
  }
  /** Rules in declaration order; the last match wins. */
  rules: PolicyRule[]
}

/** Everything one policy evaluation reads. */
export interface PolicyContext {
  /** The proposed action. */
  readonly action: ActionProposal
  /** Capabilities the action's tool declared for this invocation. */
  readonly capabilities: readonly CapabilityRequest[]
  /** Whether the tool declared no capability at all. */
  readonly undeclared: boolean
  /** The implementation's technical boundary for this call. */
  readonly sandbox: SandboxExecutionPolicy
}

/**
 * What the rules decided about one action, before the technical sandbox and
 * the human answerer are composed into the runtime authorization.
 */
export interface PolicyDecision {
  /** Identity of this decision record. */
  readonly decisionId: PolicyDecisionId
  /** Action the decision is about. */
  readonly actionId: ActionId
  /** Decision reached. */
  readonly effect: PolicyEffect
  /** Index of the winning rule in the document, or null when the default decided. */
  readonly matchedRuleIndex: number | null
  /** Capability requests the winning rule was matched against. */
  readonly capabilities: readonly CapabilityRequest[]
  /** Why the decision came out this way, in evaluation order. */
  readonly reasons: readonly string[]
}

/**
 * The composed runtime answer for one action: the policy decision intersected
 * with the sandbox boundary and, for `ask`, the human answerer's outcome.
 */
export interface AuthorizationDecision {
  /** Composed effect; `allow` is the only effect that executes. */
  readonly effect: PolicyEffect
  /** Policy decision this authorization composes. */
  readonly decisionId: PolicyDecisionId
  /** Capabilities granted to this exact action. */
  readonly capabilityGrants: readonly Capability[]
  /** Technical boundary the action executes under. */
  readonly sandbox: SandboxExecutionPolicy
  /**
   * Whether the kernel acted on {@link effect}. A shadow-mode kernel records
   * the decision it would have made and lets the action run anyway, so an
   * `action/authorized` carrying `enforced: false` and a non-`allow` effect is
   * a shadow finding, not a grant.
   */
  readonly enforced: boolean
  /** Why the authorization came out this way. */
  readonly reasons: readonly string[]
}

/** The durable record of one proposed action and its composed decision. */
export interface ActionDecisionEvent {
  /** The proposal the decision answers. */
  readonly proposal: ActionProposal
  /** The composed runtime answer. */
  readonly decision: AuthorizationDecision
}

/**
 * The composed policy/imposition result for one action: the rule decision, the
 * sandbox actually applied, and the human outcome when one was asked for.
 */
export interface GovernanceReceipt {
  /** Action identity shared by the proposal, decision, and receipt. */
  readonly actionId: ActionId
  /** Policy decision the receipt composes. */
  readonly decisionId: PolicyDecisionId
  /** Sandbox mode the action executed under. */
  readonly sandboxMode: SandboxExecutionPolicy['mode']
  /** Absolute workspace root the action executed against. */
  readonly workspaceRoot: string
  /** Human decision, present when the policy asked. */
  readonly approvalOutcome?: ApprovalOutcome
  /** Who resolved the governance question. */
  readonly approver: 'user' | 'policy' | 'none'
  /** Unix epoch milliseconds the receipt was recorded. */
  readonly at: number
}

/** One capability grant attached to an action. */
export interface CapabilityGrant {
  /** Action the grant belongs to. */
  readonly actionId: ActionId
  /** Capabilities granted. */
  readonly capabilities: readonly Capability[]
  /** Unix epoch milliseconds the grant stops applying, when it expires. */
  readonly expiresAt?: number
}

/** The settled outcome of one executed action. */
export interface ActionReceipt {
  /** Action identity shared by the proposal, decision, and this receipt. */
  readonly actionId: ActionId
  /** Registered tool name. */
  readonly toolName: string
  /** Policy decision the action executed under. */
  readonly decisionId: PolicyDecisionId
  /**
   * `succeeded` or `failed` for an action that ran, `denied` for one the
   * composed policy refused or an answerer rejected: a refusal is never
   * reported as an execution failure.
   */
  readonly outcome: 'succeeded' | 'failed' | 'denied'
  /** Failure recorded for a failed action. */
  readonly failureId?: FailureId
  /** The linked policy, sandbox, and human-decision record for this action. */
  readonly governance?: GovernanceReceipt
  /** Unix epoch milliseconds the receipt was recorded. */
  readonly committedAt: number
}

/**
 * Failure classification shared by every executor family. Policy denial and
 * approval rejection are distinct from execution failure: neither is a tool
 * error.
 */
export type FailureKind =
  | 'model-auth'
  | 'model-rate-limit'
  | 'model-context-overflow'
  | 'tool-invalid-input'
  | 'tool-policy-denied'
  | 'tool-transient'
  | 'sandbox-denied'
  | 'approval-rejected'
  | 'timeout'
  | 'budget-exhausted'
  | 'stale-write'
  | 'verification-failed'
  | 'subagent-failed'
  | 'workflow-failed'
  | 'persistence-failed'
  | 'prompt-injection'
  | 'unknown'

/** One classified failure. */
export interface FailureRecord {
  /** Stable failure identity, referenced by receipts and recovery decisions. */
  readonly failureId: FailureId
  /** Classified kind. */
  readonly kind: FailureKind
  /** Action that failed, when the failure belongs to one. */
  readonly actionId?: ActionId
  /** Tool that failed, when the failure belongs to one. */
  readonly toolName?: string
  /** Human- and model-readable detail. */
  readonly detail: string
  /** Unix epoch milliseconds the failure was observed. */
  readonly at: number
}

/** A reference to one recorded failure. */
export interface FailureRef {
  /** Failure identity. */
  readonly failureId: FailureId
  /** Classified kind, denormalized so a reader need not fold the log. */
  readonly kind: FailureKind
}

/** What the kernel decided to do about one failure. */
export type RecoveryAction =
  | 'retry'
  | 'compact'
  | 'reread'
  | 'ask-user'
  | 'replan'
  | 'diagnose'
  | 'checkpoint-pause'
  | 'settle-child'
  | 'quarantine'
  | 'fail-closed'

/** The recovery decided for one failure, and why. */
export interface RecoveryDecision {
  /** Failure the decision answers. */
  readonly failureId: FailureId
  /** Action the kernel took. */
  readonly action: RecoveryAction
  /** Whether the failed action may be retried under the same action id. */
  readonly retryable: boolean
  /** Attempts remaining for the failed action after this decision. */
  readonly attemptsRemaining: number
  /** Whether the kernel must checkpoint before the action is attempted again. */
  readonly checkpointRequired: boolean
  /** Why this recovery was chosen. */
  readonly reason: string
  /** Unix epoch milliseconds the decision was recorded. */
  readonly at: number
}

/** What one criterion's verification observed. */
export interface CriterionResult {
  /** Identity of the criterion this result answers. */
  readonly criterionId: string
  /** Observed status. */
  readonly status: 'pass' | 'fail' | 'unknown'
  /** Evidence references supporting the status. */
  readonly evidence: readonly string[]
  /** Human- and model-readable detail. */
  readonly detail?: string
}

/** A request to verify one task revision. */
export interface VerificationRequest {
  /** Task being verified. */
  readonly taskId: TaskId
  /** Exact task revision the criteria were read from. */
  readonly revision: number
  /** Criteria to evaluate. */
  readonly criteria: readonly AcceptanceCriterion[]
  /** Scopes the task changed, for `diff` verifiers. */
  readonly changedScopes: readonly string[]
}

/** One verifier's answer for one criterion. */
export interface CriterionVerdict {
  /** The criterion's outcome. */
  readonly result: CriterionResult
  /** Commands the verifier ran to reach it. */
  readonly commands?: readonly string[]
}

/**
 * A local verifier the completion gate delegates to. The kernel owns the gate,
 * not the checks: a package that can test, build, or diff a criterion
 * registers the verifier for it here.
 */
export interface CriterionVerifier {
  /** Stable verifier identity, recorded on the verification result. */
  readonly id: string
  /**
   * Whether this verifier owns one criterion.
   * @param criterion - the criterion to test.
   * @returns true when this verifier can evaluate the criterion.
   */
  supports(criterion: AcceptanceCriterion): boolean
  /**
   * Evaluate one criterion this verifier supports.
   * @param request - the verification request the criterion belongs to.
   * @param criterion - the criterion to evaluate.
   * @returns the verdict, or undefined when this attempt produced no answer.
   */
  verify(request: VerificationRequest, criterion: AcceptanceCriterion): Promise<CriterionVerdict | undefined>
}

/** The outcome of one verification. */
export interface VerificationResult {
  /** Task that was verified. */
  readonly taskId: TaskId
  /** Task revision the criteria were read from. */
  readonly revision: number
  /** Aggregate status: `pass` only when every criterion passed. */
  readonly status: 'pass' | 'fail' | 'unknown'
  /** Per-criterion outcomes, in criterion order. */
  readonly criterionResults: readonly CriterionResult[]
  /** Commands the verifier ran. */
  readonly commands: readonly string[]
  /** Version of the verifier that produced this result. */
  readonly verifierVersion: string
}

/**
 * The completion gate's answer. Completion is allowed only when every required
 * criterion passed, no unresolved failure exists, and the task budget settled.
 * A model statement of "done" is evidence at most and never a decision.
 */
export interface CompletionDecision {
  /** Whether the task may be reported complete. */
  readonly allowed: boolean
  /** Every reason the gate refused or allowed completion. */
  readonly reasons: readonly string[]
}

/** Why the kernel recorded a checkpoint. */
export type CheckpointReason =
  | 'turn-boundary'
  | 'before-compaction'
  | 'before-pause'
  | 'verification-failure'
  | 'before-suspension'

/**
 * Everything needed to reconstruct kernel state for one task without replaying
 * the session tail. The session log stays the source of truth; this record is
 * the index a resume reads.
 */
export interface Checkpoint {
  /** Stable checkpoint identity. */
  readonly checkpointId: CheckpointId
  /** Task the checkpoint belongs to. */
  readonly taskId: TaskId
  /** Run the checkpoint belongs to. */
  readonly runId: RunId
  /** Session whose log the checkpoint indexes. */
  readonly agentSessionId: SessionId
  /** Session sequence the checkpoint covers. */
  readonly sessionSeq: SessionLogOffset
  /** Task status at checkpoint time. */
  readonly status: TaskStatus
  /** Task revision at checkpoint time. */
  readonly revision: number
  /** Budget observation at checkpoint time. */
  readonly budgets: BudgetSnapshot
  /** Actions proposed but not yet committed. */
  readonly openActionIds: readonly ActionId[]
  /** Failures with no accepted recovery. */
  readonly unresolvedFailures: readonly FailureRef[]
  /** Why the checkpoint was recorded. */
  readonly reason: CheckpointReason
  /** Unix epoch milliseconds the checkpoint was recorded. */
  readonly createdAt: number
}

/** What the kernel knows about one session's task, derived from its log. */
export interface KernelView {
  /** The current task contract. */
  readonly task: TaskContract
  /** Session the task belongs to. */
  readonly sessionId: SessionId
  /** Current budget observation. */
  readonly budgets: BudgetSnapshot
  /** Actions proposed but not yet committed. */
  readonly openActionIds: readonly ActionId[]
  /** Failures with no accepted recovery. */
  readonly unresolvedFailures: readonly FailureRef[]
  /** Latest recorded plan revision, when the task has one. */
  readonly plan?: PlanRevision
  /** Latest recorded checkpoint, when the task has one. */
  readonly checkpoint?: Checkpoint
}

/** The kernel's read model over one live agent's durable log. */
export interface KernelStateReader {
  /**
   * Derive the current kernel view for one session.
   * @param session - the accepted session whose log is folded.
   * @returns the task view, or undefined when no `task/created` event exists.
   */
  view(session: Session): KernelView | undefined
}

/** The registry of tool capability declarations. */
export interface CapabilityRegistry {
  /**
   * Register one tool's capability declaration.
   * @param declaration - the declaration; registering a tool twice replaces the earlier one.
   * @returns a disposer that removes exactly this declaration.
   */
  register(declaration: CapabilityDeclaration): () => void
  /**
   * Resolve the capability requests one invocation needs.
   * @param toolName - registered tool name.
   * @param args - the call's parsed arguments.
   * @returns the requests, or undefined when the tool declared none.
   */
  resolve(toolName: string, args: unknown): readonly CapabilityRequest[] | undefined
  /**
   * Whether one tool declared capabilities.
   * @param toolName - registered tool name.
   * @returns true when a declaration is registered.
   */
  has(toolName: string): boolean
  /** Number of registered declarations. */
  readonly size: number
}

/** The permission-rule evaluator. */
export interface PolicyEngine {
  /**
   * Evaluate one action against the compiled permission document.
   * @param context - the action, its capabilities, and the composed boundaries.
   * @returns the rule decision, before sandbox and human composition.
   */
  evaluate(context: PolicyContext): PolicyDecision
}

/** The completion gate. */
export interface VerificationGate {
  /**
   * Build the verification request for one task revision.
   * @param task - the task to verify.
   * @param changedScopes - scopes the task changed.
   * @returns the request to evaluate.
   */
  request(task: TaskContract, changedScopes: readonly string[]): VerificationRequest
  /**
   * Aggregate per-criterion outcomes into one result.
   * @param request - the request the results answer.
   * @param results - per-criterion outcomes.
   * @param commands - commands the verifier ran.
   * @returns the aggregated result; `pass` requires every criterion to pass.
   */
  evaluate(request: VerificationRequest, results: readonly CriterionResult[], commands: readonly string[]): VerificationResult
  /**
   * Decide whether a task may be reported complete.
   * @param task - the task being considered.
   * @param result - the verification result for the task's revision.
   * @param unresolvedFailures - failures with no accepted recovery.
   * @param budgets - the task's budget observation.
   * @returns the decision and every reason behind it.
   */
  decide(
    task: TaskContract,
    result: VerificationResult,
    unresolvedFailures: readonly FailureRef[],
    budgets: BudgetSnapshot,
  ): CompletionDecision
}

/** What the recovery engine reads to classify one failure. */
export interface RecoveryInput {
  /** The recorded failure. */
  readonly failure: FailureRecord
  /** Attempts already spent on the failed action. */
  readonly attempts: number
  /** Configured cap on attempts per action. */
  readonly maxAttemptsPerAction: number
}

/** The failure classifier and recovery chooser. */
export interface RecoveryEngine {
  /**
   * Classify one failure and choose its recovery.
   * @param input - the failure, its attempt count, and the configured cap.
   * @returns the decided recovery.
   */
  classify(input: RecoveryInput): RecoveryDecision
}

/** The task budget observer. */
export interface BudgetGovernor {
  /**
   * Measure one session's task budget use against its configured ceilings.
   * @param task - the task whose configured ceilings apply.
   * @param session - the session whose events are counted.
   * @returns the observation and the remaining allowance.
   */
  measure(task: TaskContract, session: Session): BudgetSnapshot
}

/** The attachment one live agent holds to its kernel task. */
export interface KernelAttachment {
  /** Task the agent is attached to. */
  readonly taskId: TaskId
  /** Run the agent is attached to. */
  readonly runId: RunId
  /**
   * Read the attachment's current state.
   * @returns the current kernel view.
   */
  snapshot(): KernelView
  /**
   * Detach the agent from its task.
   * @returns a promise that settles when the attachment is released.
   */
  dispose(): Promise<void>
}

/** The kernel's public surface on the Cordis context (`ctx.agentKernel`). */
export interface AgentKernel {
  /** Durable task state read model. */
  readonly state: KernelStateReader
  /** Permission-rule evaluator. */
  readonly policy: PolicyEngine
  /** Tool capability registry. */
  readonly capabilities: CapabilityRegistry
  /** Completion gate. */
  readonly verification: VerificationGate
  /** Failure classifier and recovery chooser. */
  readonly recovery: RecoveryEngine
  /** Task budget observer. */
  readonly budgets: BudgetGovernor
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A task contract was opened for this session. The event payload is the
     * complete contract at creation, always `status: 'intake'`,
     * `revision: 1`. Log-only: it never enters model context.
     */
    'task/created': TaskContract
    /**
     * One accepted task-state transition. The fold of these events over
     * `task/created` is the task's current status and revision; a transition
     * that does not satisfy the legal edge table or the current revision is
     * never appended. Log-only.
     */
    'task/transitioned': StateTransition
    /**
     * One plan revision, either the initial plan or a recovery amendment
     * carrying the failure it answers. Log-only.
     */
    'task/plan': PlanRevision
    /**
     * One proposed action, written immediately before its policy evaluation so
     * a crash between proposal and decision still records what was asked.
     * Log-only.
     */
    'action/proposed': ActionProposal
    /**
     * The composed runtime authorization for one action: an `allow`, or an
     * `ask` whose human outcome the action's `action/committed` governance
     * receipt records. Log-only audit.
     */
    'action/authorized': ActionDecisionEvent
    /**
     * An action the composed policy refused, whether by rule or by the
     * implementation's sandbox boundary. A denied action is never disguised as
     * a tool failure. Log-only.
     */
    'action/denied': ActionDecisionEvent
    /**
     * The settled outcome of one executed action, paired with its proposal by
     * `actionId`. Log-only.
     */
    'action/committed': ActionReceipt
    /**
     * The permission rules' decision about one action, written before the
     * sandbox and human answerer are composed into the authorization.
     * Log-only.
     */
    'policy/decision': {
      proposal: ActionProposal
      decision: PolicyDecision
    }
    /**
     * Capabilities granted to one action. Log-only audit; a grant never widens
     * the deployment sandbox.
     */
    'capability/grant': CapabilityGrant
    /**
     * A verification was requested for one task revision. Log-only.
     */
    'verification/requested': VerificationRequest
    /**
     * The outcome of one verification, including the per-criterion results the
     * completion gate reads. Log-only.
     */
    'verification/result': VerificationResult
    /**
     * One classified failure. Log-only; a policy denial or approval rejection
     * is recorded here with its own kind rather than as a tool error.
     */
    'failure/recorded': FailureRecord
    /**
     * The recovery chosen for one failure, including whether the action may be
     * retried under the same action id. Log-only.
     */
    'recovery/decided': RecoveryDecision
    /**
     * A checkpoint indexing one task's kernel state at a session sequence.
     * Log-only.
     */
    'checkpoint/created': Checkpoint
  }
}
