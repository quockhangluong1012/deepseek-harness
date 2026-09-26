/**
 * The agent kernel: a control-plane plugin that observes the existing agent and
 * tool seams and records what the harness decided.
 *
 * The kernel owns no execution. It derives one durable task contract per session
 * from the session log, proposes and authorizes each tool action through the
 * declared capability policy, commits an observation when the action settles,
 * and runs the completion gate when a task declares a required acceptance
 * criterion. `core/agent-loop` keeps turn and step ownership; `core/tools` keeps
 * dispatch; `sandbox-policy` keeps the technical boundary; `user-approval` keeps
 * the human decision.
 *
 * `mode: 'shadow'` (the default) records every decision and changes no behavior.
 * `mode: 'enforce'` returns the composed decision to the tool pipeline, where
 * `deny` blocks the call and `ask` routes through the composed approval
 * answerers.
 *
 * @module @deepseek-ai/dsh-agent-kernel
 */

import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
// Type-only: activates the `ctx.sandboxPolicy` Context declaration.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: declares the `compaction/start` Session event.
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: declares the `workspace/changes` Session event and `ctx.workspaceChanges`.
import type {} from '@deepseek-ai/dsh-workspace-changes'
import type { PreToolDecision, ToolExecution, ToolExecutionResult, ToolResult } from '@deepseek-ai/dsh-tools'
// Type-only: declares the `approval/asked` and `approval/decided` Session events.
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
// Type-only: activates the `ctx.evolutionBudget` Context declaration the
// background budget owner publishes. The kernel reads that owner through
// `ctx.get` and never imports its code, so a deployment that mounts no
// background budget owner pays nothing for the seam and no package cycle
// exists: `evolution-budget` depends on no kernel package.
import type {} from '@deepseek-ai/dsh-evolution-budget'
import { ToolCapabilityRegistry } from './capabilities.ts'
import { resolveChangeContract } from './change-contract.ts'
import { CodingLifecycle, CODING_PHASES, resolveCodingLifecycle } from './coding-lifecycle.ts'
import type { CodeReviewRecord, CodeReviewReport, CodingLifecycleConfig, CodingPhaseBudget, CodingPhaseRecord } from './coding-lifecycle.ts'
import { delegableBudget, delegationReceipt, policyDigest } from './delegation.ts'
import {
  countersOf,
  EXPECTS_PROGRESS,
  type GovernorThresholds,
  isStopDecision,
  livenessCheckMs,
  REPEATED_CALLS,
  resolveGovernorThresholds,
  SessionGovernor,
} from './governor.ts'
import { actionIdOf, KernelLedger, type LedgerEntry } from './ledger.ts'
import { planDriftRun } from './plan-drift.ts'
import { admittedCapabilities, CAPABILITY_VOCABULARY, compilePolicy, composeAuthorization, insideWorkspace, PermissionPolicyEngine, POLICY_ACTIONS, POLICY_EFFECTS } from './policy.ts'
import { KernelProfileRegistry } from './profiles.ts'
import { DefaultRecoveryEngine } from './recovery.ts'
import { scanForRecovery } from './recovery-scan.ts'
import { regressedCriteria, regressionDetail } from './regression.ts'
import { applyTransition, canTransition, isActive } from './state-machine.ts'
import { KernelTaskGraph } from './task-graph.ts'
import { TASK_CLASSES } from './types.ts'
import type {
  AgentKernel,
  BudgetGovernor,
  AcceptanceCriterion,
  ActionId,
  ActionProposal,
  ActionReceipt,
  ActorKind,
  AuthorizationDecision,
  BudgetReservationId,
  Capability,
  CapabilityGrant,
  CapabilityRegistry,
  Checkpoint,
  CheckpointId,
  CheckpointReason,
  TaskClaim,
  TaskClaimId,
  TaskClaimInput,
  CompletionDecision,
  DelegationId,
  Evidence,
  EvidenceId,
  EvidenceInput,
  FailureId,
  FailureKind,
  FailureRecord,
  PlanOptions,
  Predicate,
  RecoveryInput,
  RecoveryScanEntry,
  TaskHypothesis,
  TaskHypothesisId,
  TaskHypothesisInput,
  KernelEventMetadata,
  SourceRef,
  GovernanceReceipt,
  AgentProfileConfig,
  AgentProfileRegistry,
  KernelAttachment,
  KernelView,
  TrustLabel,
  PolicyContext,
  PolicyDocument,
  PolicyEngine,
  PolicyDecision,
  PolicyProfileProvider,
  PolicyProfileSelection,
  PlanRevision,
  ResourceBudget,
  RunId,
  StateEffect,
  StateTransition,
  TaskContract,
  TaskId,
  TaskClass,
  TaskInput,
  TaskStatus,
  TransitionId,
  TransitionTrigger,
  VerificationGate,
} from './types.ts'
import { CriterionVerifierRegistry, DefaultVerificationGate } from './verification.ts'

export type * from './types.ts'
export type * from './coding-lifecycle.ts'
export { assertPhaseTransition, canAdvancePhase, CodingLifecycle, CODING_PHASES, REPAIR_PHASE, resolveCodingLifecycle } from './coding-lifecycle.ts'
export { resolveChangeContract } from './change-contract.ts'
export { readKernelRecord, type KernelRecord } from './ledger.ts'
export { planDriftRun } from './plan-drift.ts'
export { KernelTaskGraph, readTaskGraph } from './task-graph.ts'
export { readKernelMetrics, type KernelMetrics } from './metrics.ts'
export { scanForRecovery, TERMINAL_TASK_STATUSES } from './recovery-scan.ts'
export { CAPABILITY_VOCABULARY, compilePolicy, POLICY_ACTIONS, POLICY_EFFECTS } from './policy.ts'
export {
  DELEGATION_POLICY_DEFAULTS,
  NO_DELEGATION_CEILING,
  delegatedWorkerBudget,
  delegationPolicyRefusal,
  delegationPolicySchema,
  resolveDelegationPolicy,
} from './delegation-policy.ts'
export type {
  DelegatedWorkerBudget,
  DelegationAdmission,
  DelegationHistory,
  DelegationPolicy,
  DelegationPolicyConfig,
} from './delegation-policy.ts'
export {
  TASK_OVERLAP_REUSE_THRESHOLD,
  TASK_OVERLAP_SHARED_THRESHOLD,
  objectiveOverlap,
  taskOverlapDecision,
} from './task-overlap.ts'
export type {
  ActiveChildTask,
  CompletedChildTask,
  TaskOverlapDecision,
  TaskOverlapInput,
} from './task-overlap.ts'

/** Plugin name used by loader diagnostics. */
export const name = 'agent-kernel'

/**
 * Plugin configuration. Every field is optional and `Config` supplies the
 * fail-closed defaults: a kernel mounted with no configuration runs in shadow
 * mode under an `ask` default policy with no ceilings, so it records every
 * decision and changes nothing.
 */
export interface Config {
  /** Whether composed decisions are acted on (`enforce`) or only recorded (`shadow`). */
  mode?: 'shadow' | 'enforce'
  /** Agent profile name recorded on every task contract created here. */
  agentProfile?: string
  /** Policy profile name recorded on every task contract created here. */
  policyProfile?: string
  /** Ceilings every task contract created here starts with. */
  budgets?: ResourceBudget
  /**
   * Criteria every task contract created here starts with. A task completed
   * through the turn-stopping hook must satisfy them; without any, the kernel
   * records no verification and claims no completion.
   */
  acceptance?: AcceptanceCriterion[]
  /**
   * Criteria a task of one class starts with. A class named here replaces the
   * shipped default for that class ({@link DEFAULT_ACCEPTANCE_BY_CLASS}: the
   * typecheck, lint, test and diff criteria for `coding`, a citation criterion
   * for `research`, none for `conversational` and `operations`); a class left
   * out falls back to {@link acceptance}, then to its shipped default.
   */
  acceptanceByClass?: Partial<Record<TaskClass, AcceptanceCriterion[]>>
  /** Class of work a task defaults to when neither the caller nor its role names one. */
  taskClass?: TaskClass
  /** The permission document every action is evaluated against. */
  policy?: PolicyDocument
  /** Whether a task with no acceptance criterion may be reported complete. */
  requireAcceptanceCriteria?: boolean
  /**
   * Whether a task of one class with no acceptance criterion may be reported
   * complete, overriding {@link requireAcceptanceCriteria} for that class.
   */
  requireAcceptanceCriteriaByClass?: Partial<Record<TaskClass, boolean>>
  /** Whether a task whose only passing evidence is human-reported may complete. */
  allowHumanOnlyCompletion?: boolean
  /**
   * Agent profiles this deployment defines, registered at load. A task created
   * under a profile name resolves that role: the task inherits its policy
   * profile and budget, and every action it proposes is checked against the
   * role's capability grant. `capabilities` is a mutable array here because the
   * configuration schema materializes one; the kernel copies it into the
   * immutable {@link AgentProfile} it registers.
   */
  profiles?: AgentProfileConfig[]
  /** Wall-clock ceiling for one criterion verifier; a verifier that overruns answers `fail`. */
  verifierTimeoutMs?: number
  /**
   * Times the gate may steer the agent back into work after a failed
   * verification before the task asks the user instead. A repair loop that
   * cannot converge is a decision for a human, not more turns.
   */
  maxRepairAttempts?: number
  /** Retry cap per action before the recovery engine reports no attempts remaining. */
  maxAttemptsPerAction?: number
  /** Whether a retry must be preceded by a checkpoint. */
  checkpointBeforeRetry?: boolean
  /**
   * Ceiling on plan revisions per task. A task that needs more amendments than
   * this is looping: the cap refuses the next revision loudly rather than
   * letting an agent rewrite its plan without bound.
   */
  maxPlanRevisions?: number
  /**
   * How a proposal whose own trust label is `untrusted` is decided. Under
   * `quarantine` the composed effect can never be `allow`: untrusted content
   * may inform a proposal but may not authorize one, so the action is at best
   * `ask` for a human. `allow` leaves the permission document as the only
   * authority, which is the pre-existing behavior.
   */
  untrustedContent?: 'allow' | 'quarantine'
  /**
   * How many actions in a row may match no step of the task's recorded plan
   * before the kernel records a `plan-drift` failure. A drift episode is
   * recorded once and stays unresolved until a new plan revision or a passing
   * verification answers it, so the count is a tolerance, not a rate. Zero
   * escalates on the first action that leaves the plan.
   */
  planDriftTolerance?: number
  /**
   * The §10.5 coding lifecycle a task of class `coding` runs: which phases, the
   * step ceiling of each phase, and whether the REVIEW phase spawns an
   * independent reviewer. A task of any other class runs no pipeline.
   */
  codingLifecycle?: CodingLifecycleConfig
  /**
   * Alternating tool calls (an A-B-A-B run) at which the governor reads the run
   * as oscillating. A loop is recorded once per episode and answers with
   * `stop_loop`, which refuses the next step in `mode: 'enforce'`.
   */
  loopOscillationRun?: number
  /**
   * Consecutive near-duplicate call pairs at which the governor reads the run
   * as repeating itself with different words. A pair counts when both calls
   * name the same tool and their arguments are at least
   * {@link loopSemanticSimilarity} alike.
   */
  loopSemanticDuplicateRun?: number
  /** Argument similarity, in `(0, 1]`, at which two calls repeat one intent. */
  loopSemanticSimilarity?: number
  /**
   * Consecutive steps that moved nothing before the governor reads the run as a
   * no-progress loop. A step moves something when any axis of its
   * {@link StepDelta} is nonzero.
   */
  loopStagnantStepRun?: number
  /**
   * Consecutive steps that produced no tool call and no state change before the
   * governor reads the run as a narration-only loop.
   */
  loopNarrationStepRun?: number
  /** Recordings of one unresolved failure kind that make the run a failure loop. */
  loopFailureRun?: number
  /**
   * Share of the task's `maxTokens` ceiling at which the governor asks for
   * compaction instead of another step. A task with no ceiling never reaches it.
   */
  contextPressureRatio?: number
  /**
   * Milliseconds without progress and without activity after which the liveness
   * monitor records a `stalled` failure, classified by the layer that went
   * quiet. A run the deployment does not want monitored sets a window larger
   * than its longest model call.
   */
  livenessWindowMs?: number
  /**
   * Output-token limit the step after a truncated turn is requested under. The
   * retry is granted once per truncation; a retried turn that truncates again
   * steers the model to split the work instead of raising the limit again. The
   * value is a floor: a request that already declares a larger limit keeps it.
   */
  outputTruncatedRetryTokens?: number
  /**
   * Criterion results the completion gate retains, keyed by criterion id and
   * repository digest, so a repeated pass over an unchanged repository reuses
   * the decision instead of running the verifier again.
   */
  verificationCacheSize?: number
  /** Milliseconds a retained criterion result stays reusable. */
  verificationCacheTtlMs?: number
}

/** The shape every configured acceptance criterion takes, in `Config` and per class. */
const CRITERIA_SCHEMA = z.object({
  id: z.string(),
  description: z.string(),
  verifier: z.union(['test', 'build', 'diff', 'assertion', 'human', 'research', 'typecheck', 'lint', 'security', 'browser', 'review'] as const),
  required: z.boolean(),
})

/**
 * Criteria a coding task starts from when the deployment configures none: the
 * three workspace checks a coding change is answerable by, claimed by criterion
 * id, plus a scope check that binds once the deployment declares a `diff`
 * target for it. A criterion no registered verifier claims leaves the task
 * incomplete until the deployment maps it to a command.
 */
