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
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
// Type-only: declares the `goal/change` Session event a task graph folds.
import type { GoalRef } from '@deepseek-ai/dsh-goal'

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// Type-only: declares the §10.5 coding-lifecycle service an `AgentKernel` exposes.
import type { CodingLifecycle } from './coding-lifecycle.ts'

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

/** Identity of one issued delegation receipt. */
export type DelegationId = Branded<'DelegationId'>

/** Identity of one budget reservation. */
export type BudgetReservationId = Branded<'BudgetReservationId'>

/** Identity of one recorded observation a claim may cite. */
export type EvidenceId = Branded<'EvidenceId'>

/** Identity of one claim a task asserts. */
export type TaskClaimId = Branded<'TaskClaimId'>

/** Identity of one question a task is testing. */
export type TaskHypothesisId = Branded<'TaskHypothesisId'>

/**
 * How far content or a decision may be trusted. Untrusted content is data: it
 * never becomes an instruction authority and never widens a grant.
 */
export type TrustLabel = 'trusted' | 'untrusted' | 'unknown'

/** Who caused a durable kernel record. */
export type ActorKind = 'user' | 'model' | 'kernel' | 'tool' | 'system'

/**
 * What kind of work a task is. The class decides which acceptance criteria the
 * task starts from and whether the completion gate demands one at all: a
 * conversational task answers without a criterion, while a coding, research, or
 * operations task is held to the criteria its deployment configured for that
 * class.
 */
export type TaskClass = 'conversational' | 'coding' | 'research' | 'operations'

/** Every task class, for configuration schemas and exhaustive switches. */
export const TASK_CLASSES: readonly TaskClass[] = ['conversational', 'coding', 'research', 'operations']

/** Source reference for a kernel record's content. */
export interface SourceRef {
  /** Emitting subsystem or external boundary. */
  readonly source: 'user' | 'model' | 'repo' | 'tool' | 'web' | 'mcp' | 'subagent' | 'policy' | 'kernel'
  /** Repository-relative path, URL, or tool call id locating the content, when one exists. */
  readonly locator?: string
  /** Content digest recorded for audit, when the producer computed one. */
  readonly digest?: string
}

/** Versioned identity and source reference shared by every new kernel Session event. */
export interface KernelEventMetadata {
  /** Kernel event schema version. */
  readonly version: 1
  /** Durable run this event belongs to. */
  readonly runId: RunId
  /** Durable task this event belongs to, when task intake has occurred. */
  readonly taskId?: TaskId
  /** Actor that caused this event. */
  readonly actor: ActorKind
  /** Unix epoch milliseconds when the record was written. */
  readonly timestamp: number
  /** Source and locator for the fact recorded. */
  readonly sourceRef: SourceRef
}

/** An event payload with audit metadata; optional only for historical records. */
export type KernelEventData<T extends object> = T & { readonly metadata?: KernelEventMetadata }

/**
 * Task lifecycle state. The kernel owns these; `turn/step` state stays with
 * `core/agent-loop` and is not duplicated here.
 *
 * A status exists only while a named producer reaches it: `intake` at
 * intake, `planning` when plan mode is entered, `ready` at first-step
 * admission, `executing`/`observing` around a step, `verifying` at turn end,
 * `recovering` when recovery starts, `awaiting-approval` from the approval
 * linkage, `awaiting-user`, `paused` from a budget or liveness stop, and the
 * terminal three from the completion gate or a cancellation.
 */
export type TaskStatus =
  | 'intake'
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

/**
 * The seven states the runtime task model projects onto. Kernel statuses are
 * finer than this vocabulary because the harness distinguishes states a caller
 * of the runtime model does not act on differently — `planning`, `observing`,
 * and `recovering` are all work in progress, and the three waiting statuses are
 * all a task that cannot proceed without a human. Every kernel status maps onto
 * exactly one state through `specStateOf`.
 */
export type TaskSpecState =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'verifying'
  | 'failed'
  | 'completed'

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
  /**
   * Which verifier family can evaluate the criterion: `build`, `test`, `lint`,
   * `typecheck`, `diff`, `security`, `browser`, `review` (an independent
   * reviewer), or the generic `assertion`, `human`, and `research` families
   * (§8.1). A deployment resolves no family the kernel ships no verifier for,
   * so the criterion stays `unknown` until one is registered.
   */
  readonly verifier: 'test' | 'build' | 'diff' | 'assertion' | 'human' | 'research'
    | 'lint' | 'typecheck' | 'security' | 'browser' | 'review'
  /** Whether a failed or unknown result blocks completion. */
  readonly required: boolean
}

/**
 * The boundary a task declares before it modifies anything: what it expects to
 * touch, what it may touch, what must survive it, and what it must not do. The
 * declaration is durable — it rides the task contract the `task/created` event
 * records — so the boundary a change was held to is reconstructable from the
 * session log after the fact.
 *
 * Every list holds globs matched against the changed scopes the
 * `workspace/changes` recorder published for the turn, in the same form the
 * `diff` verifier family already compares: workspace-relative POSIX paths, with
 * picomatch `dot: true` semantics (`**` spans `/`, `*` and `?` stop at `/`). A
 * verifier a deployment claims the boundary criterion for does the comparison;
 * this record only states the boundary, and a task that declares none is
 * checked by nothing.
 */
export interface ChangeContract {
  /** What the change is for; the statement its boundary is declared under. */
  readonly goal: string
  /**
   * Globs the change is expected to touch. Each one must select at least one
   * changed scope, so a change that skips an expected file fails its boundary.
   */
  readonly expectedFiles: readonly string[]
  /**
   * Globs the change may touch. Every changed scope must match one of them, so
   * a change outside the declared boundary fails. An empty list allows any
   * workspace-relative scope.
   */
  readonly allowedFiles: readonly string[]
  /**
   * Globs the change must leave unchanged: a changed scope matching one fails
   * the boundary, so an artifact that has to survive the change is declared
   * here rather than described in prose.
   */
  readonly mustPreserve: readonly string[]
  /**
   * Globs the change must not touch at all: a changed scope matching one fails
   * the boundary. Unlike {@link mustPreserve}, which names what the change must
   * leave as it is, this names the work the change is to stay out of.
   */
  readonly forbiddenChanges: readonly string[]
  /**
   * Globs of test files the change is expected to include. Each one must select
   * at least one changed scope, so a change that adds behavior without touching
   * the tests it declares fails its boundary.
   */
  readonly expectedTests: readonly string[]
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
  /** Concurrent actions the task may have in flight. */
  readonly maxConcurrentActions?: number
}