const DEFAULT_CODING_CRITERIA: readonly AcceptanceCriterion[] = [
  { id: 'typecheck', description: 'the changed code typechecks', verifier: 'typecheck', required: true },
  { id: 'lint', description: 'the changed code passes lint', verifier: 'lint', required: true },
  { id: 'test', description: 'the tests covering the change pass', verifier: 'test', required: true },
  { id: 'diff', description: 'the change stays inside the files the task declared', verifier: 'diff', required: true },
]

/** Criterion a research task starts from when the deployment configures none. */
const DEFAULT_RESEARCH_CRITERIA: readonly AcceptanceCriterion[] = [
  {
    id: 'citations',
    description: 'every claim in the final answer cites evidence the task recorded',
    verifier: 'research',
    required: true,
  },
]

/**
 * The criteria each task class starts from when the deployment configures
 * neither the class nor a global list. These are the defaults of
 * {@link Config.acceptanceByClass}: a deployment overrides them per class, and
 * its global {@link Config.acceptance} list overrides them for every class.
 */
const DEFAULT_ACCEPTANCE_BY_CLASS: Readonly<Record<TaskClass, readonly AcceptanceCriterion[]>> = {
  conversational: [],
  coding: DEFAULT_CODING_CRITERIA,
  research: DEFAULT_RESEARCH_CRITERIA,
  operations: [],
}

/** Runtime configuration schema for the agent-kernel plugin. */
export const Config: z<Config> = z.object({
  mode: z.union(['shadow', 'enforce'] as const).default('shadow'),
  agentProfile: z.string().default('default'),
  policyProfile: z.string().default('default'),
  budgets: z.object({
    maxSteps: z.number(),
    maxToolCalls: z.number(),
    maxTokens: z.number(),
    maxWallMs: z.number(),
    maxCostUsd: z.number(),
    maxSubagentDepth: z.number(),
    maxConcurrentActions: z.number(),
  }),
  policy: z.object({
    defaults: z.object({ effect: z.union(POLICY_EFFECTS) }),
    rules: z.array(z.object({
      action: z.union(POLICY_ACTIONS),
      resource: z.string(),
      effect: z.union(POLICY_EFFECTS),
    })),
  }),
  acceptance: z.array(CRITERIA_SCHEMA),
  taskClass: z.union(TASK_CLASSES),
  /**
   * A class left out keeps the deployment's global {@link acceptance} list, then
   * the shipped default for the class; a class present with an empty array
   * declares that tasks of the class start from no criterion.
   */
  acceptanceByClass: z.dict(z.array(CRITERIA_SCHEMA)),
  requireAcceptanceCriteria: z.boolean().default(false),
  requireAcceptanceCriteriaByClass: z.object({
    conversational: z.boolean(),
    coding: z.boolean(),
    research: z.boolean(),
    operations: z.boolean(),
  }),
  allowHumanOnlyCompletion: z.boolean().default(false),
  profiles: z.array(z.object({
    id: z.string(),
    role: z.string(),
    capabilities: z.array(z.union(CAPABILITY_VOCABULARY)),
    policyProfile: z.string(),
    budget: z.object({
      maxSteps: z.number(),
      maxToolCalls: z.number(),
      maxTokens: z.number(),
      maxWallMs: z.number(),
      maxCostUsd: z.number(),
      maxSubagentDepth: z.number(),
      maxConcurrentActions: z.number(),
    }),
  })),
  verifierTimeoutMs: z.number().default(60_000),
  maxRepairAttempts: z.number().default(3),
  maxAttemptsPerAction: z.number().default(2),
  checkpointBeforeRetry: z.boolean().default(true),
  maxPlanRevisions: z.number().default(32),
  untrustedContent: z.union(['allow', 'quarantine'] as const).default('quarantine'),
  planDriftTolerance: z.number().default(3),
  codingLifecycle: z.object({
    phases: z.array(z.union(CODING_PHASES)).default([...CODING_PHASES]),
    budgets: z.object({
      understand: z.number(),
      map: z.number(),
      plan: z.number(),
      contract: z.number(),
      implement: z.number(),
      'local-verify': z.number(),
      review: z.number(),
      regression: z.number(),
      complete: z.number(),
    }),
    review: z.object({
      enabled: z.boolean().default(false),
      ref: z.string().default(''),
    }),
  }),
  loopOscillationRun: z.number().default(4),
  loopSemanticDuplicateRun: z.number().default(3),
  loopSemanticSimilarity: z.number().default(0.8),
  loopStagnantStepRun: z.number().default(3),
  loopNarrationStepRun: z.number().default(3),
  loopFailureRun: z.number().default(3),
  contextPressureRatio: z.number().default(0.8),
  livenessWindowMs: z.number().default(180_000),
  outputTruncatedRetryTokens: z.number().default(16_000),
  verificationCacheSize: z.number().default(256),
  verificationCacheTtlMs: z.number().default(600_000),
})

/** The permission document a deployment that configures none evaluates under: ask before anything. */
export const DEFAULT_POLICY_DOCUMENT: PolicyDocument = { defaults: { effect: 'ask' }, rules: [] }

/**
 * The steering message the gate sends when verification failed: the model is
 * told what is still wrong and is expected to repair it before the next turn
 * end, without being told the harness will ask again.
 * @param reasons - the gate's refusal reasons.
 * @returns the message text.
 */
function REPAIR_PROMPT(reasons: readonly string[]): string {
  return [
    'Verification of this task failed. Repair the cause and run the checks again.',
    '',
    ...reasons.map(reason => `- ${reason}`),
  ].join('\n')
}

/**
 * The facts a recorded transition carries beside the edge it took: the
 * preconditions the caller evaluated for the move, and the action whose outcome
 * caused it.
 */
interface TransitionReason {
  /** Preconditions the caller evaluated, recorded after the kernel's own edge and revision checks. */
  readonly preconditions?: readonly Predicate[]
  /**
   * Action whose outcome caused the transition. The transition cites the policy
   * decision the log recorded for that action, when it has one.
   */
  readonly actionId?: ActionId
}

/**
 * Digest one JSON value, so two results compare by what they said.
 * @param value - the value to digest.
 * @returns the hex digest.
 */
function digestOf(value: unknown): string {
  const serialized = JSON.stringify(value) as string | undefined
  return createHash('sha256').update(serialized ?? 'undefined').digest('hex')
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** @persistenceAttribution */
    'agent-kernel': { kind: 'agent-kernel' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentKernel: AgentKernelService
  }
}

/** Configuration values resolved once, at plugin load. */
interface ResolvedConfig {
  /** Whether composed decisions are acted on. */
  readonly mode: 'shadow' | 'enforce'
  /** Agent profile recorded on created task contracts. */
  readonly agentProfile: string
  /** Policy profile recorded on created task contracts. */
  readonly policyProfile: string
  /** Ceilings recorded on created task contracts. */
  readonly budgets: ResourceBudget
  /**
   * Criteria a task of one class starts with: the class's configured entry, the
   * deployment's global list, or the shipped default for the class.
   */
  readonly acceptanceByClass: Partial<Record<TaskClass, AcceptanceCriterion[]>>
  /** Class of work a task defaults to. */
  readonly taskClass: TaskClass
  /** Whether a task of one class with no criterion may complete, by class. */
  readonly requireAcceptanceCriteria: Partial<Record<TaskClass, boolean>>
  /** Repair attempts the gate may request before the task asks the user. */
  readonly maxRepairAttempts: number
  /** Retry cap per action. */
  readonly maxAttemptsPerAction: number
  /** Plan revisions allowed per task. */
  readonly maxPlanRevisions: number
  /** Consecutive actions matching no plan step that the kernel tolerates. */
  readonly planDriftTolerance: number
  /** Output-token limit a truncated turn's retry is requested under. */
  readonly outputTruncatedRetryTokens: number
  /** How a proposal from content the declaring package marked untrusted is decided. */
  readonly untrustedContent: 'allow' | 'quarantine'
}

/**
 * One live agent's attachment to its kernel task. `dispose()` releases the
 * kernel's reference; the task itself stays in the session log.
 */
class KernelTaskAttachment implements KernelAttachment {
  /** Task the agent is attached to. */
  readonly taskId: TaskId
  /** Run the agent is attached to. */
  readonly runId: RunId
  private readonly read: () => KernelView
  private readonly release: () => void

  /**
   * @param view - the view the attachment was created from.
   * @param read - reads the current view, or throws when the task disappeared.
   * @param release - removes the kernel's reference to this attachment.
   */
  constructor(view: KernelView, read: () => KernelView, release: () => void) {
    this.taskId = view.task.taskId
    this.runId = view.task.runId
    this.read = read
    this.release = release
  }

  /**
   * Read the attachment's current state.
   * @returns the current kernel view.
   */
  snapshot(): KernelView {
    return this.read()
  }

  /**
   * Detach the agent from its task.
   * @returns a promise that settles when the attachment is released.
   */
  dispose(): Promise<void> {
    this.release()
    return Promise.resolve()
  }
}

/**
 * The kernel service (`ctx.agentKernel`). It attaches to the loop and tool
 * waterfalls in its constructor. Plugin unload removes those registrations
 * and awaits release of every open attachment.
 */
export class AgentKernelService extends Service implements AgentKernel {
  /** The permission-rule evaluator compiled from `Config.policy`. */
  readonly policy: PolicyEngine
  /** The registry of tool capability declarations. */
  readonly capabilities: CapabilityRegistry
  /** The agent roles this deployment defines; a task resolves its profile through this registry. */
  readonly profiles: AgentProfileRegistry
  /** The completion gate. */
  readonly verification: VerificationGate
  /** The local criterion verifiers the gate collects results from. */
  readonly verifiers: CriterionVerifierRegistry
  /** The failure classifier and recovery chooser. */
  readonly recovery: DefaultRecoveryEngine
  /** Read-only persisted-session classifications from the one startup scan. */
  readonly startupRecovery: Promise<readonly RecoveryScanEntry[]>
  /** Read model and budget observer over session logs. */
  readonly state: KernelLedger
  /** Budget observer and reservation ledger over the current session logs. */
  readonly budgets: BudgetGovernor
  /** Task-graph read model over the same session logs. */
  readonly taskGraph: KernelTaskGraph
  /** The §10.5 coding lifecycle: the phases a coding task runs, and its reviewer. */
  readonly lifecycle: CodingLifecycle
  private readonly config: ResolvedConfig
  /** Capabilities the deployment's document admits at all, handed to a root parent's children. */
  private readonly admitted: readonly Capability[]
  /** Digest of the permission document, recorded on every delegation receipt. */
  private readonly permissionDigest: string
  private policyProfileProvider: PolicyProfileProvider | undefined
  private readonly profilePolicyEngines = new WeakMap<PolicyDocument, PermissionPolicyEngine>()
  /**
   * Per-session governor state: the recent call history the loop detectors and
   * the repetition refusal read, the counters the previous step was measured
   * at, and the liveness stamps. The state is process state on purpose: its
   * durable halves are the failures and `governor/decided` records it causes, so
   * a resumed process starts a fresh window instead of refusing a step for a
   * history it no longer counts.
   */
  private readonly governors = new Map<SessionId, SessionGovernor>()
  /** Validated governor thresholds, resolved once so a bad value fails load. */
  private readonly thresholds: GovernorThresholds

  /**
   * The budget hold each delegated child session is running under, by the
   * child's session id, so its settlement can find the hold when the child is
   * disposed. A hold is released rather than settled when the child never
   * started a task, because nothing was spent.
   */
  private readonly childGrants = new Map<SessionId, BudgetReservationId>()

  /**
   * Each task whose one final tool-free step at its step ceiling was already
   * granted. Process state on purpose: its durable halves are the `step-ceiling`
   * failure, the checkpoint, and the `paused` transition it causes, so a
   * resumed process grants the task one more final step instead of refusing it
   * over a ceiling the log already records.
   */
  private readonly finalSteps = new Set<TaskId>()

  /**
   * The truncation failure each session's one retry was granted for, so a
   * truncation that repeats after the retry steers the model to split its work
   * instead of raising the output limit again. Its durable half is the raised
   * limit recorded in the `request/header` the loop logs.
   */
  private readonly truncationRetries = new Map<SessionId, FailureId>()

  private readonly attachments = new Set<KernelTaskAttachment>()

  /**
   * @param ctx - plugin context; every listener and attachment is scoped to it.
   * @param config - validated plugin configuration; the permission document is compiled here, so an invalid one fails load.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentKernel')
    this.config = {
      mode: config.mode ?? 'shadow',
      agentProfile: config.agentProfile ?? 'default',
      policyProfile: config.policyProfile ?? 'default',
      budgets: config.budgets ?? {},
      acceptanceByClass: resolveAcceptanceByClass(config),
      taskClass: config.taskClass ?? 'conversational',
      requireAcceptanceCriteria: requireCriteriaByClass(config),
      maxRepairAttempts: config.maxRepairAttempts ?? 3,
      maxAttemptsPerAction: config.maxAttemptsPerAction ?? 2,
      maxPlanRevisions: config.maxPlanRevisions ?? 32,
      planDriftTolerance: resolvePlanDriftTolerance(config.planDriftTolerance),
      outputTruncatedRetryTokens: config.outputTruncatedRetryTokens ?? 16_000,
      untrustedContent: config.untrustedContent ?? 'quarantine',
    }
    const document = config.policy ?? DEFAULT_POLICY_DOCUMENT
    this.policy = new PermissionPolicyEngine(document)
    this.admitted = admittedCapabilities(compilePolicy(document))
    this.permissionDigest = policyDigest(document, this.config.policyProfile)
    this.capabilities = new ToolCapabilityRegistry()
    this.profiles = this.buildProfileRegistry(config.profiles ?? [])
    this.verification = new DefaultVerificationGate({
      requireAcceptanceCriteria: this.config.requireAcceptanceCriteria,
      allowHumanOnlyCompletion: config.allowHumanOnlyCompletion ?? false,
    })
    this.verifiers = new CriterionVerifierRegistry(config.verifierTimeoutMs ?? 60_000, {
      maxEntries: config.verificationCacheSize ?? 256,
      ttlMs: config.verificationCacheTtlMs ?? 600_000,
    })
    this.recovery = new DefaultRecoveryEngine({ checkpointBeforeRetry: config.checkpointBeforeRetry ?? true })
    const startupRecovery = Promise.withResolvers<readonly RecoveryScanEntry[]>()
    this.startupRecovery = startupRecovery.promise
    void this.startupRecovery.catch((error: unknown) => {
      ctx.logger.warn(`agent-kernel: startup recovery scan failed: ${String(error)}`)
    })
    ctx.inject(['sessionPersistence'], async (inner) => {
      try {
        const entries = await scanForRecovery(inner.sessionPersistence)
        for (const entry of entries) {
          if (entry.classification === 'resumable') continue
          inner.logger.warn(`agent-kernel: startup recovery ${entry.sessionId} is ${entry.classification}: ${entry.reason}`)
        }
        startupRecovery.resolve(entries)
      } catch (error) {
        startupRecovery.reject(error)
      }
    })
    // The background budget owner is read per observation rather than captured
    // here, so a deployment that mounts it after the kernel still has its spend
    // reported, and one that mounts none reports no background spend at all.
    this.state = new KernelLedger(() => ctx.get('evolutionBudget')?.backgroundSpend())
    this.budgets = this.state
    this.taskGraph = new KernelTaskGraph()
    this.thresholds = resolveGovernorThresholds(config)
    this.lifecycle = new CodingLifecycle({
      view: session => this.state.view(session),
      appendPhase: (session, record) => { this.recordLifecycle(session, record) },
      appendReview: (session, record) => { this.recordLifecycle(session, record) },
    }, resolveCodingLifecycle(config.codingLifecycle))

    // `agent/inbox/claimed` fires before prompt assembly, so the first request's
    // context compiler can read the task and required criteria from the log.
    ctx.on('agent/inbox/claimed', ({ agent, message }) =>{  this.openClaimedTask(agent, message) })
    ctx.on('agent/created', (payload) => {
      this.delegate(payload.agent)
      if (payload.source === 'resume') this.recordCheckpointResume(payload.agent)
    })
    ctx.on('agent/disposed', ({ agent }) =>{  this.settleChild(agent) })
    ctx.on('agent/pre-step', (payload, next) => {
      const decision = this.openOrAdvance(payload.agent, payload.messages, payload.turn, payload.step)
      return decision === undefined ? next() : Promise.resolve(decision)
    })
    ctx.on('agent/turn-stopping', payload => this.closeTurn(payload.agent, payload.turn, payload.signal))
    // The governor's liveness monitor reads model frames: a frame is the one
    // signal that the provider is still delivering, so frames that stop say the
    // stream stalled while a request is in flight.
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (frame.type === 'chunk') this.governorOf(agent.session).noteFrame()
    })
    // The monitor runs on its own clock because nothing else fires while a
    // request is hung; `unref` keeps a passive monitor from holding the process
    // open. The interval is scoped to this context, so unload stops it.
    ctx.effect(() => {
      const handle = setInterval(() => { this.checkLiveness() }, livenessCheckMs(this.thresholds.livenessWindowMs))
      handle.unref()
      return () => { clearInterval(handle) }
    }, 'agent-kernel.liveness')
    // §17.1: compaction may rewrite or drop the log tail a resume would
    // otherwise replay from, so the kernel checkpoints before it runs.
    ctx.on('session/event', (session, event) => {
      if (event.type === 'compaction/start') {
        // `session.append` refuses to reenter while `compaction/start`'s own
        // append is still publishing, so the checkpoint runs on the next
        // microtask instead of inline in this listener.
        queueMicrotask(() => {
          const agent = ctx.get('agents')?.get(session.id)
          if (agent !== undefined) this.checkpoint(agent, 'before-compaction')
        })
        return
      }
      // S7: the approval path is the producer of `awaiting-approval`. A question
      // put to the human parks the task; the recorded answer resumes it. The
      // observer runs inside the append that published the approval event, and
      // `session.append` refuses to reenter while one is publishing, so the
      // transition runs on the next microtask.
      if (event.type === 'approval/asked') {
        queueMicrotask(() => { this.enterAwaitingApproval(session, event.data) })
        return
      }
      if (event.type === 'approval/decided') {
        const approvalId = event.data.id
        queueMicrotask(() => { this.leaveAwaitingApproval(session, approvalId) })
      }
    })
    // S4: the retry a truncated turn is answered with. The request header the
    // loop logs records the raised limit, so a replay reconstructs what the
    // model was actually asked for.
    ctx.on('agent/request', async (payload, next) => {
      const config = await next()
      const session = payload.agent.session
      const pending = this.truncationAwaitingRetry(session)
      if (pending === undefined) return config
      this.truncationRetries.set(session.id, pending)
      return {
        ...config,
        maxTokens: Math.max(config.maxTokens ?? 0, this.config.outputTruncatedRetryTokens),
      }
    })
    ctx.on('tools/pre-execute', (exec, next) => this.authorize(exec, next))
    ctx.on('tools/post-execute', (exec, result, next) => {
      this.commit(exec, result.isError, result)
      return next()
    })
    // S4: the argument violation is reported by the registry before any
    // approval, so the kernel classifies it from the outcome that reached the
    // model rather than from the tool body.
    ctx.on('tools/result', (exec, result) => { this.classifyToolArguments(exec, result) })
    ctx.effect(() => async () => {
      await Promise.all([...this.attachments].map(attachment => attachment.dispose()))
    }, 'agent-kernel.attachments')
  }

  /**
   * Register the provider for session-selected policy layers.
   * @param provider - resolves the profile and optional restriction for each session.
   * @returns a disposer that removes this provider while it remains registered.
   * @throws when another policy profile provider is already registered.
   */
  registerPolicyProfileProvider(provider: PolicyProfileProvider): () => void {
    if (this.policyProfileProvider !== undefined) {
      throw new Error('agent-kernel: a policy profile provider is already registered')
    }
    this.policyProfileProvider = provider
    return () => {
      if (this.policyProfileProvider === provider) this.policyProfileProvider = undefined
    }
  }

  /** Resolve the session's selected policy profile or its task fallback. */
  private policyProfileOf(session: Session, fallback: string): PolicyProfileSelection {
    return this.policyProfileProvider?.resolve(session) ?? { profile: fallback }
  }

  /** Cache a compiled engine by the stable policy document object. */
  private profilePolicyEngine(document: PolicyDocument): PermissionPolicyEngine {
    const cached = this.profilePolicyEngines.get(document)
    if (cached !== undefined) return cached
    const engine = new PermissionPolicyEngine(document)
    this.profilePolicyEngines.set(document, engine)
    return engine
  }

  /** Intersect one session profile's decision with the deployment decision. */
  private intersectPolicyDecisions(
    base: PolicyDecision,
    profileDecision: PolicyDecision,
    profile: string,
  ): PolicyDecision {
    const effect = base.effect === 'deny' || profileDecision.effect === 'deny'
      ? 'deny'
      : base.effect === 'ask' || profileDecision.effect === 'ask' ? 'ask' : 'allow'
    const matchedRuleIndex = base.effect === effect
      ? base.matchedRuleIndex ?? (profileDecision.effect === effect ? profileDecision.matchedRuleIndex : null)
      : profileDecision.matchedRuleIndex
    return {
      ...base,
      effect,
      matchedRuleIndex,
      reasons: [
        ...base.reasons,
        ...profileDecision.reasons.map(reason => `policy profile "${profile}": ${reason}`),
      ],
    }
  }

  /**
   * Persist one caller-supplied task contract before its first request.
   * @param agent - the live agent whose session owns the task.
   * @param input - the objective, constraints, acceptance, profiles, workspace and budget.
   * @returns the newly recorded contract at its initial `intake` revision.
   * @throws When the session already has a task contract.
   */
  intake(agent: Agent, input: TaskInput): TaskContract {
    return this.createTask(agent.session, input, 'user', { source: 'user', locator: agent.id })
  }

  /**
   * Attach one live agent to its task contract.
   * @param agent - the live agent to attach.
   * @returns the attachment handle.
   * @throws When the agent's session holds no `task/created` event yet; the kernel creates one at the first admitted step.
   */
  attach(agent: Agent): KernelAttachment {
    const session = agent.session
    const attachment = new KernelTaskAttachment(
      this.readView(session, agent),
      () => this.readView(session, agent),
      () => { this.attachments.delete(attachment) },
    )
    this.attachments.add(attachment)
    return attachment
  }

  /**
   * Build the profile registry from configuration. A repeated profile id
   * replaces the earlier one, so a later configuration layer refines a role
   * rather than adding a second role under the same name.
   * @param configured - the profiles this deployment declared in `Config`.
   * @returns the registry tasks resolve their roles through.
   */
  private buildProfileRegistry(configured: readonly AgentProfileConfig[]): AgentProfileRegistry {
    const registry = new KernelProfileRegistry()
    for (const profile of configured) registry.register(profile)
    return registry
  }

  /**
   * Read one agent's task state.
   * @param agent - the live agent whose session is read.
   * @returns the current view, or undefined before task intake.
   */
  snapshot(agent: Agent): Promise<KernelView | undefined> {
    return Promise.resolve(this.state.view(agent.session))
  }

  /**
   * Read the current task view through the live agents registry.
   * The registry remains the sole owner of agent identity and disposal; this
   * method resolves it on every call and retains no agent reference.
   * @param sessionId - the identity of the session to read.
   * @returns the current view, or undefined when no live agent or task exists.
   */
  viewOf(sessionId: SessionId): KernelView | undefined {
    const agent = this.ctx.get('agents')?.get(sessionId)
    return agent === undefined ? undefined : this.state.view(agent.session)
  }

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
  recordPlan(agent: Agent, steps: readonly string[], failureId?: FailureId, options: PlanOptions = {}): PlanRevision {
    const session = agent.session
    const entry = this.state.entryOf(session)
    const task = entry.task
    if (task === undefined) throw new Error('agent-kernel: cannot record a plan without a task')
    const approvedByUser = options.approvedBy === 'user'
    if (entry.plan !== undefined && failureId === undefined && !approvedByUser) {
      throw new Error('agent-kernel: a plan amendment requires a failure reference')
    }
    if (failureId !== undefined && !entry.failures.has(failureId)) {
      throw new Error(`agent-kernel: plan failure reference "${failureId}" is not unresolved`)
    }
    // Read the plan's ordinal before the append: the fold mutates this entry.
    const firstPlan = entry.plan === undefined
    const revision = (entry.plan?.revision ?? 0) + 1
    const withinCap = revision <= this.config.maxPlanRevisions
    if (!withinCap) {
      throw new Error(`agent-kernel: task ${task.taskId} reached its ${String(this.config.maxPlanRevisions)}-revision plan cap; the objective or the acceptance criteria need a human decision`)
    }
    const actor: ActorKind = approvedByUser ? 'user' : 'model'
    const plan: PlanRevision = {
      revision,
      steps: [...steps],
      ...failureId === undefined ? {} : { failureId },
      createdAt: Date.now(),
    }
    session.append('task/plan', {
      ...plan,
      metadata: kernelEventMetadata(task.runId, task.taskId, actor, {
        source: actor === 'user' ? 'user' : 'model', locator: String(task.taskId),
      }, plan.createdAt),
    })
    // The first plan is the other producer of `planning`: the task has stated
    // how it intends to work, and the next admitted step leaves the status.
    const current = this.state.ledgerTask(session)
    // §10.5: a recorded plan revision is the PLAN phase's producer.
    this.lifecycle.advance(session, 'plan', `plan revision ${String(revision)}`)
    if (firstPlan && canTransition(current.status, 'planning')) {
      this.transition(session, current, 'planning', { kind: 'plan-recorded' }, actor, [], {
        preconditions: [{
          kind: 'plan-revision-cap',
          satisfied: withinCap,
          detail: `revision ${String(revision)} of ${String(this.config.maxPlanRevisions)}`,
        }],
        ...options.callId === undefined ? {} : { actionId: actionIdOf(options.callId) },
      })
    }
    return plan
  }