/**
 * What background work has spent, as the background budget owner reports it.
 * The governor reads this and enforces nothing: `guard/budgets` still bounds
 * what a session may spend, and the background owner still gates its own
 * calls. The two are read together so one caller sees a session's own use and
 * the background draw on the same deployment.
 */
export interface BackgroundSpend {
  /** Tokens background work spent. */
  readonly tokens: number
  /** Wall-clock milliseconds background work spent. */
  readonly wallMs: number
  /**
   * Billed cost in the background owner's own cost units, absent when it
   * measured none. Absent is not zero, and these units are the owner's: a
   * deployment that bills background work in USD states that, and one that
   * bills in tokens does not make this figure comparable to `maxCostUsd`.
   */
  readonly cost?: number | undefined
}

/** Observed resource use of one task, plus what remains of its configured budget. */
export interface BudgetSnapshot {
  /** `step/start` events observed for the task's session. */
  readonly steps: number
  /** `tool/call` events observed for the task's session. */
  readonly toolCalls: number
  /** Provider-reported tokens the session's completed turns were billed for. */
  readonly tokens: number
  /** Wall-clock milliseconds since the task was created. */
  readonly wallMs: number
  /** Remaining allowance per configured ceiling; an unbounded ceiling is absent. */
  readonly remaining: ResourceBudget
  /**
   * What background work has spent, when a background budget owner is
   * mounted. Absent in every deployment that runs no background evolution
   * work, which is not a zero: no background budget recorded anything. It is
   * reported beside the session's own use and debits nothing — the remaining
   * allowance above is the session's alone, and `guard/budgets` is what
   * enforces it.
   */
  readonly background?: BackgroundSpend
}

/**
 * One hold a session placed on its own remaining allowance for work that is
 * about to run: a child agent or workflow that spends before it settles. The
 * hold is live process state — it bounds what the session can still promise
 * while that work is in flight — and the durable record of the promise is the
 * delegation receipt (`delegation/issued`).
 */
export interface BudgetReservation {
  /** Identity of this hold; its settlement names it. */
  readonly reservationId: BudgetReservationId
  /** Session whose allowance is held. */
  readonly sessionId: SessionId
  /** Run the hold was placed for, when the caller knew it. */
  readonly runId?: RunId
  /**
   * Ceilings held, per spend axis. A request is capped at what the session had
   * available, and an axis the session does not bound is absent: an unbounded
   * session promises unbounded allowances on it.
   */
  readonly amount: ResourceBudget
  /** Unix epoch milliseconds the hold was placed. */
  readonly at: number
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
  /**
   * Boundary the task declared before it modified anything, when the caller
   * declared one. Absent means the task states no bound, which is how every
   * task that declares none keeps the behavior it had before this field
   * existed.
   */
  readonly changeContract?: ChangeContract
  /**
   * Tasks this one starts after. A dependency may name a task this session
   * never created — a delegated sibling's contract lives in the sibling's own
   * session — so a dependency is an ordering statement, not a resolvable
   * reference.
   */
  readonly dependencies: readonly TaskId[]
  /** Observations recorded for this task, in log order; the records themselves are `Evidence`. */
  readonly evidence: readonly EvidenceId[]
  /** Workspace the task's file policy is bounded to, when the session has one. */
  readonly workspace?: WorkspaceRef
  /** Enclosing task, when this task was delegated. */
  readonly parentTaskId?: TaskId
  /** Agent profile the task runs under. */
  readonly agentProfile: string
  /**
   * Class of work this task is. Absent on records written before the field
   * existed, which read as `conversational`.
   */
  readonly taskClass?: TaskClass
  /** Policy profile the task runs under. */
  readonly policyProfile: string
  /** Ceilings the task may spend. */
  readonly budget: ResourceBudget
  /** Current lifecycle state. */
  readonly status: TaskStatus
  /** Positive revision; every accepted transition increments it. */
  readonly revision: number
}

/**
 * A task contract as a session log recorded it. The graph fields are absent on
 * a contract written before they existed, and a reader takes that absence as a
 * task that declares no dependency and holds no observation.
 */
export type RecordedTaskContract =
  & Omit<TaskContract, 'dependencies' | 'evidence'>
  & Partial<Pick<TaskContract, 'dependencies' | 'evidence'>>