  /**
   * Record one observation a claim may cite.
   * @param agent - the live agent whose task observed it.
   * @param input - what was observed, where it lives, and how far it may be trusted.
   * @returns the durable evidence record.
   * @throws When the session has no task or the reference is empty.
   */
  recordEvidence(agent: Agent, input: EvidenceInput): Evidence {
    const session = agent.session
    const entry = this.state.entryOf(session)
    const task = entry.task
    if (task === undefined) throw new Error('agent-kernel: cannot record evidence without a task')
    if (input.contentRef.trim() === '') {
      throw new Error('agent-kernel: evidence must name where its content lives')
    }
    const evidence: Evidence = {
      evidenceId: brandString<EvidenceId>(randomUUID()),
      kind: input.kind,
      contentRef: input.contentRef,
      ...input.digest === undefined ? {} : { digest: input.digest },
      sourceRef: input.sourceRef,
      trust: input.trust,
      observedAt: Date.now(),
    }
    session.append('evidence/recorded', {
      ...evidence,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'model', input.sourceRef, evidence.observedAt),
    })
    return evidence
  }

  /**
   * Assert one claim against evidence this session recorded.
   * @param agent - the live agent whose task asserts it.
   * @param input - the statement, the evidence it cites, its confidence, and its status.
   * @returns the durable claim.
   * @throws When the session has no task, the statement is empty, the confidence
   *   is outside `[0, 1]`, a cited observation was never recorded, or a
   *   `supported` claim cites no observation.
   */
  recordClaim(agent: Agent, input: TaskClaimInput): TaskClaim {
    const session = agent.session
    const entry = this.state.entryOf(session)
    const task = entry.task
    if (task === undefined) throw new Error('agent-kernel: cannot record a claim without a task')
    if (input.statement.trim() === '') throw new Error('agent-kernel: a claim needs a statement')
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error(`agent-kernel: claim confidence ${String(input.confidence)} is outside [0, 1]`)
    }
    const evidence = input.evidence ?? []
    for (const evidenceId of evidence) {
      if (!entry.evidence.has(evidenceId)) {
        throw new Error(`agent-kernel: claim cites evidence "${evidenceId}" this session never recorded`)
      }
    }
    const status = input.status ?? 'proposed'
    if (status === 'supported' && evidence.length === 0) {
      throw new Error('agent-kernel: a supported claim must cite at least one observation')
    }
    const claim: TaskClaim = {
      claimId: brandString<TaskClaimId>(randomUUID()),
      statement: input.statement,
      evidence: [...evidence],
      confidence: input.confidence,
      status,
    }
    session.append('claim/updated', {
      ...claim,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'model', {
        source: 'model', locator: String(task.taskId),
      }),
    })
    return claim
  }

  /**
   * Record one question a task is testing.
   * @param agent - the live agent whose task is testing it.
   * @param input - the question, the claims behind it, and the verifications run against it.
   * @returns the durable hypothesis.
   * @throws When the session has no task, the question is empty, a cited claim
   *   was never asserted, or a test does not verify this task.
   */
  recordHypothesis(agent: Agent, input: TaskHypothesisInput): TaskHypothesis {
    const session = agent.session
    const entry = this.state.entryOf(session)
    const task = entry.task
    if (task === undefined) throw new Error('agent-kernel: cannot record a hypothesis without a task')
    if (input.question.trim() === '') throw new Error('agent-kernel: a hypothesis needs a question')
    const claims = input.claims ?? []
    for (const claimId of claims) {
      if (!entry.claims.has(claimId)) {
        throw new Error(`agent-kernel: hypothesis cites claim "${claimId}" this session never asserted`)
      }
    }
    const tests = input.tests ?? []
    for (const test of tests) {
      if (test.taskId !== task.taskId) {
        throw new Error(`agent-kernel: hypothesis test names task "${test.taskId}", not "${task.taskId}"`)
      }
    }
    const hypothesis: TaskHypothesis = {
      hypothesisId: brandString<TaskHypothesisId>(randomUUID()),
      question: input.question,
      claims: [...claims],
      tests: [...tests],
      status: input.status ?? 'open',
    }
    session.append('hypothesis/updated', {
      ...hypothesis,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'model', {
        source: 'model', locator: String(task.taskId),
      }),
    })
    return hypothesis
  }

  /**
   * Verify one task revision with the registered criterion verifiers, record the
   * request and its result, and return the completion decision.
   * @param agent - the live agent whose task is verified.
   * @param changedScopes - scopes the task changed, for `diff` verifiers.
   * @returns the completion decision, or undefined when the agent has no task.
   */
  verify(agent: Agent, changedScopes: readonly string[] = []): Promise<CompletionDecision | undefined> {
    const view = this.state.view(agent.session)
    if (view === undefined) return Promise.resolve(undefined)
    return this.verifyTask(agent.session, view.task, changedScopes)
  }

  /**
   * Record one checkpoint of an agent's current kernel state.
   * @param agent - the live agent whose task is checkpointed.
   * @param reason - why the checkpoint is recorded.
   * @returns the checkpoint, or undefined when the agent has no task.
   */
  checkpoint(agent: Agent, reason: CheckpointReason): Checkpoint | undefined {
    const session = agent.session
    const view = this.state.view(session)
    if (view === undefined) return undefined
    const checkpoint: Checkpoint = {
      checkpointId: brandString<CheckpointId>(randomUUID()),
      taskId: view.task.taskId,
      runId: view.task.runId,
      agentSessionId: session.id,
      sessionSeq: session.seq,
      status: view.task.status,
      revision: view.task.revision,
      budgets: view.budgets,
      openActionIds: view.openActionIds,
      unresolvedFailures: view.unresolvedFailures,
      reason,
      createdAt: Date.now(),
    }
    session.append('checkpoint/created', {
      ...checkpoint,
      metadata: kernelEventMetadata(checkpoint.runId, checkpoint.taskId, 'kernel', {
        source: 'kernel', locator: checkpoint.checkpointId,
      }, checkpoint.createdAt),
    })
    return checkpoint
  }

  /**
   * Read one session's current kernel view, or fail loud when there is none.
   * @param session - the session to read.
   * @param agent - the agent named in the failure, for a useful message.
   * @returns the current view.
   * @throws When the session holds no `task/created` event.
   */
  private readView(session: Session, agent: Agent): KernelView {
    const view = this.state.view(session)
    if (view === undefined) {
      throw new Error(`agent-kernel: agent "${agent.id}" has no task contract; one is created at its first admitted step`)
    }
    return view
  }

  /**
   * Create the task contract on a session's first admitted step, then move it to
   * `executing` for the step the loop is about to run, then compose the one
   * governor decision this boundary produces.
   * @param agent - the agent proposing the step.
   * @param messages - the messages this step claims.
   * @param turn - the turn that will own the step.
   * @param step - the step the loop proposed.
   * @returns the refusal the governor composed, or undefined to admit the step.
   */
  private openOrAdvance(agent: Agent, messages: readonly UserMessage[], turn: number, step: number): PreStepDecision | undefined {
    const session = agent.session
    const current = this.state.entryOf(session).task
    // A step admitted after the previous task ended is the next request in the
    // same conversation: it opens its own contract, exactly as the inbox claim
    // does, so a driver that dispatches only the pre-step still starts one.
    let task = current === undefined || isActive(current.status)
      ? current ?? this.intakeFromMessages(session, messages)
      : this.intakeFromMessages(session, messages, { parentTaskId: current.taskId })
    // S4's truncation detector: the turn before this one ended because the
    // model reached its output limit. The first truncation is answered with one
    // retry under a larger output limit, granted by the request listener from
    // the failure recorded here; a truncation that repeats after that retry is
    // answered by steering the model to split its work, because the larger
    // limit did not help. A turn that ended for another reason clears the
    // retry, so a later truncation is retried again.
    if (turn > 1) {
      if (!this.truncatedTurn(session, turn - 1)) this.truncationRetries.delete(session.id)
      else if (this.truncationRetries.has(session.id)) this.steerToSplitWork(agent, turn)
      else this.recordFailure(session, 'output-truncated', `the model reached its output limit in turn ${String(turn - 1)}`)
    }
    // S4's step-ceiling detector: the task is granted one final step without
    // tools so the model can answer from what it has, and the turn that step
    // belongs to checkpoints and pauses the task. The failure is recorded once
    // per task, when that final step is granted.
    const ceiling = task.budget.maxSteps
    const spent = this.state.entryOf(session).steps
    if (ceiling !== undefined && spent >= ceiling) {
      if (!this.finalSteps.has(task.taskId)) {
        this.finalSteps.add(task.taskId)
        this.recordFailure(session, 'step-ceiling', `the task reached its ${String(ceiling)}-step ceiling`)
        return undefined
      }
      this.pauseAtCeiling(agent, `turn ${turn} step ${step}`, ceiling, spent)
      // A paused task runs no further step: `enforce` refuses it, while shadow
      // mode records the pause and admits the step because it changes no
      // behavior.
      return this.config.mode === 'enforce' ? { kind: 'reject' } : undefined
    }
    if (canTransition(task.status, 'ready')) {
      task = this.transition(session, task, 'ready', { kind: 'task-intake' }, 'kernel')
    }
    if (canTransition(task.status, 'executing')) {
      task = this.transition(session, task, 'executing', { kind: 'step-admitted', detail: `turn ${turn} step ${step}` }, 'kernel')
    }
    // §10.5: an admitted step is the task reading the repository, which is the
    // MAP phase; it is a no-op once the pipeline has moved past it.
    this.lifecycle.advance(session, 'map', `turn ${turn} step ${step}`)
    return this.govern(agent, task, turn, step)
  }

  /**
   * Park a task that spent its step ceiling: index the state a resume would
   * restart from, then move the task to `paused`. The transition is recorded
   * once per task, so a driver that keeps proposing steps cannot pause twice.
   * @param agent - the agent whose task is parked.
   * @param detail - the turn and step the pause answers.
   * @param ceiling - the task's configured step ceiling.
   * @param spent - steps the session already started.
   */
  private pauseAtCeiling(agent: Agent, detail: string, ceiling: number, spent: number): void {
    const session = agent.session
    const current = this.state.ledgerTask(session)
    if (current.status === 'paused' || !canTransition(current.status, 'paused')) return
    // §17.1: index the state a resume would restart from before the pause takes
    // effect.
    this.checkpoint(agent, 'before-pause')
    this.transition(session, current, 'paused', { kind: 'budget-exhausted', detail }, 'kernel', [], {
      preconditions: [{
        kind: 'step-ceiling',
        satisfied: spent < ceiling,
        detail: `${String(spent)} of ${String(ceiling)} steps spent`,
      }],
    })
  }

  /**
   * Compose and record the governor's decision for one step, and refuse the
   * step when the decision ends the run.
   *
   * The decision is recorded before it is acted on, like every other kernel
   * decision, so a replay sees the same answer a live run made. Only the five
   * `stop_*` decisions change behavior, and only in `mode: 'enforce'`: a
   * refusal ends the turn as blocked, which parks the inbox until the next
   * wake instead of discarding it.
   * @param agent - the agent proposing the step.
   * @param task - the contract after this boundary's transitions.
   * @param turn - the turn that owns the step.
   * @param step - the step the loop proposed.
   * @returns the refusal to return to the loop, or undefined to admit the step.
   */
  private govern(agent: Agent, task: TaskContract, turn: number, step: number): PreStepDecision | undefined {
    const session = agent.session
    const entry = this.state.entryOf(session)
    const governor = this.governorOf(session)
    const snapshot = this.state.measure(task, session)
    const receipt = entry.delegation
    const depth = receipt?.depth ?? 0
    const maxDepth = receipt?.maxDepth ?? task.budget.maxSubagentDepth
    const evaluation = governor.evaluate({
      turn,
      step,
      counters: countersOf(entry),
      status: task.status,
      remaining: snapshot.remaining,
      failures: [...entry.failures.values()],
      recoveries: entry.recoveries,
      tokens: snapshot.tokens,
      ...task.budget.maxTokens === undefined ? {} : { maxTokens: task.budget.maxTokens },
      delegationAllowed: maxDepth === undefined || depth < maxDepth,
      at: Date.now(),
    }, this.thresholds)
    if (evaluation.loop !== undefined && ![...entry.failures.values()].some(failure => failure.kind === 'no-progress')) {
      // One failure per loop episode, like plan drift: the episode ends when a
      // step moves something, which is what resolves it.
      this.recordFailure(session, 'no-progress', evaluation.loop)
    }
    session.append('governor/decided', {
      ...evaluation.record,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'kernel', { source: 'kernel', locator: 'governor' }, evaluation.record.at),
    })
    if (this.config.mode !== 'enforce' || !isStopDecision(evaluation.record.decision)) {
      governor.openStep()
      return undefined
    }
    governor.closeStep()
    return { kind: 'reject' }
  }

  /**
   * The process-local governor state of one session, created on first use.
   * @param session - the session whose state is read.
   * @returns the session's governor state.
   */
  private governorOf(session: Session): SessionGovernor {
    const existing = this.governors.get(session.id)
    if (existing !== undefined) return existing
    const created = new SessionGovernor()
    this.governors.set(session.id, created)
    return created
  }

  /**
   * Report one stall per tracked session whose liveness window elapsed with no
   * progress and no activity, and drop the state of sessions that are gone.
   *
   * Only a running agent can stall, and only a task that expects progress on
   * its own can be stalled: a task waiting on a human answer, or parked by a
   * stop, is not asked to move.
   */
  private checkLiveness(): void {
    const at = Date.now()
    const agents = this.ctx.get('agents')
    for (const [sessionId, governor] of this.governors) {
      const agent = agents?.get(sessionId)
      if (agent === undefined) {
        this.governors.delete(sessionId)
        continue
      }
      if (agent.status !== 'running') continue
      const session = agent.session
      const entry = this.state.entryOf(session)
      const task = entry.task
      if (task === undefined || !EXPECTS_PROGRESS[task.status]) continue
      const kind = governor.stall({
        at,
        windowMs: this.thresholds.livenessWindowMs,
        openActions: entry.openActions.size,
        child: entry.delegation !== undefined,
      })
      if (kind === undefined) continue
      governor.markStall(kind)
      this.recordFailure(
        session,
        'stalled',
        `nothing moved for the ${String(this.thresholds.livenessWindowMs)}ms liveness window (${kind} timeout)`,
      )
    }
  }

  /**
   * Open the task as soon as the loop claims its first human message. The loop
   * emits this notification inside the turn and before prompt assembly.
   * @param agent - the agent whose inbox supplied the message.
   * @param message - the claimed message.
   */
  private openClaimedTask(agent: Agent, message: UserMessage): void {
    const session = agent.session
    const entry = this.state.entryOf(session)
    const task = entry.task
    if (task !== undefined && isActive(task.status)) {
      if (canTransition(task.status, 'ready')) {
        this.transition(session, task, 'ready', { kind: 'task-intake' }, 'kernel')
      }
      return
    }
    // A human message that arrives while the current task is terminal opens the
    // next task: one session holds one task at a time, but a conversation holds
    // as many as it has requests. The new contract names the one it follows.
    const human = message.source.kind === 'user'
    this.intakeFromMessages(session, [message], {
      ...task === undefined ? {} : { parentTaskId: task.taskId },
      ...human ? {} : { taskClass: 'conversational' as const },
    })
  }


  /**
   * Issue the delegation receipt one child agent acts under. The receipt is
   * written into the child's own log before its task contract, so a replay
   * reconstructs the child's authority without the parent's session; a
   * resolvable parent records the same receipt as what it handed down.
   * @param agent - the agent just published to the registry.
   */
  private delegate(agent: Agent): void {
    const session = agent.session
    const parentSessionId = session.header.parentSession
    if (parentSessionId === undefined) return
    // A resumed child already carries its receipt; issuing a second one would
    // replace the authority its recorded actions already ran under.
    if (this.state.entryOf(session).delegation !== undefined) return
    const parentSession = this.ctx.get('sessions')?.get(parentSessionId)
    const parent = parentSession === undefined ? undefined : this.state.view(parentSession)
    const delegationId = brandString<DelegationId>(randomUUID())
    const childRunId = brandString<RunId>(randomUUID())
    // The child's grant is reserved before the child spends: what the parent can
    // still promise now excludes what its other in-flight children hold and what
    // its settled children already spent, so two children created before either
    // finishes are never both promised the same allowance.
    const reservation = parent === undefined || parentSession === undefined
      ? undefined
      : this.budgets.reserve(parentSession, this.budgets.available(parentSession), childRunId)
    if (reservation !== undefined) this.childGrants.set(session.id, reservation.reservationId)
    const receipt = delegationReceipt({
      delegationId,
      childRunId,
      parentSessionId,
      ...parent === undefined ? {} : { parent },
      admitted: this.admitted,
      sandbox: this.sandboxOf(session),
      inheritedPolicyDigest: this.permissionDigest,
      resourceLimits: delegableBudget(parent, reservation, this.config.budgets),
      at: Date.now(),
    })
    const metadata = kernelEventMetadata(receipt.childRunId, receipt.parentTaskId, 'system', {
      source: 'subagent', locator: String(parentSessionId),
    }, receipt.at)
    session.append('delegation/received', { ...receipt, metadata })
    parentSession?.append('delegation/issued', { ...receipt, metadata })
  }

  /**
   * Settle the budget the child's grant held. The child's own log is the
   * measurement: a child that opened no task never spent anything and its hold
   * is released, while a child that ran reports the steps, tool calls, tokens,
   * and wall-clock it used, which are debited from the parent's available
   * allowance so a later child is not promised them again.
   * @param agent - the agent that is being disposed.
   */
  private settleChild(agent: Agent): void {
    const session = agent.session
    const reservationId = this.childGrants.get(session.id)
    if (reservationId === undefined) return
    this.childGrants.delete(session.id)
    const view = this.state.view(session)
    if (view === undefined) {
      this.budgets.release(reservationId)
      return
    }
    this.budgets.commit(reservationId, {
      maxSteps: view.budgets.steps,
      maxToolCalls: view.budgets.toolCalls,
      maxTokens: view.budgets.tokens,
      maxWallMs: view.budgets.wallMs,
    })
  }

  /**
   * Whether one completed turn ended because the model reached its output
   * limit. The loop records the end reason on `turn/end`, which is appended
   * after the kernel's turn-stopping listener ran, so truncation is detected on
   * the step that follows it.
   * @param session - the session whose log is read.
   * @param turn - the completed turn to inspect.
   * @returns true when that turn was truncated.
   */
  private truncatedTurn(session: Session, turn: number): boolean {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return session.snapshotEvents().some(event =>
      event.type === 'turn/end' && event.data.turn === turn && event.data.reason.kind === 'max-tokens',
    )
  }

  /**
   * The truncation failure this session still owes a retry, so the request that
   * follows it is issued under a larger output limit. A truncation the session
   * already retried is not owed another one, and the failure the retried turn
   * resolved by ending otherwise is gone from the unresolved set.
   * @param session - the session whose unresolved failures are read.
   * @returns the failure awaiting its retry, or undefined when none is.
   */
  private truncationAwaitingRetry(session: Session): FailureId | undefined {
    const retried = this.truncationRetries.get(session.id)
    for (const failure of this.state.entryOf(session).failures.values()) {
      if (failure.kind !== 'output-truncated' || failure.failureId === retried) continue
      return failure.failureId
    }
    return undefined
  }

  /**
   * Steer the model to split its work after a truncation that repeated despite
   * the retry under a larger output limit: another raise cannot answer a model
   * that produces more output than one response holds.
   * @param agent - the agent whose step is admitted.
   * @param turn - the turn whose previous turn was truncated.
   */
  private steerToSplitWork(agent: Agent, turn: number): void {
    agent.steer(createUserMessage({
      content: [{
        type: 'text',
        text: [
          `The previous turn reached the model's output limit again (turn ${String(turn - 1)}, already retried under a larger output limit).`,
          'Split the work: write one file, one section, or one tool call at a time instead of one large output.',
        ].join(' '),
      }],
      source: { kind: 'agent-kernel', form: 'notice', summary: 'output limit reached; split the work' },
    }))
  }

  /**
   * The workspace-change summary the recorder published for one turn, which
   * names both the scopes the turn changed and the git tree id of its end
   * state.
   * @param session - the session whose log is read.
   * @param turn - the turn to read; omitted reads the latest summary.
   * @returns the summary, or undefined when the turn published none.
   */
  private changesSummary(session: Session, turn?: number) {
    const changes = this.ctx.get('workspaceChanges')
    if (changes === undefined) return undefined
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const latest = session.snapshotEvents().findLast(event =>
      event.type === 'workspace/changes' && (turn === undefined || event.data.turn === turn),
    )
    return latest === undefined ? undefined : changes.summary(session.id, latest.seq)
  }

  /**
   * The scopes one turn changed, read from the summary the workspace-changes
   * recorder published for that turn. A deployment without that recorder
   * reports no changed scope, which the gate reads as "nothing to verify".
   * @param session - the session whose turn is being closed.
   * @param turn - the top-level turn that is stopping.
   * @returns the changed paths, in the recorder's display order.
   */
  private changedScopes(session: Session, turn: number): readonly string[] {
    return this.changesSummary(session, turn)?.files.map(file => file.path) ?? []
  }

  /**
   * The digest of the repository state a verification reads, so a criterion
   * result is retained against exactly the state the verifier saw. A turn's own
   * summary supplies the git tree id of its end state; a repository the recorder
   * could not snapshot is digested from the recorded change list together with
   * the session, because two sessions that recorded no summary never saw the
   * same repository.
   * @param session - the session whose repository state is digested.
   * @param turn - the turn to read; omitted reads the latest summary.
   * @returns the repository digest.
   */
  private repositoryDigest(session: Session, turn?: number): string {
    const summary = this.changesSummary(session, turn)
    // No recorded change summary means the kernel cannot name the repository
    // state a verifier read. The digest then names this pass alone, so no
    // earlier result can answer for a repository nothing observed.
    if (summary === undefined) return digestOf({ session: session.id, seq: session.seq })
    // A turn's git tree id is a content digest of the whole working directory;
    // without one, the recorded change list is the closest observed state.
    return summary.snapshot?.after ?? digestOf({
      session: session.id,
      turn: summary.turn,
      files: summary.files.map(file => [file.path, file.added, file.deleted]),
    })
  }

  /**
   * Park the session's task while a question is outstanding with the human.
   * The approval path is the producer of `awaiting-approval`: the task is not
   * running work while the answer is pending, and the recorded answer moves it
   * back.
   * @param session - the session whose task is parked.
   * @param approval - the recorded approval request.
   */
  private enterAwaitingApproval(session: Session, approval: { id: ApprovalRequestId; toolName: string }): void {
    const task = this.state.entryOf(session).task
    if (task === undefined || !isActive(task.status)) return
    if (!canTransition(task.status, 'awaiting-approval')) return
    this.transition(session, task, 'awaiting-approval', {
      kind: 'human-required',
      detail: `approval ${approval.id} for ${approval.toolName}`,
    }, 'user')
  }

  /**
   * Return the parked task to work once the human answered the question: the
   * step that asked continues with the decision on its log.
   * @param session - the session whose task resumes.
   * @param approvalId - the answered request's identity.
   */
  private leaveAwaitingApproval(session: Session, approvalId: ApprovalRequestId): void {
    const task = this.state.entryOf(session).task
    if (task === undefined || task.status !== 'awaiting-approval') return
    if (!canTransition(task.status, 'executing')) return
    this.transition(session, task, 'executing', {
      kind: 'approval-decided',
      detail: `approval ${approvalId} answered`,
    }, 'user')
  }

  /**
   * Follow plan mode, the producer of the `planning` status: entering it moves a
   * non-terminal task to `planning`, leaving it returns the task to `ready`. A
   * session with no task yet has nothing to move, and a status that cannot reach
   * `planning` keeps its current one. The plan-mode plugin calls this immediately
   * after it records the mode, so the status and the mode agree in the log.
   * @param session - the session whose mode changed.
   * @param active - whether plan mode is now in force.
   */
  recordPlanMode(session: Session, active: boolean): void {
    const task = this.state.entryOf(session).task
    if (task === undefined) return
    if (active) {
      if (!canTransition(task.status, 'planning')) return
      this.transition(session, task, 'planning', { kind: 'plan-mode-entered' }, 'user')
      return
    }
    if (task.status !== 'planning') return
    this.transition(session, task, 'ready', { kind: 'plan-mode-exited' }, 'user')
  }

  /** Record the checkpoint restored by `AgentRegistry.resume()`, if one exists. */
  private recordCheckpointResume(agent: Agent): void {
    const session = agent.session
    const view = this.state.view(session)
    if (view === undefined || view.checkpoint === undefined) return
    if (view.checkpoint.taskId !== view.task.taskId || view.checkpoint.runId !== view.task.runId) {
      throw new Error('agent-kernel: resumed checkpoint belongs to a different task')
    }
    const resumedAt = Date.now()
    session.append('checkpoint/resumed', {
      checkpointId: view.checkpoint.checkpointId,
      agentSessionId: session.id,
      sessionSeq: view.checkpoint.sessionSeq,
      resumedAt,
      metadata: kernelEventMetadata(view.task.runId, view.task.taskId, 'system', {
        source: 'kernel', locator: String(view.checkpoint.checkpointId),
      }, resumedAt),
    })
  }

  /**
   * Open a task contract from messages claimed by the loop.
   * @param session - the session the contract belongs to.
   * @param messages - the claimed messages the objective is read from.
   * @returns the contract after its `ready` transition.
   */
  private intakeFromMessages(
    session: Session,
    messages: readonly UserMessage[],
    override: Partial<TaskInput> = {},
  ): TaskContract {
    const hasHumanMessage = messages.some(message => message.source.kind === 'user')
    const actor: ActorKind = hasHumanMessage ? 'user' : 'kernel'
    const task = this.createTask(session, {
      objective: humanObjective(messages),
      agentProfile: this.config.agentProfile,
      budget: this.config.budgets,
      ...override,
    }, actor, { source: hasHumanMessage ? 'user' : 'kernel', locator: String(session.id) })
    return this.transition(session, task, 'ready', { kind: 'task-intake' }, 'kernel')
  }

  /**
   * Resolve the class of work a task is. The caller's own statement wins, then
   * the role the task runs under; with neither, a task that follows one which
   * mutated the filesystem is coding work, because the conversation is about the
   * repository now, and everything else is conversational.
   * @param session - the session the task belongs to.
   * @param agentProfile - the role the task runs under.
   * @param requested - the class the caller named, when it named one.
   * @returns the class the contract records.
   */
  private classOf(session: Session, agentProfile: string, requested?: TaskClass): TaskClass {
    if (requested !== undefined) return requested
    const role = this.profiles.resolve(agentProfile)?.taskClass
    if (role !== undefined) return role
    return this.mutatedWorkspace(session) ? 'coding' : this.config.taskClass
  }

  /**
   * Whether any tool this session proposed declares a mutating capability. The
   * declaration is read from the registry rather than the authorization, because
   * a shadow-mode decision grants nothing while still recording what was asked.
   */
  private mutatedWorkspace(session: Session): boolean {
    for (const proposal of this.state.entryOf(session).proposals.values()) {
      const declared = this.capabilities.resolve(proposal.toolName, {})
      if (declared?.some(request => request.capability === 'fs.write' || request.capability === 'fs.edit')) return true
    }
    return false
  }

  /** Persist one immutable task contract, narrowing workspace and budget to deployment grants. */
  private createTask(
    session: Session,
    input: TaskInput,
    actor: ActorKind,
    sourceRef: SourceRef,
  ): TaskContract {
    const current = this.state.entryOf(session).task
    if (current !== undefined && isActive(current.status)) {
      throw new Error('agent-kernel: task contract already exists for this session')
    }
    const delegation = this.state.entryOf(session).delegation
    const cwd = session.header.cwd
    const workspace = input.workspace ?? (cwd === undefined ? undefined : { root: cwd })
    if (input.workspace !== undefined) {
      const boundary = this.sandboxOf(session).workspaceRoot
      if (!isAbsolute(input.workspace.root) || !insideWorkspace(boundary, input.workspace.root)) {
        throw new Error(`agent-kernel: task workspace "${input.workspace.root}" is outside sandbox root "${boundary}"`)
      }
    }
    const parentTaskId = delegation?.parentTaskId ?? input.parentTaskId
    // A registered role supplies what a task of this kind starts from: its
    // policy profile and ceilings. An explicit input still wins on budget
    // ceilings, because a caller may narrow a role for one task but never
    // widen it — the grant check in `composeAuthorization` does that part.
    const profile = this.profiles.resolve(input.agentProfile)
    // A registered role is the more specific statement of how this task runs:
    // its policy profile and ceilings apply unless the caller named their own.
    const policyProfile = input.policyProfile ?? profile?.policyProfile ?? this.config.policyProfile
    const taskClass = this.classOf(session, input.agentProfile, input.taskClass)
    const taskId = brandString<TaskId>(randomUUID())
    const dependencies = input.dependencies ?? []
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error('agent-kernel: a task dependency is named twice')
    }
    const changeContract = resolveChangeContract(input.changeContract)
    const task: TaskContract = {
      taskId,
      runId: delegation?.childRunId ?? brandString<RunId>(randomUUID()),
      objective: input.objective,
      constraints: input.constraints ?? [],
      acceptance: input.acceptance ?? this.config.acceptanceByClass[taskClass] ?? [],
      ...changeContract === undefined ? {} : { changeContract },
      dependencies: [...dependencies],
      // A contract starts with no observation: evidence is recorded against a
      // task that already exists.
      evidence: [],
      ...workspace === undefined ? {} : { workspace },
      ...parentTaskId === undefined ? {} : { parentTaskId },
      agentProfile: input.agentProfile,
      taskClass,
      policyProfile: this.policyProfileOf(session, policyProfile).profile,
      budget: intersectBudgets(
        this.config.budgets,
        profile?.budget ?? {},
        delegation?.resourceLimits ?? {},
        input.budget ?? {},
      ),
      status: 'intake',
      revision: 1,
    }
    session.append('task/created', {
      ...task,
      metadata: kernelEventMetadata(task.runId, task.taskId, actor, sourceRef),
    })
    return task
  }

  /**
   * Record one legal task transition and return the resulting contract. An
   * illegal edge is a kernel defect, so it throws rather than silently dropping
   * the state change.
   * @param session - the session whose task moves.
   * @param task - the contract the transition is evaluated against.
   * @param to - the status the task enters.
   * @param trigger - why the task moved.
   * @param actor - who caused the move.
   * @param effects - side effects the transition commits.
   * @param reason - the preconditions the caller evaluated and the action that caused the move.
   * @returns the contract at the transition's resulting status and revision.
   */
  private transition(
    session: Session,
    task: TaskContract,
    to: TaskStatus,
    trigger: TransitionTrigger,
    actor: ActorKind,
    effects: readonly StateEffect[] = [],
    reason: TransitionReason = {},
  ): TaskContract {
    const enrolled = this.state.ledgerTask(session)
    const authorizing = reason.actionId === undefined
      ? undefined
      : this.state.entryOf(session).policies.get(reason.actionId)?.decisionId
    const transition: StateTransition = {
      transitionId: brandString<TransitionId>(randomUUID()),
      taskId: task.taskId,
      from: task.status,
      to,
      trigger,
      // The edge table and the revision compare-and-set are evaluated here, so
      // the durable record states which checks admitted the move beside the
      // preconditions the caller evaluated.
      preconditions: [
        { kind: 'legal-edge', satisfied: canTransition(task.status, to), detail: `${task.status} -> ${to}` },
        { kind: 'task-revision', satisfied: enrolled.revision === task.revision, detail: `evaluated against revision ${String(task.revision)}` },
        ...reason.preconditions ?? [],
      ],
      effects,
      evidence: [...task.evidence],
      taskRevision: task.revision,
      revision: task.revision + 1,
      ...authorizing === undefined ? {} : { policyDecisionId: authorizing },
      actor,
      at: Date.now(),
    }
    // Apply the same compare-and-set the fold applies, before the append, so an
    // inconsistent record can never reach the log.
    const next = applyTransition(task, transition)
    session.append('task/transitioned', {
      ...transition,
      metadata: kernelEventMetadata(task.runId, task.taskId, actor, sourceRefForActor(actor, trigger.kind), transition.at),
    })
    return next
  }

  /**
   * Apply the deployment's rule for untrusted proposals. Quarantine is the
   * fail-closed default: content the kernel cannot vouch for may still be
   * acted on, but only with a human answer, never by the permission document
   * alone.
   * @param proposal - the action whose source trust was recorded.
   * @param decision - the composed permission decision.
   * @returns the decision the authorization composes, at most `ask` when the
   *   proposal is untrusted and the deployment quarantines untrusted content.
   */
  private quarantineUntrusted(proposal: ActionProposal, decision: PolicyDecision): PolicyDecision {
    if (this.config.untrustedContent !== 'quarantine') return decision
    if (proposal.trust !== 'untrusted' || decision.effect !== 'allow') return decision
    return {
      ...decision,
      effect: 'ask',
      reasons: [...decision.reasons, 'untrusted-content quarantine: a proposal from untrusted content needs a human answer'],
    }
  }

  /**
   * Propose, evaluate, and compose authorization for one tool call.
   * @param exec - the pending call.
   * @param next - the waterfall continuation that allows the call.
   * @returns the decision the tool pipeline acts on.
   */
  /**
   * Refuse a call the session has already made twice with the same answer.
   * S4's no-progress detector: the third identical call cannot teach the model
   * anything, so the kernel records the failure and — where the deployment
   * enforces kernel decisions — tells the model to consolidate instead.
   * @param exec - the call about to run.
   * @returns the refusal decision, or undefined when the call may run.
   */
  private noProgress(exec: ToolExecution): PreToolDecision | undefined {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const session = agent.session
    // A call the kernel cannot account for under a task is not refused here:
    // `authorize` answers it, and a failure needs a task to belong to.
    if (this.state.entryOf(session).task === undefined) return undefined
    const governor = this.governorOf(session)
    const signature = `${exec.name}:${digestOf(exec.arguments)}`
    const run = governor.runOf(signature)
    if (run.count < REPEATED_CALLS) return undefined
    if (!governor.alreadyReported(signature, run.digest)) {
      this.recordFailure(
        session,
        'no-progress',
        `${String(run.count)} identical ${exec.name} calls returned the same result`,
      )
      governor.markReported(signature, run.digest)
    }
    if (this.config.mode !== 'enforce') return undefined
    return {
      kind: 'deny',
      reason: `no progress: ${exec.name} was called ${String(run.count)} times with the same arguments and the same result; consolidate what you have or change approach`,
    }
  }

  private async authorize(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const stalled = this.noProgress(exec)
    if (stalled !== undefined) return stalled
    const agent = exec.agent
    if (agent === undefined) {
      return this.config.mode === 'enforce'
        ? { kind: 'deny', reason: 'agent-kernel: cannot authorize a tool without an agent task' }
        : next()
    }
    const session = agent.session
    this.governorOf(session).noteToolEvent()
    const entry = this.state.entryOf(session)
    const task = entry.task
    if (task === undefined) {
      return this.config.mode === 'enforce'
        ? { kind: 'deny', reason: `agent-kernel: agent "${agent.id}" has no task contract` }
        : next()
    }
    const argumentsDigest = digestArguments(exec.arguments as ActionProposal['arguments'])
    const declared = this.capabilities.resolve(exec.name, exec.arguments)
    const proposal = proposalOf(exec, agent, task, argumentsDigest, this.capabilities.trustOf(exec.name))
    const roleGrant = this.profiles.resolve(task.agentProfile)?.capabilities
    const context: PolicyContext = {
      action: proposal,
      capabilities: declared ?? [],
      undeclared: declared === undefined,
      sandbox: this.sandboxOf(session),
      ...roleGrant === undefined ? {} : { agentGrant: roleGrant },
      ...entry.delegation === undefined ? {} : { parentGrant: entry.delegation },
    }
    const profile = this.policyProfileOf(session, task.policyProfile)
    const baseDecision = this.policy.evaluate(context)
    const profileDecision = profile.document === undefined
      ? undefined
      : this.profilePolicyEngine(profile.document).evaluate(context)
    const composed = profileDecision === undefined
      ? baseDecision
      : this.intersectPolicyDecisions(baseDecision, profileDecision, profile.profile)
    const enforced = this.config.mode === 'enforce'
    const decision = this.finalStepCeiling(
      this.actionCeiling(
        this.quarantineUntrusted(proposal, composed),
        entry.openActions.size,
        task.budget.maxConcurrentActions,
      ),
      task,
      entry.steps,
    )
    const authorization = composeAuthorization(decision, proposal, context, enforced)
    // One record carries the proposal, the rule decision, the composed
    // authorization (an `allow`, or an `ask` whose human outcome the commit's
    // governance receipt records), and the capabilities it granted, so a tool
    // call appends two kernel events in steady state instead of four.
    session.append('action/decided', {
      proposal,
      policy: composed,
      decision: authorization,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'kernel', {
        source: 'policy', locator: profile.profile,
      }),
    })
    if (declared?.some(request => request.capability === 'subagent.spawn' || request.capability === 'workflow.start')) {
      // §17.1: a spawned child or workflow may run long enough to suspend
      // this step, so the parent's state is indexed before the call proceeds.
      this.checkpoint(agent, 'before-suspension')
    }
    if (!enforced) return next()
    // The tool registry owns `ask` resolution: it routes the question through
    // the composed approval answerers and fails closed when there are none.
    if (authorization.effect === 'ask') return { kind: 'ask', reason: authorization.reasons.join('; ') }
    if (authorization.effect === 'deny') {
      return { kind: 'deny', reason: `agent-kernel denied "${exec.name}": ${authorization.reasons.join('; ')}` }
    }
    return next()
  }

  /**
   * Cap a composed rule decision at `deny` when the task already has as many
   * actions in flight as its concurrency ceiling allows. The count is the
   * session's own ledger — actions proposed and not yet committed — so a
   * parallel call beyond the ceiling is refused before this action opens a
   * further in-flight slot. Shadow mode records the denial and lets the call
   * run; enforce mode returns it.
   * @param decision - the composed rule decision.
   * @param inFlight - actions the task has proposed and not yet committed.
   * @param ceiling - the task's configured concurrency ceiling, when it has one.
   * @returns the decision, denied when the ceiling is already reached.
   */
  private actionCeiling(decision: PolicyDecision, inFlight: number, ceiling: number | undefined): PolicyDecision {
    if (ceiling === undefined || inFlight < ceiling) return decision
    return {
      ...decision,
      effect: 'deny',
      reasons: [...decision.reasons, `the task already has ${String(inFlight)} of ${String(ceiling)} actions in flight`],
    }
  }

  /**
   * Classify a settled tool outcome whose arguments were rejected. The registry
   * reports the violation before any approval prompt, so no human decided this
   * call; the kernel records the failure kind whose recovery answers the model
   * with the parse or schema error.
   * @param exec - the call that settled.
   * @param result - the outcome the registry produced.
   */
  private classifyToolArguments(exec: ToolExecution, result: ToolExecutionResult): void {
    const agent = exec.agent
    if (agent === undefined) return
    const failure = result.error
    const info = failure?.info
    if (failure === undefined || info === undefined) return
    if (info.name !== 'ToolArgsError' && info.code !== 'INVALID_ARGS') return
    const session = agent.session
    // A call the kernel cannot account for under a task is not classified here:
    // a failure needs a task to belong to.
    if (this.state.entryOf(session).task === undefined) return
    this.recordFailure(session, 'tool-args-malformed', `tool "${exec.name}" rejected its arguments: ${failure.message}`)
  }

  /**
   * Cap a composed rule decision at `deny` during the one final, tool-free step
   * a task at its step ceiling was granted: the model answers from the results
   * it already has instead of starting work the task has no allowance left to
   * verify or checkpoint. Shadow mode records the denial and lets the call run.
   * @param decision - the composed rule decision.
   * @param task - the task the call is proposed against.
   * @param steps - steps the session already started.
   * @returns the decision, denied once the task is past its ceiling.
   */
  private finalStepCeiling(decision: PolicyDecision, task: TaskContract, steps: number): PolicyDecision {
    const ceiling = task.budget.maxSteps
    if (!this.finalSteps.has(task.taskId) || ceiling === undefined || steps < ceiling) return decision
    return {
      ...decision,
      effect: 'deny',
      reasons: [
        ...decision.reasons,
        `the task reached its ${String(ceiling)}-step ceiling: this is the final step, no tool may run, answer from the results you already have`,
      ],
    }
  }

  /**
   * Commit the observation for one settled call.
   * @param exec - the call that settled.
   * @param isError - whether the tool reported a failure.
   */
  private commit(exec: ToolExecution, isError: boolean, result: ToolResult): void {
    const agent = exec.agent
    if (agent === undefined) return
    const session = agent.session
    const actionId = actionIdOf(exec.callId)
    const entry = this.state.entryOf(session)
    const authorization = entry.authorizations.get(actionId)
    const task = entry.task
    if (authorization === undefined || task === undefined) return
    const committedAt = Date.now()
    const receipt: ActionReceipt = {
      actionId,
      toolName: exec.name,
      decisionId: authorization.decisionId,
      outcome: outcomeOf(authorization, entry.approvals.get(actionId), isError),
      governance: governanceOf(actionId, authorization, entry),
      resultDigest: digestOf(result.content),
      committedAt,
    }
    // The loop detectors and the no-progress refusal read this history, so the
    // settle appends the call with the digest of what it returned.
    const governor = this.governorOf(session)
    governor.noteToolEvent()
    const argumentsJson = JSON.stringify(exec.arguments) as string | undefined
    governor.noteCall({
      tool: exec.name,
      signature: `${exec.name}:${digestOf(exec.arguments)}`,
      arguments: argumentsJson ?? '',
      digest: receipt.resultDigest,
    })
    // The grants a settled action held end with it; the settle record says so
    // rather than a separate revocation event.
    const revoked: CapabilityGrant[] = authorization.enforced && authorization.capabilityGrants.length > 0
      ? [{ actionId, capabilities: authorization.capabilityGrants }]
      : []
    session.append('action/committed', {
      ...receipt,
      revoked,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'tool', { source: 'tool', locator: String(exec.callId) }, committedAt),
    })
    // §7.4: the settled action is the observation the plan comparison reads, so
    // the drift check runs once the receipt it answers is durable.
    this.detectPlanDrift(session)
    // §10.5: a settled write is the task changing the code, which is the
    // CONTRACT/IMPLEMENT boundary; a write that failed changed nothing.
    const declared = this.capabilities.resolve(exec.name, exec.arguments)
    if (!isError && declared?.some(request => request.capability === 'fs.write' || request.capability === 'fs.edit')) {
      this.lifecycle.advance(session, 'implement', `${exec.name} changed the workspace`)
    }
  }

  /**
   * Compare the task's observed actions with the plan it recorded, and escalate
   * when the trailing run of actions matching no plan step reaches the
   * configured tolerance.
   *
   * The comparison reads the log rather than a counter: `tool/call` events after
   * the latest `task/plan` are the observed action sequence, so a replay
   * computes the same drift. One escalation is recorded per episode — the
   * failure stays unresolved until a new plan revision or a passing verification
   * answers it — and the escalation is the recorded failure and its recovery
   * decision, which the completion gate then reads.
   * @param session - the session whose actions are compared with its plan.
   */
  private detectPlanDrift(session: Session): void {
    const entry = this.state.entryOf(session)
    const plan = entry.plan
    if (plan === undefined) return
    for (const failure of entry.failures.values()) {
      if (failure.kind === 'plan-drift') return
    }
    const drifting = planDriftRun(plan.steps, this.actionsSincePlan(session))
    if (drifting < this.config.planDriftTolerance) return
    this.recordFailure(
      session,
      'plan-drift',
      `${String(drifting)} consecutive actions match no step of plan revision ${String(plan.revision)}`,
    )
  }

  /**
   * The observed action sequence since the latest recorded plan revision, as
   * the text the drift comparison reads. `tool/call` is the durable record of
   * what was proposed to run, so a denied call is observed here too.
   * @param session - the session whose log is read.
   * @returns `"<tool> <arguments>"` per call after that revision, in log order.
   */
  private actionsSincePlan(session: Session): readonly string[] {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = session.snapshotEvents()
    const latest = events.findLastIndex(event => event.type === 'task/plan')
    if (latest < 0) return []
    return events.slice(latest + 1)
      .filter((event): event is SessionEvent<'tool/call'> => event.type === 'tool/call')
      .map(event => `${event.data.name} ${event.data.arguments}`)
  }

  /**
   * The session's technical boundary, resolved by its owner when one is mounted.
   * @param session - the calling session.
   * @returns the resolved policy; a read-only boundary rooted at the session cwd when no owner is mounted.
   */
  private sandboxOf(session: Session): SandboxExecutionPolicy {
    const owner = this.ctx.get('sandboxPolicy')
    if (owner !== undefined) return owner.resolve({ session })
    return { mode: 'read-only', workspaceRoot: session.header.cwd ?? process.cwd() }
  }

  /**
   * Close one turn: record the observation edge, then run the completion gate
   * when the task declares a required acceptance criterion. A coding task's
   * lifecycle records LOCAL VERIFY here and its REVIEW, REGRESSION, COMPLETE or
   * repair return as the attempt settles.
   * @param agent - the agent whose turn is stopping.
   * @param turn - the turn that is stopping.
   * @param signal - the turn's cancellation, handed to the independent reviewer.
   */
  private async closeTurn(agent: Agent, turn: number, signal: AbortSignal): Promise<void> {
    const session = agent.session
    // The turn closed, so no step is in flight and a stall from here on is an
    // agent-level one rather than a step that never finished.
    this.governorOf(session).closeStep()
    const view = this.state.view(session)
    if (view === undefined) return
    if (!isActive(view.task.status)) return
    // S4: a task that reached its step ceiling already spent the one final,
    // tool-free step the ceiling grants, so this turn is its last: index the
    // state a resume would restart from and park it.
    const ceiling = view.task.budget.maxSteps
    const spent = this.state.entryOf(session).steps
    if (ceiling !== undefined && spent >= ceiling && this.finalSteps.has(view.task.taskId)) {
      this.pauseAtCeiling(agent, `turn ${turn} (final step)`, ceiling, spent)
      return
    }
    // §17.1: index the observed state before it advances toward
    // verification, so a resume never replays past this turn's boundary.
    this.checkpoint(agent, 'turn-boundary')
    const observed = canTransition(view.task.status, 'observing')
      ? this.transition(session, view.task, 'observing', { kind: 'turn-ended', detail: `turn ${turn}` }, 'kernel')
      : view.task
    // §10.5: the turn's end is where LOCAL VERIFY runs. A phase that already
    // spent its step ceiling parks the task for a human instead of verifying
    // the same failing change again.
    const check = this.lifecycle.advance(session, 'local-verify', `turn ${turn}`)
    if (check.exhausted !== undefined) {
      this.parkForLifecycleBudget(agent, check.exhausted)
      return
    }
    if (observed.acceptance.length === 0 && !this.verification.requiredFor(observed)) {
      // Nothing to verify: a task of this class answers without a criterion, so
      // its completion is vacuous rather than unproven, and the log records no
      // verification pair to fold.
      const detail = `a ${observed.taskClass ?? 'conversational'} task requires no acceptance criterion`
      const preconditions: readonly Predicate[] = [{
        kind: 'acceptance-criteria',
        satisfied: this.verification.requiredFor(observed),
        detail,
      }]
      const verifying = canTransition(observed.status, 'verifying')
        ? this.transition(session, observed, 'verifying', { kind: 'verification-requested', detail }, 'kernel', [], { preconditions })
        : observed
      await this.completeWithLifecycle(agent, signal, verifying, detail, preconditions)
      return
    }
    const changed = this.changedScopes(session, turn)
    const entry = this.state.entryOf(session)
    // Nothing changed since the last passing verification of this task, so the
    // result still stands: re-running the verifiers could only reproduce it.
    const passed = entry.passingVerification
    if (changed.length === 0 && passed !== undefined && passed.taskId === observed.taskId) {
      const detail = `no scope changed since the passing verification at revision ${String(passed.revision)}`
      const preconditions: readonly Predicate[] = [{
        kind: 'changed-scopes',
        satisfied: false,
        detail,
      }]
      const verifying = canTransition(observed.status, 'verifying')
        ? this.transition(session, observed, 'verifying', { kind: 'verification-requested', detail }, 'kernel', [], { preconditions })
        : observed
      await this.completeWithLifecycle(agent, signal, verifying, detail, preconditions)
      return
    }
    const decision = await this.verifyTask(session, observed, changed, turn)
    const current = this.state.ledgerTask(session)
    if (decision.allowed && canTransition(current.status, 'completed')) {
      const detail = decision.reasons.join('; ')
      await this.completeWithLifecycle(agent, signal, current, detail, [{
        kind: 'completion-gate',
        satisfied: decision.allowed,
        detail,
      }])
      return
    }
    this.repairOrAskUser(agent, decision.reasons)
  }

  /**
   * Run the coding lifecycle's tail around a passing check: enter REVIEW, run
   * the deployment's independent reviewer once, record REGRESSION and COMPLETE,
   * and let the completion transition cite the phase log.
   *
   * A review that found defects is not a passing check, so the task returns to
   * IMPLEMENT through the kernel's repair path rather than completing. A
   * deployment that enabled the review without supplying a reviewer never
   * completes silently: the misconfiguration is recorded and the task asks the
   * user.
   * @param agent - the agent whose task is completing.
   * @param signal - the turn's cancellation, handed to the reviewer.
   * @param verifying - the contract at its verifying status.
   * @param detail - why the check passed.
   * @param preconditions - the preconditions the caller already evaluated.
   */
  private async completeWithLifecycle(
    agent: Agent,
    signal: AbortSignal,
    verifying: TaskContract,
    detail: string,
    preconditions: readonly Predicate[],
  ): Promise<void> {
    const session = agent.session
    if (this.lifecycle.phasesFor(verifying.taskClass).length > 0) {
      const review = this.lifecycle.advance(session, 'review', detail)
      if (review.exhausted !== undefined) {
        this.parkForLifecycleBudget(agent, review.exhausted)
        return
      }
      let report: CodeReviewReport | undefined
      try {
        report = await this.lifecycle.review(agent, signal)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.recordFailure(session, 'workflow-failed', message)
        this.parkTask(session, message)
        return
      }
      if (report !== undefined && report.findings.length > 0) {
        this.repairOrAskUser(agent, [
          `the independent reviewer found ${String(report.findings.length)} defect(s): ${report.summary}`,
          ...report.findings.map(finding =>
            `${finding.severity} ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} — ${finding.message}`,
          ),
        ])
        return
      }
      const regression = this.lifecycle.advance(session, 'regression', detail)
      if (regression.exhausted !== undefined) {
        this.parkForLifecycleBudget(agent, regression.exhausted)
        return
      }
    }
    const complete = this.lifecycle.advance(session, 'complete', detail)
    if (complete.exhausted !== undefined) {
      this.parkForLifecycleBudget(agent, complete.exhausted)
      return
    }
    if (canTransition(verifying.status, 'completed')) {
      this.transition(session, verifying, 'completed', { kind: 'verification-passed', detail }, 'kernel', [], {
        preconditions: [...preconditions, this.lifecycle.completionPredicate(session)],
      })
    }
  }

  /**
   * Route a failed check into the kernel's repair path: record the failure, let
   * the recovery engine decide, steer the model back into work while repair
   * attempts remain, and hand the decision to the user once they run out. The
   * coding lifecycle records the repair return to IMPLEMENT on the way, so a
   * failed LOCAL VERIFY, REVIEW, or REGRESSION is one repair, never a loop.
   * @param agent - the agent whose task is being repaired.
   * @param reasons - what failed, one reason per line for the model.
   */
  private repairOrAskUser(agent: Agent, reasons: readonly string[]): void {
    const session = agent.session
    // §8.5 regression verify: the criteria an earlier verification of this task
    // passed must still pass after the repair. The verifier registry already
    // re-ran every criterion the S6 result cache could not answer for the
    // current repository digest, so this leg starts no verifier of its own — it
    // attributes a repair that broke previously verified behaviour, and the
    // failure it records counts against the same repair budget.
    const { priorVerification, latestVerification } = this.state.entryOf(session)
    const regressed = latestVerification === undefined ? [] : regressedCriteria(priorVerification, latestVerification)
    const regression = regressionDetail(regressed)
    const failureKind: FailureKind = regression === undefined ? 'verification-failed' : 'verification-regressed'
    const steered = regression === undefined ? reasons : [regression, ...reasons]
    const detail = steered.join('; ')
    this.recordFailure(session, failureKind, detail)
    const failed = this.state.ledgerTask(session)
    const repair = this.lifecycle.repair(session, detail)
    if (repair.exhausted !== undefined) {
      this.parkForLifecycleBudget(agent, repair.exhausted)
      return
    }
    // The gate keeps the turn open through a steering message while repairs
    // remain; past the cap the decision belongs to the user.
    const repairs = this.verificationFailures(session, failed.taskId)
    const preconditions: readonly Predicate[] = [{
      kind: 'repair-attempts',
      satisfied: repairs < this.config.maxRepairAttempts,
      detail: `${String(repairs)} of ${String(this.config.maxRepairAttempts)}`,
    }]
    if (repairs < this.config.maxRepairAttempts) {
      if (canTransition(failed.status, 'recovering')) {
        this.transition(session, failed, 'recovering', { kind: 'verification-failed', detail }, 'kernel', [], { preconditions })
      }
      // §17.1: index the failing state before the repair steer changes it.
      this.checkpoint(agent, 'verification-failure')
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: REPAIR_PROMPT(steered) }],
        source: {
          kind: 'agent-kernel',
          form: 'notice',
          summary: regression === undefined ? 'verification failed; repair the task' : 'a repair regressed previously passing criteria',
        },
      }))
      return
    }
    const exhausted = this.state.ledgerTask(session)
    if (canTransition(exhausted.status, 'awaiting-user')) {
      this.transition(session, exhausted, 'awaiting-user', { kind: 'human-required', detail }, 'kernel', [], { preconditions })
    }
  }

  /**
   * Park a coding task whose phase reached its configured step ceiling: the
   * failure is recorded, the recovery engine decides, and the task waits for a
   * human instead of running the same phase again.
   * @param agent - the agent whose task is parked.
   * @param budget - the phase ceiling the pipeline reached.
   */
  private parkForLifecycleBudget(agent: Agent, budget: CodingPhaseBudget): void {
    const session = agent.session
    const detail = `the coding lifecycle ${budget.phase} phase spent its ${String(budget.budget)}-step ceiling`
    this.recordFailure(session, 'budget-exhausted', detail)
    this.parkTask(session, detail)
  }

  /**
   * Move a task to `awaiting-user`: the kernel cannot advance it on its own, so
   * the decision belongs to a human.
   * @param session - the session whose task waits.
   * @param detail - why the kernel stopped.
   */
  private parkTask(session: Session, detail: string): void {
    const task = this.state.ledgerTask(session)
    if (canTransition(task.status, 'awaiting-user')) {
      this.transition(session, task, 'awaiting-user', { kind: 'human-required', detail }, 'kernel')
    }
  }

  /**
   * Append one coding-lifecycle record with the kernel's audit metadata.
   * @param session - the session the record belongs to.
   * @param record - the phase entry or reviewer report to append.
   * @throws When the session holds no task.
   */
  private recordLifecycle(session: Session, record: CodingPhaseRecord | CodeReviewRecord): void {
    const task = this.state.entryOf(session).task
    if (task === undefined) throw new Error('agent-kernel: cannot record a coding-lifecycle entry without a task')
    const metadata = kernelEventMetadata(task.runId, task.taskId, 'kernel', {
      source: 'kernel',
      locator: 'coding-lifecycle',
    }, record.at)
    if ('phase' in record) session.append('task/phase', { ...record, metadata })
    else session.append('task/review', { ...record, metadata })
  }

  /**
   * How many verification failures this task has already recorded, so the gate
   * can tell a first repair from a loop that keeps failing the same way.
   * @param session - the session whose log is read.
   * @param taskId - the task the failures must belong to.
   * @returns the recorded count.
   */
  private verificationFailures(session: Session, taskId: TaskId): number {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return session.snapshotEvents().filter(event =>
      event.type === 'failure/recorded'
      && (event.data.kind === 'verification-failed' || event.data.kind === 'verification-regressed')
      && event.data.metadata?.taskId === taskId,
    ).length
  }

  /**
   * Record one verification request, collect its verdicts, and decide completion.
   * @param session - the session whose task is verified.
   * @param task - the contract the verification is requested for.
   * @param changedScopes - scopes the task changed, for `diff` verifiers.
   * @param turn - the turn the request belongs to; omitted digests the latest recorded repository state.
   * @returns the completion decision.
   */
  private async verifyTask(
    session: Session,
    task: TaskContract,
    changedScopes: readonly string[],
    turn?: number,
  ): Promise<CompletionDecision> {
    if (canTransition(task.status, 'verifying')) {
      this.transition(session, task, 'verifying', { kind: 'verification-requested' }, 'kernel')
    }
    const current = this.state.ledgerTask(session)
    const request = this.verification.request(current, changedScopes, this.repositoryDigest(session, turn))
    session.append('verification/requested', {
      ...request,
      metadata: kernelEventMetadata(current.runId, current.taskId, 'kernel', { source: 'kernel', locator: 'verification' }),
    })
    const { results, commands } = await this.verifiers.collect(request)
    const result = this.verification.evaluate(request, results, commands)
    session.append('verification/result', {
      ...result,
      metadata: kernelEventMetadata(current.runId, current.taskId, 'kernel', { source: 'kernel', locator: 'verification' }),
    })
    const after = this.state.ledgerTask(session)
    const failures = [...this.state.entryOf(session).failures.values()]
    return this.verification.decide(after, result, failures, this.state.measure(after, session))
  }

  /**
   * Record one classified failure, diagnose it, and record the recovery chosen
   * for it. The diagnosis is committed between the failure and its decision, so
   * the decision answers a diagnosed failure rather than a bare classification.
   * @param session - the session that observed it.
   * @param kind - its classification.
   * @param detail - human- and model-readable detail.
   * @returns the recorded failure.
   */
  private recordFailure(session: Session, kind: FailureKind, detail: string): FailureRecord {
    const entry = this.state.entryOf(session)
    const task = entry.task
    if (task === undefined) throw new Error('agent-kernel: cannot record a failure without a task')
    const failureAt = Date.now()
    const failure: FailureRecord = {
      failureId: brandString<FailureId>(randomUUID()),
      kind,
      detail,
      at: failureAt,
    }
    session.append('failure/recorded', {
      ...failure,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'kernel', { source: 'kernel' }, failureAt),
    })
    const recoveryStartedAt = Date.now()
    session.append('recovery/started', {
      failureId: failure.failureId,
      kind: failure.kind,
      startedAt: recoveryStartedAt,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'kernel', { source: 'kernel' }, recoveryStartedAt),
    })
    const input: RecoveryInput = {
      failure,
      attempts: 0,
      maxAttemptsPerAction: this.config.maxAttemptsPerAction,
    }
    const diagnosis = this.recovery.diagnose(input, {
      evidence: [...entry.evidence.keys()],
      hypotheses: [...entry.hypotheses.keys()],
    })
    session.append('failure/diagnosed', {
      ...diagnosis,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'kernel', { source: 'kernel' }, diagnosis.at),
    })
    const decision = this.recovery.classify(input)
    session.append('recovery/decided', {
      ...decision,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'kernel', { source: 'kernel' }, decision.at),
    })
    return failure
  }
}

/**
 * Resolve the plan-drift tolerance. The value is a count of actions, so a
 * negative or fractional tolerance is a configuration defect: it would either
 * escalate before any action ran or never compare as intended. A self-contained
 * defect fails plugin load rather than surfacing as a run-time surprise.
 * @param configured - the value the deployment supplied, when it supplied one.
 * @returns the tolerance the kernel runs under.
 * @throws When the supplied value is not a non-negative integer.
 */
function resolvePlanDriftTolerance(configured: number | undefined): number {
  if (configured === undefined) return 3
  if (!Number.isInteger(configured) || configured < 0) {
    throw new Error(`agent-kernel: planDriftTolerance must be a non-negative integer, got ${String(configured)}`)
  }
  return configured
}

/**
 * Resolve the criteria a task of one class starts from: the class's own
 * configured entry, else the deployment's global list, else the shipped default
 * for the class. The precedence lives here rather than in task creation, so one
 * place states what a task starts from and a caller-supplied contract is the
 * only other source.
 * @param config - the validated plugin configuration.
 * @returns the criteria every task class starts from.
 * @throws When a configured class key is not a task class.
 */
function resolveAcceptanceByClass(config: Config): Partial<Record<TaskClass, AcceptanceCriterion[]>> {
  const configured = config.acceptanceByClass ?? {}
  for (const taskClass of Object.keys(configured)) {
    if (!TASK_CLASSES.includes(taskClass as TaskClass)) {
      throw new Error(`agent-kernel: acceptanceByClass names unknown task class "${taskClass}"`)
    }
  }
  const global = config.acceptance ?? []
  const resolved: Partial<Record<TaskClass, AcceptanceCriterion[]>> = {}
  for (const taskClass of TASK_CLASSES) {
    resolved[taskClass] = configured[taskClass]
      ?? (global.length > 0 ? global : [...DEFAULT_ACCEPTANCE_BY_CLASS[taskClass]])
  }
  return resolved
}