/** Caller-supplied intake for a new task. */
export interface TaskInput {
  /** The human- or caller-stated objective; empty when none was stated yet. */
  readonly objective: string
  /** Bounds the objective must respect. */
  readonly constraints?: readonly Constraint[]
  /** Criteria a completion decision must satisfy. */
  readonly acceptance?: readonly AcceptanceCriterion[]
  /**
   * Boundary the change is declared to stay inside. Intake resolves it: a
   * blank glob or an empty goal is refused there, and absent means the task
   * declares no bound.
   */
  readonly changeContract?: ChangeContract
  /**
   * Tasks this one starts after; a repeated identity or the task's own
   * identity is refused. Absent means the task depends on nothing.
   */
  readonly dependencies?: readonly TaskId[]
  /** Workspace the task's file policy is bounded to. */
  readonly workspace?: WorkspaceRef
  /** Enclosing task, when this task was delegated. */
  readonly parentTaskId?: TaskId
  /** Agent profile the task runs under; a registered profile supplies the rest of the role. */
  readonly agentProfile: string
  /**
   * Policy profile the task runs under. Omitted means the kernel resolves it:
   * the registered agent profile's own policy profile, else the deployment's
   * configured default. A caller that names one overrides the role.
   */
  readonly policyProfile?: string
  /** Ceilings the task may spend. */
  readonly budget?: ResourceBudget
  /**
   * Class of work this task is. Omitted means the kernel resolves it: the
   * registered agent profile's own class, else the mutation heuristic, else the
   * deployment default.
   */
  readonly taskClass?: TaskClass
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
  | 'plan-recorded'
  | 'plan-mode-entered'
  | 'plan-mode-exited'
  | 'approval-decided'
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
  /**
   * Observations recorded for the task when the transition was evaluated, in
   * log order. The refs answer which observations the contract held at that
   * revision; a transition a task with no recorded observation made cites none.
   */
  readonly evidence: readonly EvidenceId[]
  /** Task revision the transition was evaluated against. */
  readonly taskRevision: number
  /** Task revision produced by the transition. */
  readonly revision: number
  /**
   * Policy decision recorded for the action that caused the transition, when
   * the transition follows one. A transition the kernel decides on its own —
   * a step admission, a turn boundary, a budget stop — records none.
   */
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

/** Caller-supplied facts about one plan revision beyond its steps. */
export interface PlanOptions {
  /**
   * Whether a human approved this revision. Approval is what makes an
   * amendment legal without a failure reference, because the revision answers
   * a review rather than the model's own rewrite.
   */
  readonly approvedBy?: 'user'
  /**
   * Tool call whose result recorded this plan. The transition that records the
   * plan then cites the policy decision that admitted that call, when the log
   * recorded one.
   */
  readonly callId?: ToolCallId
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
  | 'git.read'
  | 'git.write'
  | 'process.exec'
  | 'terminal.interactive'
  | 'network.read'
  | 'network.write'
  | 'browser.read'
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
  /**
   * Trust of the content a call to this tool acts on, when the declaring
   * package knows it. A tool that carries content from outside the trust
   * boundary — an MCP server, a fetch, a web search — declares `untrusted`, and
   * a deployment quarantining untrusted content then requires a human answer
   * before such a call runs. Omitted means the trust is unknown to the kernel,
   * which the policy engine treats exactly like an undeclared capability.
   */
  readonly trust?: TrustLabel
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
  | 'browser'
  | 'network'
  | 'mcp'
  | 'delegate'
  | 'workflow'
  | 'memory'
  | 'policy'

/** What a policy rule or default decides. */
export type PolicyEffect = 'allow' | 'ask' | 'deny'

/** A capability rule; the last matching rule decides that capability. */
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
  /** Rules in declaration order; deny dominates across capabilities, then ask, then allow. */
  rules: PolicyRule[]
}

/** Session-selected policy layer that must not widen the deployment policy. */
export interface PolicyProfileSelection {
  /** Profile identity recorded with task and action decisions. */
  readonly profile: string
  /** Additional policy intersected with the deployment document. */
  readonly document?: PolicyDocument
}

/** Resolves the currently selected policy layer for one session. */
export interface PolicyProfileProvider {
  /**
   * Resolve one session's selected policy profile.
   * @param session - session whose current preset is read.
   * @returns the profile and optional restriction, or undefined when no selection applies.
   */
  resolve(session: Session): PolicyProfileSelection | undefined
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
  /**
   * The delegation a child agent acts under, absent for a root agent. A child
   * can never widen it: a capability, resource, or depth the receipt withholds
   * is refused no matter what the rules or the state say.
   */
  readonly parentGrant?: DelegationReceipt
  /**
   * The capability grant of the agent profile the task was created under,
   * absent when that name resolves to no registered profile. A role narrows
   * what an agent may do: a capability outside the grant is refused even when a
   * permission rule would allow it, because the rule decides what this
   * deployment permits, and the profile decides what this role is for. A child
   * inherits the intersection, never the union, of both.
   */
  readonly agentGrant?: readonly Capability[]
}

/**
 * The kernel's enforceable slice of one agent role: what this kind of agent is
 * for, which capabilities it may ever use, the permission document that
 * decides its actions, and the ceilings it starts from.
 *
 * A profile is a ROLE boundary, not a second task. The model and context
 * policy of a role belong to the packages that own models and context — the
 * model router and the context compiler — and a deployment selects them by
 * composing a preset for that role; restating them here would give the kernel
 * a second, silently diverging copy of decisions it does not make.
 */
export interface AgentProfile {
  /** Name tasks record as `agentProfile` and the registry resolves. */
  readonly id: string
  /** Human-readable role this profile stands for. */
  readonly role: string
  /**
   * Every capability this role may ever use. An action needing a capability
   * outside this list is refused regardless of the permission document, so a
   * rule that allows it for another role cannot widen this one. An empty list
   * refuses every action.
   */
  readonly capabilities: readonly Capability[]
  /** Policy profile name the kernel resolves for tasks created under this role. */
  readonly policyProfile: string
  /** Ceilings tasks created under this role start from. */
  readonly budget: ResourceBudget
  /** Class of work this role's tasks default to; absent means the deployment's. */
  readonly taskClass?: TaskClass
}

/**
 * One agent profile as configuration declares it. The configuration schema
 * materializes a mutable `capabilities` array, so the registered
 * {@link AgentProfile} keeps the immutable copy.
 */
export interface AgentProfileConfig {
  /** Name tasks record as `agentProfile` and the registry resolves. */
  readonly id: string
  /** Human-readable role this profile stands for. */
  readonly role: string
  /** Every capability this role may ever use; empty refuses every action. */
  readonly capabilities: Capability[]
  /** Policy profile name tasks created under this role run under. */
  readonly policyProfile: string
  /** Ceilings tasks created under this role start from. */
  readonly budget: ResourceBudget
  /** Class of work this role's tasks default to; absent means the deployment's. */
  readonly taskClass?: TaskClass
}

/** The registry `ctx.agentKernel.profiles` names: the roles this deployment defines. */
export interface AgentProfileRegistry {
  /**
   * Register one role.
   * @param profile - the profile; registering the same id twice replaces the earlier one.
   * @returns a disposer that removes exactly this registration.
   */
  register(profile: AgentProfile): () => void
  /**
   * Resolve one role by the name a task records.
   * @param id - the profile id.
   * @returns the profile, or undefined when this deployment registered none.
   */
  resolve(id: string): AgentProfile | undefined
  /** Every registered profile, in registration order. */
  readonly list: readonly AgentProfile[]
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
  /** A matched rule associated with the final effect, or null when defaults decide; reasons retain each capability's winner. */
  readonly matchedRuleIndex: number | null
  /** All capability requests included in the evaluation. */
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
  /**
   * The delegation the action ran under, when the acting agent is a child. A
   * refusal names the receipt that withheld it, so an audit can tell a
   * delegation refusal from a rule refusal without folding the log again.
   */
  readonly delegationId?: DelegationId
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
 * One tool call's whole authorization in a single record: what was proposed,
 * what the permission rules decided, and the composed answer the pipeline acted
 * on, including the capabilities that answer granted. A steady-state tool call
 * appends this and its commit, and nothing else.
 */
export interface ActionDecidedEvent extends ActionDecisionEvent {
  /** The permission rules' decision, before the sandbox and the human are composed. */
  readonly policy: PolicyDecision
}

/** One action's settle: its receipt and the grants that ended with it. */
export interface ActionCommittedEvent extends ActionReceipt {
  /** Action-scoped grants the settle ended; empty when the action held none. */
  readonly revoked: readonly CapabilityGrant[]
}

/** One capability granted to one action, which its action's settle ends. */
export interface CapabilityGrant {
  /** Action the grant belongs to. */
  readonly actionId: ActionId
  /** Capabilities granted. */
  readonly capabilities: readonly Capability[]
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
  /**
   * Digest of the result the action returned. Two calls with the same tool and
   * arguments and the same digest told the model nothing new, which is what the
   * no-progress detector counts.
   */
  readonly resultDigest?: string
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
  // §8.5: a repair passed its own targeted verification and broke a criterion
  // that an earlier verification of the same task had passed.
  | 'verification-regressed'
  | 'subagent-failed'
  | 'workflow-failed'
  | 'persistence-failed'
  | 'prompt-injection'
  // Loop-robustness failures (amendment S4): each names a way a run stops
  // making progress without failing outright.
  | 'output-truncated'
  | 'tool-args-malformed'
  | 'no-progress'
  | 'stalled'
  | 'step-ceiling'
  // Amendment §7.4: the observed action sequence stopped following the plan
  // the task recorded.
  | 'plan-drift'
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

/** One recovery pass began for a recorded failure. */
export interface RecoveryStartedRecord {
  /** Failure whose recovery began. */
  readonly failureId: FailureId
  /** Classification the recovery engine will decide for. */
  readonly kind: FailureKind
  /** Unix epoch milliseconds when recovery began. */
  readonly startedAt: number
}

/**
 * What the governor decided for one step. The six non-`stop` members ask for a
 * different next action and are recorded only; the five `stop` members end the
 * run at the next step boundary, which the kernel enforces by refusing
 * `agent/pre-step` in `mode: 'enforce'`.
 *
 * `stop_success` and `stop_failure` name the task's own terminal status,
 * `stop_budget` an exhausted ceiling, `stop_loop` a detector that found the run
 * repeating itself, and `stop_timeout` a liveness window that elapsed with no
 * progress.
 */
export type GovernorDecision =
  | 'continue'
  | 'retry'
  | 'replan'
  | 'compact'
  | 'delegate'
  | 'ask_user'
  | 'stop_success'
  | 'stop_failure'
  | 'stop_budget'
  | 'stop_loop'
  | 'stop_timeout'

/**
 * The movement one step made, each axis normalized to `[0, 1]` from the
 * events the step produced: 0 is a step that moved nothing on that axis.
 *
 * Counts of calls, transitions, observations, goal changes, resolved failures,
 * and plan revisions all collapse onto these axes because a step's *movement*
 * is what the governor reads, not how much of it there was: one new tool call
 * and five new tool calls both mean the step left the state it started from.
 */
export interface StepDelta {
  /**
   * Share of the step's tool calls whose tool and arguments were unseen in the
   * recent call history; 0 for a step that called no tool.
   */
  readonly toolNovelty: number
  /** 1 when the task advanced a revision during the step. */
  readonly stateDelta: number
  /** 1 when the step recorded an observation or a claim. */
  readonly evidenceGain: number
  /** 1 when the session's goal moved during the step. */
  readonly goalProgress: number
  /** 1 when the step left fewer unresolved failures behind than it found. */
  readonly errorReduction: number
  /** 1 when the step recorded a plan revision. */
  readonly planProgress: number
}

/**
 * Which layer of a run went quiet when the liveness window elapsed with no
 * progress. The distinction is what a reader acts on: a `tool` stall is one
 * call that never settled, a `transport` stall is a request that produced no
 * frame at all, a `stream` stall is a stream that started and stopped, an
 * `agent` stall is a run with no work in flight, and a `child-agent` stall is a
 * delegated child that stopped reporting.
 */
export type TimeoutKind = 'tool' | 'transport' | 'stream' | 'agent' | 'child-agent'

/**
 * One step's measured progress and the governor's decision for the next step,
 * with the reasons behind it. The record is the durable form of a decision the
 * kernel otherwise holds only in memory, so a replay reconstructs why a run
 * stopped without the process that stopped it.
 */
export interface GovernorDecisionRecord {
  /** Decision composed for the step that follows. */
  readonly decision: GovernorDecision
  /** Every fact that produced the decision, in evaluation order. */
  readonly reasons: readonly string[]
  /** Movement the step that just ended made. */
  readonly delta: StepDelta
  /** Mean of the delta's axes, in `[0, 1]`. */
  readonly progressScore: number
  /** Turn the decision was composed for. */
  readonly turn: number
  /** Step the decision was composed for. */
  readonly step: number
  /** Kind of timeout the decision answers, when it answers one. */
  readonly timeout?: TimeoutKind
  /** Unix epoch milliseconds the decision was recorded. */
  readonly at: number
}

/**
 * The family a failure belongs to. The category groups how many kinds there are
 * into what a reader acts on: one model call, one tool call, one boundary
 * refusal, one check that did not hold, one limit that ran out, one run that
 * stopped moving, or one write that did not land.
 */
export type FailureCategory =
  | 'model'
  | 'tool'
  | 'policy'
  | 'approval'
  | 'verification'
  | 'budget'
  | 'liveness'
  | 'persistence'
  | 'environment'

/** How much one failure threatens the task it belongs to. */
export type FailureSeverity = 'low' | 'medium' | 'high' | 'critical'

/** What the task itself knew when a failure was diagnosed. */
export interface DiagnosisFacts {
  /** Observations recorded for the task at diagnosis time, in log order. */
  readonly evidence: readonly EvidenceId[]
  /** Questions the task is testing at diagnosis time, in log order. */
  readonly hypotheses: readonly TaskHypothesisId[]
}

/**
 * What the kernel understood about one classified failure before choosing a
 * recovery: the family and severity, the task facts the failure is read
 * against, and the recovery ladder the diagnosis recommends. The diagnosis
 * never executes anything — it is the record the recovery decision and a later
 * repair prompt are read from.
 */
export interface FailureDiagnosis {
  /** Failure this diagnosis answers. */
  readonly failureId: FailureId
  /** Family the failure belongs to. */
  readonly category: FailureCategory
  /** How much the failure threatens the task. */
  readonly severity: FailureSeverity
  /**
   * Observations recorded for the task when the failure was diagnosed. A
   * failure carries no per-observation link, so a diagnosis cites the set the
   * task had recorded rather than asserting which of them bear on the failure.
   */
  readonly evidence: readonly EvidenceId[]
  /** Questions the task was testing when the failure was diagnosed. */
  readonly hypotheses: readonly TaskHypothesisId[]
  /** Recoveries this diagnosis recommends, in preference order. */
  readonly recommendedActions: readonly RecoveryAction[]
  /** Why the diagnosis reads this way. */
  readonly detail: string
  /** Unix epoch milliseconds the diagnosis was recorded. */
  readonly at: number
}

/**
 * The authority one parent run delegates to one child run. The kernel writes
 * the receipt into the child's own log before its first step, so a replay
 * reconstructs the child's authority without the parent's session.
 *
 * A receipt only ever withholds. Child authority is the intersection of this
 * grant with the child's profile, the deployment rules, and the child's own
 * sandbox, so a child cannot widen its permissions by choosing another
 * provider or by emitting a policy-like message.
 */
export interface DelegationReceipt {
  /** Identity of this receipt. */
  readonly delegationId: DelegationId
  /** Child run the receipt was issued to. */
  readonly childRunId: RunId
  /** Parent run that delegated, when the parent's task was resolvable. */
  readonly parentRunId?: RunId
  /** Parent task the child descends from, when the parent's task was resolvable. */
  readonly parentTaskId?: TaskId
  /** Durable parent session named by the child session's header. */
  readonly parentSessionId: SessionId
  /** Capabilities the child may use. An action needing another one is refused. */
  readonly allowedCapabilities: readonly Capability[]
  /** Ceilings the child's task contract starts with, inherited from the parent. */
  readonly resourceLimits: ResourceBudget
  /** Directories a mutating capability may target; empty refuses every mutation. */
  readonly writableScopes: readonly string[]
  /**
   * Digest of the permission document the grant was computed under, so a
   * reader can tell whether the child ran under the rules the parent did.
   */
  readonly inheritedPolicyDigest: string
  /** Delegation depth of the child: its parent's depth plus one. */
  readonly depth: number
  /** Deepest depth the parent's budget admits, when it declared one. */
  readonly maxDepth?: number
  /** Unix epoch milliseconds the receipt was issued. */
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
  /**
   * Digest of the repository state the criteria are verified against. A
   * criterion result is retained by this digest, so a repeated pass over an
   * unchanged repository reuses the decision while any change invalidates it.
   */
  readonly repositoryDigest: string
  /**
   * Boundary the task declared before it modified anything, when it declared
   * one. A verifier that checks a change boundary reads it here rather than
   * from live state, so a replayed log decides the same criterion.
   */
  readonly changeContract?: ChangeContract
}

/** Which family observed one piece of evidence. */
export type EvidenceKind = 'file' | 'tool-result' | 'web' | 'mcp' | 'test' | 'user' | 'model'

/**
 * One observation a claim may cite. The content stays where it lives — a file,
 * a logged tool result, an attachment — so this record holds only the
 * reference, the digest of what was observed, and how far it may be trusted.
 */
export interface Evidence {
  /** Identity of this observation. */
  readonly evidenceId: EvidenceId
  /** Family that observed it. */
  readonly kind: EvidenceKind
  /** Repository-relative path, URL, or tool call id locating the content. */
  readonly contentRef: string
  /** Digest of the observed content, when the observer could compute one. */
  readonly digest?: string
  /** Source and locator of the observation itself. */
  readonly sourceRef: SourceRef
  /** How far the observed content may be trusted. */
  readonly trust: TrustLabel
  /** Unix epoch milliseconds the content was observed. */
  readonly observedAt: number
}

/** How far the evidence behind a claim has established it. */
export type TaskClaimStatus = 'proposed' | 'supported' | 'contradicted' | 'stale' | 'rejected'

/**
 * One statement a task asserts, with the observations behind it. This is the
 * live task's research record; the cross-session claims `evolution-graph`
 * stores are a separate, promotion-scoped record.
 */
export interface TaskClaim {
  /** Identity of this claim. */
  readonly claimId: TaskClaimId
  /** The statement the task asserts. */
  readonly statement: string
  /** Evidence recorded in this session supporting or contradicting it. */
  readonly evidence: readonly EvidenceId[]
  /** Stated confidence in `[0, 1]`. */
  readonly confidence: number
  /** How far the evidence has established the statement. */
  readonly status: TaskClaimStatus
}

/** How far the tests behind a hypothesis have settled it. */
export type TaskHypothesisStatus = 'open' | 'supported' | 'refuted' | 'inconclusive'

/** One question a task is testing through claims and verifications. */
export interface TaskHypothesis {
  /** Identity of this hypothesis. */
  readonly hypothesisId: TaskHypothesisId
  /** The question being tested. */
  readonly question: string
  /** Claims recorded in this session that bear on it. */
  readonly claims: readonly TaskClaimId[]
  /** Verifications run against it. */
  readonly tests: readonly VerificationRequest[]
  /** How far those tests have settled the question. */
  readonly status: TaskHypothesisStatus
}

/** Caller-supplied fields of one observation. */
export interface EvidenceInput {
  /** Family that observed it. */
  readonly kind: EvidenceKind
  /** Repository-relative path, URL, or tool call id locating the content. */
  readonly contentRef: string
  /** Digest of the observed content, when the observer could compute one. */
  readonly digest?: string
  /** Source and locator of the observation itself. */
  readonly sourceRef: SourceRef
  /** How far the observed content may be trusted. */
  readonly trust: TrustLabel
}

/** Caller-supplied fields of one claim. */
export interface TaskClaimInput {
  /** The statement the task asserts. */
  readonly statement: string
  /** Observations recorded in this session, by identity. */
  readonly evidence?: readonly EvidenceId[]
  /** Stated confidence in `[0, 1]`. */
  readonly confidence: number
  /** How far the evidence has established the statement; `proposed` when omitted. */
  readonly status?: TaskClaimStatus
}

/** Caller-supplied fields of one hypothesis. */
export interface TaskHypothesisInput {
  /** The question being tested. */
  readonly question: string
  /** Claims recorded in this session, by identity. */
  readonly claims?: readonly TaskClaimId[]
  /** Verifications run against it. */
  readonly tests?: readonly VerificationRequest[]
  /** How far the tests have settled it; `open` when omitted. */
  readonly status?: TaskHypothesisStatus
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

/** One live agent resumed from a durable checkpoint. */
export interface CheckpointResumedRecord {
  /** Checkpoint the resumed session loaded. */
  readonly checkpointId: CheckpointId
  /** Session the checkpoint belongs to. */
  readonly agentSessionId: SessionId
  /** Session sequence covered by the checkpoint. */
  readonly sessionSeq: SessionLogOffset
  /** Unix epoch milliseconds when the session resumed. */
  readonly resumedAt: number
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
  /** Observations recorded for this task, in log order. */
  readonly evidence: readonly Evidence[]
  /** Claims asserted by this task, in log order. */
  readonly claims: readonly TaskClaim[]
  /** Questions this task is testing, in log order. */
  readonly hypotheses: readonly TaskHypothesis[]
  /** Diagnoses recorded for this task's failures, in log order. */
  readonly diagnoses: readonly FailureDiagnosis[]
  /** Latest recorded plan revision, when the task has one. */
  readonly plan?: PlanRevision
  /** Latest recorded checkpoint, when the task has one. */
  readonly checkpoint?: Checkpoint
  /** The delegation this session's agent acts under, when it is a child. */
  readonly delegation?: DelegationReceipt
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

/**
 * One task in a session's task graph. A node exists for every contract the log
 * records; a task delegated to a child agent is a node in the CHILD's graph,
 * reached through that child's own `parentTaskId`, because its contract is
 * written into the child's log.
 */
export interface TaskNode {
  /** Stable task identity; the graph is keyed by it. */
  readonly taskId: TaskId
  /** Run that executes the task. */
  readonly runId: RunId
  /** Objective the contract stated. */
  readonly objective: string
  /** Enclosing task, when the contract names one. */
  readonly parentTaskId?: TaskId
  /** Tasks the contract declares it starts after. */
  readonly dependencies: readonly TaskId[]
  /** Tasks of this session that name this task as their parent, in creation order. */
  readonly children: readonly TaskId[]
  /** Kernel lifecycle status the log last recorded. */
  readonly status: TaskStatus
  /** The seven-state runtime projection of {@link status}. */
  readonly state: TaskSpecState
  /** Contract revision the log last recorded. */
  readonly revision: number
  /**
   * Goal in force when the contract was created, absent when the session had
   * none. The goal is a session-scoped record, so this is the Goal→Task link a
   * task graph draws: revisions of the goal after creation are not this node's.
   */
  readonly goal?: GoalRef
}

/**
 * The tasks one session's log holds and the edges between them, folded on
 * demand. Nothing here is cached: the same log always produces the same graph.
 */
export interface TaskGraph {
  /** Every task the log records, in creation order. */
  readonly nodes: readonly TaskNode[]
  /**
   * One task's node.
   * @param taskId - the task to read.
   * @returns the node, or undefined when this log holds no such contract.
   */
  nodeOf(taskId: TaskId): TaskNode | undefined
  /**
   * The direct children of one task.
   * @param taskId - the parent task.
   * @returns the children in creation order; empty when the log holds none.
   */
  childrenOf(taskId: TaskId): readonly TaskId[]
  /**
   * The dependencies one task declared.
   * @param taskId - the dependent task.
   * @returns the dependencies in declaration order; empty when the task names none.
   */
  dependenciesOf(taskId: TaskId): readonly TaskId[]
  /**
   * Every task that descends from one task, breadth-first.
   * @param taskId - the task whose subtree is walked.
   * @returns the descendants in walk order; a task the log does not hold contributes none.
   */
  descendantsOf(taskId: TaskId): readonly TaskId[]
}

/** The task-graph read model over session logs. */
export interface TaskGraphReader {
  /**
   * Fold one session's log into its task graph.
   * @param session - the session whose `task/*` and `goal/change` events are folded.
   * @returns the graph; it holds no node when the log records no contract.
   */
  graphOf(session: Session): TaskGraph
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
  /**
   * The trust one tool declared for the content it acts on.
   * @param toolName - registered tool name.
   * @returns the declared trust, or undefined when the tool declared none.
   */
  trustOf(toolName: string): TrustLabel | undefined
  /** Number of registered declarations. */
  readonly size: number
}

/** The permission-rule evaluator. */
export interface PolicyEngine {
  /**
   * Evaluate each capability independently. The last matching rule decides
   * that capability; deny dominates across requests, then ask, then allow. An
   * action with no required capability fails closed.
   * @param context - the action, its capabilities, and the composed boundaries.
   * @returns the rule decision, before sandbox and human composition.
   */
  evaluate(context: PolicyContext): PolicyDecision
}

/** The completion gate. */
export interface VerificationGate {
  /**
   * Whether this deployment demands an acceptance criterion for the task's
   * class. A task with no criterion whose class demands none has nothing to
   * verify, and its completion is vacuous rather than unproven.
   * @param task - the task being considered.
   * @returns true when a missing criterion is itself a refusal reason.
   */
  requiredFor(task: TaskContract): boolean
  /**
   * Build the verification request for one task revision.
   * @param task - the task to verify.
   * @param changedScopes - scopes the task changed.
   * @param repositoryDigest - digest of the repository state the criteria are verified against.
   * @returns the request to evaluate.
   */
  request(task: TaskContract, changedScopes: readonly string[], repositoryDigest: string): VerificationRequest
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

/** How one persisted session's non-terminal task can proceed after restart. */
export type RecoveryScanClass = 'resumable' | 'repairable' | 'blocked'

/** One persisted session's startup recovery classification. */
export interface RecoveryScanEntry {
  /** The scanned session. */
  readonly sessionId: SessionId
  /** The classification this session's tail earned. */
  readonly classification: RecoveryScanClass
  /** Why, naming the task status and open-turn or read-failure evidence. */
  readonly reason: string
  /** The recorded task status, absent when the session could not be read. */
  readonly status?: TaskStatus
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
   * Diagnose one failure from its classification and the task's own facts.
   * @param input - the failure, its attempt count, and the configured cap.
   * @param facts - the observations and hypotheses the task had recorded.
   * @returns the diagnosis the recovery decision is made against.
   */
  diagnose(input: RecoveryInput, facts: DiagnosisFacts): FailureDiagnosis
  /**
   * Classify one failure and choose its recovery.
   * @param input - the failure, its attempt count, and the configured cap.
   * @returns the decided recovery.
   */
  classify(input: RecoveryInput): RecoveryDecision
}

/**
 * The task budget observer and reservation ledger. It reads both budget
 * owners — a session's own use, and what background work has spent on the
 * same deployment — and enforces neither: `guard/budgets` enforces the
 * in-session ceilings and the background owner gates its own spend.
 */
export interface BudgetGovernor {
  /**
   * Measure one session's task budget use against its configured ceilings.
   * @param task - the task whose configured ceilings apply.
   * @param session - the session whose events are counted.
   * @returns the observation, the remaining allowance, and the background
   * spend beside it when a background budget owner is mounted.
   */
  measure(task: TaskContract, session: Session): BudgetSnapshot
  /**
   * What one session can still promise: its measured remaining allowance less
   * the holds its in-flight work placed and the spend its settled children
   * reported, per axis. An axis the session does not bound is absent.
   * @param session - the session whose allowance is read.
   * @returns the still-uncommitted allowance, per bounded axis.
   */
  available(session: Session): ResourceBudget
  /**
   * Hold part of one session's allowance for work that is about to run, so a
   * second reservation made before the first settles is not promised the same
   * budget. The hold is capped at what the session has available; a caller asks
   * for what its child may spend and hands the returned amount on as the
   * child's grant.
   * @param session - the session whose allowance is held.
   * @param amount - the ceilings the work may spend.
   * @param runId - the run the hold is placed for, when the caller knows it.
   * @returns the hold, carrying the ceilings it placed.
   */
  reserve(session: Session, amount: ResourceBudget, runId?: RunId): BudgetReservation
  /**
   * Settle a hold: the work it covered finished, and `actual` is what that work
   * reported spending. The hold ends and the reported spend is debited from the
   * session's available allowance, so a child's consumption is never promised
   * again to its siblings. The session's measured remaining allowance is
   * unchanged, because the child's spend is its own session's. Settling a hold
   * that already ended does nothing.
   * @param reservationId - the hold being settled.
   * @param actual - what the work spent, per axis, when the caller measured it.
   */
  commit(reservationId: BudgetReservationId, actual?: ResourceBudget): void
  /**
   * Release a hold: the work it covered never ran, so nothing was spent.
   * Releasing a hold that already ended does nothing.
   * @param reservationId - the hold being released.
   */
  release(reservationId: BudgetReservationId): void
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
   * Detach the agent from its task. Plugin unload awaits this disposer for
   * every open attachment.
   * @returns a promise that settles when the attachment is released.
   */
  dispose(): Promise<void>
}

/** The kernel's public surface on the Cordis context (`ctx.agentKernel`). */
export interface AgentKernel {
  /** Durable task state read model. */
  readonly state: KernelStateReader
  /** Task-graph read model over the same session logs. */
  readonly taskGraph: TaskGraphReader
  /** Permission-rule evaluator. */
  readonly policy: PolicyEngine
  /**
   * Register the provider for session-selected policy layers.
   * @param provider - resolves the profile and optional policy restriction for each session.
   * @returns a disposer that removes this provider while it remains registered.
   * @throws when another policy profile provider is already registered.
   */
  registerPolicyProfileProvider(provider: PolicyProfileProvider): () => void
  /** Tool capability registry. */
  readonly capabilities: CapabilityRegistry
  /** Completion gate. */
  readonly verification: VerificationGate
  /**
   * The §10.5 coding lifecycle: the phases a task of class `coding` runs, the
   * independent reviewer the REVIEW phase spawns, and the phase log a caller
   * reads. A deployment supplies the reviewer through
   * `lifecycle.registerReviewer`.
   */
  readonly lifecycle: CodingLifecycle
  /** Failure classifier and recovery chooser. */
  readonly recovery: RecoveryEngine
  /**
   * Result of the one read-only scan started when session persistence becomes available.
   * @returns one recovery entry per non-terminal or unreadable stored session; rejects when listing fails.
   */
  readonly startupRecovery: Promise<readonly RecoveryScanEntry[]>
  /** Task budget observer and reservation ledger. */
  readonly budgets: BudgetGovernor
  /**
   * Attach one live agent to its durable task.
   * @param agent - the live agent whose session owns the task.
   * @returns a handle that reads the current task view and detaches on disposal.
   */
  attach(agent: Agent): KernelAttachment
  /**
   * Persist one caller-supplied task contract.
   * @param agent - the live agent whose session owns the task.
   * @param input - the objective, constraints, acceptance, profiles, workspace and budget.
   * @returns the task at its initial `intake` revision.
   */
  intake(agent: Agent, input: TaskInput): TaskContract
  /**
   * Record or amend a task plan.
   * @param agent - the live agent whose task owns the plan.
   * @param steps - ordered work items in the new plan revision.
   * @param failureId - unresolved failure that justifies an amendment.
   * @param options - who approved the revision and which action recorded it.
   * @returns the durable plan revision.
   */
  recordPlan(agent: Agent, steps: readonly string[], failureId?: FailureId, options?: PlanOptions): PlanRevision
  /**
   * Record one observation a claim may cite.
   * @param agent - the live agent whose task observed it.
   * @param input - what was observed, where it lives, and how far it may be trusted.
   * @returns the durable evidence record.
   */
  recordEvidence(agent: Agent, input: EvidenceInput): Evidence
  /**
   * Assert one claim against evidence this session recorded.
   * @param agent - the live agent whose task asserts it.
   * @param input - the statement, the evidence it cites, its confidence, and its status.
   * @returns the durable claim.
   */
  recordClaim(agent: Agent, input: TaskClaimInput): TaskClaim
  /**
   * Record one question a task is testing.
   * @param agent - the live agent whose task is testing it.
   * @param input - the question, the claims behind it, and the verifications run against it.
   * @returns the durable hypothesis.
   */
  recordHypothesis(agent: Agent, input: TaskHypothesisInput): TaskHypothesis
  /**
   * Read one agent's task snapshot.
   * @param agent - the live agent whose session is read.
   * @returns the current view, or undefined before task intake.
   */
  snapshot(agent: Agent): Promise<KernelView | undefined>
  /**
   * Read one live session's task view by identity.
   * The method resolves `ctx.agents` on each call; agent identity and disposal
   * remain registry-owned.
   * @param sessionId - the identity of the session to read.
   * @returns the view, or undefined when no live agent or task exists.
   */
  viewOf(sessionId: SessionId): KernelView | undefined
  /**
   * Verify one agent's current task.
   * @param agent - the live agent whose task is verified.
   * @param changedScopes - scopes the task changed.
   * @returns the completion decision, or undefined before task intake.
   */
  verify(agent: Agent, changedScopes?: readonly string[]): Promise<CompletionDecision | undefined>
  /**
   * Record a checkpoint of one agent's current task.
   * @param agent - the live agent whose task is checkpointed.
   * @param reason - why the checkpoint is recorded.
   * @returns the checkpoint, or undefined before task intake.
   */
  checkpoint(agent: Agent, reason: CheckpointReason): Checkpoint | undefined
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A task contract was opened for this session. The event payload is the
     * complete contract at creation, always `status: 'intake'`,
     * `revision: 1`. Log-only: it never enters model context.
     */
    'task/created': KernelEventData<TaskContract>
    /**
     * One accepted task-state transition. The fold of these events over
     * `task/created` is the task's current status and revision; a transition
     * that does not satisfy the legal edge table or the current revision is
     * never appended. Log-only.
     */
    'task/transitioned': KernelEventData<StateTransition>
    /**
     * One plan revision, either the initial plan or a recovery amendment
     * carrying the failure it answers. Log-only.
     */
    'task/plan': KernelEventData<PlanRevision>
    /**
     * One tool call's proposal, rule decision, composed authorization, and
     * granted capabilities in a single record. Log-only audit.
     */
    'action/decided': KernelEventData<ActionDecidedEvent>
    /**
     * The settled outcome of one executed action, paired with its decision by
     * `actionId`, with the action-scoped grants that ended with it. A tool call
     * in steady state appends `action/decided` and this, and nothing else.
     * Log-only.
     */
    'action/committed': KernelEventData<ActionCommittedEvent>
    /**
     * One observation a claim may cite, with the digest of what was seen and
     * how far the observed content may be trusted. Log-only: the content stays
     * where it lives.
     */
    'evidence/recorded': KernelEventData<Evidence>
    /**
     * The current state of one claim: its statement, the evidence it cites,
     * its confidence, and its status. Log-only.
     */
    'claim/updated': KernelEventData<TaskClaim>
    /**
     * The current state of one hypothesis: the question, the claims behind it,
     * the verifications run against it, and its status. Log-only.
     */
    'hypothesis/updated': KernelEventData<TaskHypothesis>
    /**
     * A verification was requested for one task revision. Log-only.
     */
    'verification/requested': KernelEventData<VerificationRequest>
    /**
     * The outcome of one verification, including the per-criterion results the
     * completion gate reads. Log-only.
     */
    'verification/result': KernelEventData<VerificationResult>
    /**
     * One classified failure. Log-only; a policy denial or approval rejection
     * is recorded here with its own kind rather than as a tool error.
     */
    'failure/recorded': KernelEventData<FailureRecord>
    /**
     * The kernel's diagnosis of one classified failure, recorded before its
     * recovery is decided: the family and severity, the task facts the failure
     * is read against, and the recovery ladder the diagnosis recommends.
     * Log-only.
     * @param failureId - failure the diagnosis answers.
     * @param category - family the failure belongs to.
     * @param severity - how much the failure threatens the task.
     * @param evidence - observations the task had recorded at diagnosis time.
     * @param hypotheses - questions the task was testing at diagnosis time.
     * @param recommendedActions - recoveries the diagnosis recommends, in preference order.
     * @param detail - why the diagnosis reads this way.
     * @param at - Unix epoch milliseconds the diagnosis was recorded.
     */
    'failure/diagnosed': KernelEventData<FailureDiagnosis>
    /** Recovery began for a classified failure. Log-only. */
    'recovery/started': KernelEventData<RecoveryStartedRecord>
    /**
     * The recovery chosen for one failure, including whether the action may be
     * retried under the same action id. Log-only.
     */
    'recovery/decided': KernelEventData<RecoveryDecision>
    /**
     * One step boundary's measured movement and the governor's decision for the
     * step that follows, with the reasons behind it. Log-only: it never enters
     * model context, and a step that moved something resolves the loop and
     * liveness failures recorded against the step that did not.
     */
    'governor/decided': KernelEventData<GovernorDecisionRecord>
    /**
     * A checkpoint indexing one task's kernel state at a session sequence.
     * Log-only.
     */
    'checkpoint/created': KernelEventData<Checkpoint>
    /** A checkpoint was loaded by the existing agent registry during resume. Log-only. */
    'checkpoint/resumed': KernelEventData<CheckpointResumedRecord>
    /**
     * The authority a child agent acts under, written into the CHILD's log
     * when its agent is created and before its task contract, so a replay
     * reconstructs the child's authority without the parent's session.
     * Log-only.
     */
    'delegation/received': KernelEventData<DelegationReceipt>
    /**
     * The same delegation, written into the PARENT's log so a parent records
     * what it handed down. The child's `delegation/received` is the authority.
     * Log-only.
     */
    'delegation/issued': KernelEventData<DelegationReceipt>
  }
}