/**
 * Resolve the per-class completion requirement: a class named in the override
 * map takes its own value, and every other class takes the deployment default.
 * @param config - the validated plugin configuration.
 * @returns the requirement the completion gate applies per class.
 */
function requireCriteriaByClass(config: Config): Partial<Record<TaskClass, boolean>> {
  const fallback = config.requireAcceptanceCriteria ?? false
  const resolved: Partial<Record<TaskClass, boolean>> = {}
  for (const taskClass of TASK_CLASSES) resolved[taskClass] = config.requireAcceptanceCriteriaByClass?.[taskClass] ?? fallback
  return resolved
}

const RESOURCE_BUDGET_FIELDS = [
  'maxSteps',
  'maxToolCalls',
  'maxTokens',
  'maxWallMs',
  'maxCostUsd',
  'maxSubagentDepth',
  'maxConcurrentActions',
] as const satisfies readonly (keyof ResourceBudget)[]

/** Intersect deployment, delegation and caller budget ceilings. */
function intersectBudgets(...budgets: readonly ResourceBudget[]): ResourceBudget {
  const result: Partial<Record<keyof ResourceBudget, number>> = {}
  for (const key of RESOURCE_BUDGET_FIELDS) {
    for (const budget of budgets) {
      const ceiling = budget[key]
      if (ceiling === undefined) continue
      const current = result[key]
      result[key] = current === undefined ? ceiling : Math.min(current, ceiling)
    }
  }
  return result
}

const SOURCE_KIND_BY_ACTOR = {
  user: 'user',
  model: 'model',
  kernel: 'kernel',
  tool: 'tool',
  system: 'kernel',
} as const satisfies Readonly<Record<ActorKind, SourceRef['source']>>

/**
 * Build the versioned audit fields attached to a new kernel event.
 * @param runId - the execution run this record belongs to.
 * @param taskId - the task this record belongs to, when one exists.
 * @param actor - the actor that caused the record.
 * @param sourceRef - the source and locator of the recorded fact.
 * @param timestamp - the time the record was committed.
 * @returns the event's audit metadata.
 */
function kernelEventMetadata(
  runId: RunId,
  taskId: TaskId | undefined,
  actor: ActorKind,
  sourceRef: SourceRef,
  timestamp = Date.now(),
): KernelEventMetadata {
  return {
    version: 1,
    runId,
    ...taskId === undefined ? {} : { taskId },
    actor,
    timestamp,
    sourceRef,
  }
}

/**
 * Derive an event's source kind from its actor.
 * @param actor - the actor that caused the event.
 * @param locator - the state-transition trigger.
 * @returns the source reference.
 */
function sourceRefForActor(actor: ActorKind, locator: string): SourceRef {
  return { source: SOURCE_KIND_BY_ACTOR[actor], locator }
}
/**
 * Hash one parsed tool-argument value without retaining its text.
 * @param arguments_ - the lossless JSON arguments materialized by the tool registry.
 * @returns the SHA-256 digest of their JSON serialization.
 * @throws When the value cannot be serialized as JSON.
 */
function digestArguments(arguments_: ActionProposal['arguments']): string {
  const serialized = JSON.stringify(arguments_) as string | undefined
  if (serialized === undefined) throw new Error('agent-kernel: action arguments are not JSON')
  return createHash('sha256').update(serialized, 'utf8').digest('hex')
}

/**
 * Build the proposal record for one call without duplicating raw arguments in
 * kernel audit events; `tool/call` remains the replay source for the originals.
 * @param exec - the pending call.
 * @param agent - the agent on whose behalf it runs.
 * @param task - the task contract the proposal is made against.
 * @param argumentsDigest - SHA-256 of the call's parsed arguments.
 * @param trust - the trust the declaring package recorded for this tool's content.
 * @returns the proposal with digest-only argument content.
 */
function proposalOf(
  exec: ToolExecution,
  agent: Agent,
  task: TaskContract,
  argumentsDigest: string,
  trust: TrustLabel | undefined,
): ActionProposal {
  return {
    actionId: actionIdOf(exec.callId),
    agentId: agent.id,
    callId: exec.callId,
    toolName: exec.name,
    arguments: { sha256: argumentsDigest },
    source: 'model',
    taskRevision: task.revision,
    trust: trust ?? 'unknown',
  }
}

/**
 * The settled outcome of one action. A refusal the kernel enforced, or a human
 * answer that was not `allowed-once`, is recorded as `denied` rather than as an
 * execution failure.
 * @param authorization - the composed decision the action ran under.
 * @param approvalOutcome - the human outcome observed for the action, when one was recorded.
 * @param isError - whether the tool reported a failure.
 * @returns the receipt outcome.
 */
function outcomeOf(
  authorization: AuthorizationDecision,
  approvalOutcome: GovernanceReceipt['approvalOutcome'],
  isError: boolean,
): ActionReceipt['outcome'] {
  const refused = authorization.effect === 'deny'
    || (approvalOutcome !== undefined && approvalOutcome !== 'allowed-once')
  if (authorization.enforced && refused) return 'denied'
  return isError ? 'failed' : 'succeeded'
}

/**
 * Link the composed decision with the sandbox and the human decision that applied.
 * @param actionId - the action being committed.
 * @param authorization - the composed decision it executed under.
 * @param entry - the session's folded ledger entry.
 * @returns the governance receipt.
 */
function governanceOf(actionId: ActionProposal['actionId'], authorization: AuthorizationDecision, entry: LedgerEntry): GovernanceReceipt {
  const approvalOutcome = entry.approvals.get(actionId)
  return {
    actionId,
    decisionId: authorization.decisionId,
    sandboxMode: authorization.sandbox.mode,
    workspaceRoot: authorization.sandbox.workspaceRoot,
    approver: approvalOutcome !== undefined ? 'user' : authorization.effect === 'ask' ? 'none' : 'policy',
    ...approvalOutcome === undefined ? {} : { approvalOutcome },
    at: Date.now(),
  }
}

/**
 * The objective stated by the messages that started one step.
 * @param messages - the step's claimed messages.
 * @returns the first human message's text, or an empty string when the step claims none.
 */
function humanObjective(messages: readonly UserMessage[]): string {
  const human = messages.find(message => message.source.kind === 'user')
  if (human === undefined) return ''
  return human.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

export default AgentKernelService
