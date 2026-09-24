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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
// Type-only: activates the `ctx.sandboxPolicy` Context declaration.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: declares the `compaction/start` Session event.
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: declares the `workspace/changes` Session event and `ctx.workspaceChanges`.
import type {} from '@deepseek-ai/dsh-workspace-changes'
import type { PreToolDecision, ToolExecution, ToolResult } from '@deepseek-ai/dsh-tools'
import { ToolCapabilityRegistry } from './capabilities.ts'
import { delegationReceipt, policyDigest } from './delegation.ts'
import { actionIdOf, KernelLedger, type LedgerEntry } from './ledger.ts'
import { admittedCapabilities, CAPABILITY_VOCABULARY, compilePolicy, composeAuthorization, insideWorkspace, PermissionPolicyEngine, POLICY_ACTIONS, POLICY_EFFECTS } from './policy.ts'
import { KernelProfileRegistry } from './profiles.ts'
import { DefaultRecoveryEngine } from './recovery.ts'
import { scanForRecovery } from './recovery-scan.ts'
import { applyTransition, canTransition, isActive } from './state-machine.ts'
import { TASK_CLASSES } from './types.ts'
import type {
  AgentKernel,
  BudgetGovernor,
  AcceptanceCriterion,
  ActionProposal,
  ActionReceipt,
  ActorKind,
  AuthorizationDecision,
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
  RecoveryScanEntry,
  TaskHypothesis,
  TaskHypothesisId,
  TaskHypothesisInput,
  KernelEventMetadata,
  Provenance,
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
export { readKernelRecord, type KernelRecord } from './ledger.ts'
export { readKernelMetrics, type KernelMetrics } from './metrics.ts'
export { scanForRecovery, TERMINAL_TASK_STATUSES } from './recovery-scan.ts'
export { CAPABILITY_VOCABULARY, compilePolicy, POLICY_ACTIONS, POLICY_EFFECTS } from './policy.ts'

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
   * Criteria a task of one class starts with, overriding {@link acceptance} for
   * that class. Declaring `conversational` here is the only way a conversational
   * task gets a criterion.
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
}

/** The shape every configured acceptance criterion takes, in `Config` and per class. */
const CRITERIA_SCHEMA = z.object({
  id: z.string(),
  description: z.string(),
  verifier: z.union(['test', 'build', 'diff', 'assertion', 'human', 'research'] as const),
  required: z.boolean(),
})

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
  acceptanceByClass: z.object({
    conversational: z.array(CRITERIA_SCHEMA),
    coding: z.array(CRITERIA_SCHEMA),
    research: z.array(CRITERIA_SCHEMA),
    operations: z.array(CRITERIA_SCHEMA),
  }),
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

/** One session's run of identical calls with identical results. */
interface ProgressTally {
  /** `toolName:argumentsDigest` of the run. */
  readonly signature: string
  /** Digest of the result the run kept returning. */
  readonly digest: string | undefined
  /** How many calls the run covers. */
  readonly count: number
  /** Whether this run was already reported as a `no-progress` failure. */
  readonly refused?: boolean
}

/**
 * One step of the no-progress tally: a call that repeats the tracked tool and
 * arguments extends the run only while it also returns the same digest.
 * @param tracked - the tally so far, when this session has one.
 * @param exec - the call that settled.
 * @param receipt - its receipt, carrying the outcome digest.
 * @returns the tally after this call.
 */
function nextProgress(tracked: ProgressTally | undefined, exec: ToolExecution, receipt: ActionReceipt): ProgressTally {
  const signature = `${exec.name}:${digestOf(exec.arguments)}`
  if (tracked === undefined || tracked.signature !== signature || tracked.digest !== receipt.resultDigest) {
    return { signature, digest: receipt.resultDigest, count: 1 }
  }
  return { ...tracked, count: tracked.count + 1 }
}

/**
 * Digest one JSON value, so two results compare by what they said.
 * @param value - the value to digest.
 * @returns the hex digest.
 */
function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
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
  /** Criteria recorded on created task contracts. */
  readonly acceptance: AcceptanceCriterion[]
  /** Criteria a task of one class starts with instead, when configured. */
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
  /** The read model and budget observer over session logs. */
  readonly state: KernelLedger
  /** Budget observer over the current session ledger. */
  readonly budgets: BudgetGovernor
  private readonly config: ResolvedConfig
  /** Capabilities the deployment's document admits at all, handed to a root parent's children. */
  private readonly admitted: readonly Capability[]
  /** Digest of the permission document, recorded on every delegation receipt. */
  private readonly permissionDigest: string
  private policyProfileProvider: PolicyProfileProvider | undefined
  private readonly profilePolicyEngines = new WeakMap<PolicyDocument, PermissionPolicyEngine>()
  /**
   * Per-session tally of the current run of identical calls with identical
   * results. The tally is process state on purpose: the durable record of a
   * refusal is the `no-progress` failure, and a resumed process starts a fresh
   * run rather than refusing a call for a history it no longer counts.
   */
  private readonly progress = new Map<SessionId, ProgressTally>()

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
      acceptance: config.acceptance ?? [],
      acceptanceByClass: config.acceptanceByClass ?? {},
      taskClass: config.taskClass ?? 'conversational',
      requireAcceptanceCriteria: requireCriteriaByClass(config),
      maxRepairAttempts: config.maxRepairAttempts ?? 3,
      maxAttemptsPerAction: config.maxAttemptsPerAction ?? 2,
      maxPlanRevisions: config.maxPlanRevisions ?? 32,
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
    this.verifiers = new CriterionVerifierRegistry(config.verifierTimeoutMs ?? 60_000)
    this.recovery = new DefaultRecoveryEngine({ checkpointBeforeRetry: config.checkpointBeforeRetry ?? true })
    const startupRecovery = Promise.withResolvers<readonly RecoveryScanEntry[]>()
    this.startupRecovery = startupRecovery.promise
    void this.startupRecovery.catch(error => {
      ctx.logger.warn(`agent-kernel: startup recovery scan failed: ${String(error)}`)
    })
    ctx.inject(['sessionPersistence'], async inner => {
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
    this.state = new KernelLedger()
    this.budgets = this.state

    // `agent/inbox/claimed` fires before prompt assembly, so the first request's
    // context compiler can read the task and required criteria from the log.
    ctx.on('agent/inbox/claimed', ({ agent, message }) => this.openClaimedTask(agent, message))
    ctx.on('agent/created', (payload) => {
      this.delegate(payload.agent)
      if (payload.source === 'resume') this.recordCheckpointResume(payload.agent)
    })
    ctx.on('agent/pre-step', (payload, next) => {
      this.openOrAdvance(payload.agent, payload.messages, payload.turn, payload.step)
      return next()
    })
    ctx.on('agent/turn-stopping', payload => this.closeTurn(payload.agent, payload.turn))
    // §17.1: compaction may rewrite or drop the log tail a resume would
    // otherwise replay from, so the kernel checkpoints before it runs.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/start') return
      // `session.append` refuses to reenter while `compaction/start`'s own
      // append is still publishing, so the checkpoint runs on the next
      // microtask instead of inline in this listener.
      queueMicrotask(() => {
        const agent = ctx.get('agents')?.get(session.id)
        if (agent !== undefined) this.checkpoint(agent, 'before-compaction')
      })
    })
    ctx.on('tools/pre-execute', (exec, next) => this.authorize(exec, next))
    ctx.on('tools/post-execute', (exec, result, next) => {
      this.commit(exec, result.isError, result)
      return next()
    })
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
   * Record an initial plan or a recovery amendment tied to one unresolved failure.
   * @param agent - the live agent whose task owns the plan.
   * @param steps - ordered work items in the new plan revision.
   * @param failureId - unresolved failure that justifies an amendment.
   * @returns the durable plan revision.
   * @throws When the session has no task, or an amendment is not linked to an unresolved failure.
   */
  recordPlan(agent: Agent, steps: readonly string[], failureId?: FailureId): PlanRevision {
    const session = agent.session
    const entry = this.state.entryOf(session)
    const task = entry.task
    if (task === undefined) throw new Error('agent-kernel: cannot record a plan without a task')
    if (entry.plan !== undefined && failureId === undefined) {
      throw new Error('agent-kernel: a plan amendment requires a failure reference')
    }
    if (failureId !== undefined && !entry.failures.has(failureId)) {
      throw new Error(`agent-kernel: plan failure reference "${failureId}" is not unresolved`)
    }
    // Read the plan's ordinal before the append: the fold mutates this entry.
    const firstPlan = entry.plan === undefined
    const revision = (entry.plan?.revision ?? 0) + 1
    if (revision > this.config.maxPlanRevisions) {
      throw new Error(`agent-kernel: task ${task.taskId} reached its ${String(this.config.maxPlanRevisions)}-revision plan cap; the objective or the acceptance criteria need a human decision`)
    }
    const plan: PlanRevision = {
      revision,
      steps: [...steps],
      ...failureId === undefined ? {} : { failureId },
      createdAt: Date.now(),
    }
    session.append('task/plan', {
      ...plan,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'model', {
        source: 'model', locator: String(task.taskId),
      }, plan.createdAt),
    })
    // The first plan is the other producer of `planning`: the task has stated
    // how it intends to work, and the next admitted step leaves the status.
    const current = this.state.ledgerTask(session)
    if (firstPlan && canTransition(current.status, 'planning')) {
      this.transition(session, current, 'planning', { kind: 'plan-recorded' }, 'model')
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
      provenance: input.provenance,
      trust: input.trust,
      observedAt: Date.now(),
    }
    session.append('evidence/recorded', {
      ...evidence,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'model', input.provenance, evidence.observedAt),
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
   * `executing` for the step the loop is about to run.
   * @param agent - the agent proposing the step.
   * @param messages - the messages this step claims.
   * @param turn - the turn that will own the step.
   * @param step - the step the loop proposed.
   */
  private openOrAdvance(agent: Agent, messages: readonly UserMessage[], turn: number, step: number): void {
    const session = agent.session
    const current = this.state.entryOf(session).task
    // A step admitted after the previous task ended is the next request in the
    // same conversation: it opens its own contract, exactly as the inbox claim
    // does, so a driver that dispatches only the pre-step still starts one.
    let task = current === undefined || isActive(current.status)
      ? current ?? this.intakeFromMessages(session, messages)
      : this.intakeFromMessages(session, messages, { parentTaskId: current.taskId })
    // S4's truncation detector: the turn before this one ended because the
    // model reached its output limit, so the task carries that failure. The
    // retry mechanics stay with the loop; the kernel records what happened.
    if (turn > 1 && this.truncatedTurn(session, turn - 1)) {
      this.recordFailure(session, 'output-truncated', `the model reached its output limit in turn ${String(turn - 1)}`)
    }
    // S4's step-ceiling detector: a task that reached its step ceiling must not
    // be admitted another step silently. The failure is recorded once and the
    // task pauses, which is the recovery the classifier chooses for it.
    const ceiling = task.budget.maxSteps
    if (ceiling !== undefined && this.state.entryOf(session).steps >= ceiling && task.status !== 'paused') {
      this.recordFailure(session, 'step-ceiling', `the task reached its ${String(ceiling)}-step ceiling`)
      const reached = this.state.ledgerTask(session)
      if (canTransition(reached.status, 'paused')) {
        // §17.1: index the state a resume would restart from before the
        // pause takes effect.
        this.checkpoint(agent, 'before-pause')
        this.transition(session, reached, 'paused', { kind: 'budget-exhausted', detail: `turn ${turn} step ${step}` }, 'kernel')
      }
      return
    }
    if (canTransition(task.status, 'ready')) {
      task = this.transition(session, task, 'ready', { kind: 'task-intake' }, 'kernel')
    }
    if (canTransition(task.status, 'executing')) {
      this.transition(session, task, 'executing', { kind: 'step-admitted', detail: `turn ${turn} step ${step}` }, 'kernel')
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
    const receipt = delegationReceipt({
      delegationId: brandString<DelegationId>(randomUUID()),
      childRunId: brandString<RunId>(randomUUID()),
      parentSessionId,
      ...parent === undefined ? {} : { parent },
      admitted: this.admitted,
      sandbox: this.sandboxOf(session),
      inheritedPolicyDigest: this.permissionDigest,
      // The parent's remaining allowance is the child's ceiling; a parent whose
      // task is not resolvable hands down the deployment's own budget.
      resourceLimits: parent?.budgets.remaining ?? this.config.budgets,
      at: Date.now(),
    })
    const metadata = kernelEventMetadata(receipt.childRunId, receipt.parentTaskId, 'system', {
      source: 'subagent', locator: String(parentSessionId),
    }, receipt.at)
    session.append('delegation/received', { ...receipt, metadata })
    parentSession?.append('delegation/issued', { ...receipt, metadata })
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
    return session.snapshotEvents().some(event =>
      event.type === 'turn/end' && event.data.turn === turn && event.data.reason.kind === 'max-tokens'
    )
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
    const changes = this.ctx.get('workspaceChanges')
    if (changes === undefined) return []
    const latest = session.snapshotEvents()
      .findLast(event => event.type === 'workspace/changes' && event.data.turn === turn)
    if (latest === undefined) return []
    return changes.summary(session.id, latest.seq)?.files.map(file => file.path) ?? []
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
      acceptance: this.config.acceptance,
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
    provenance: Provenance,
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
    const task: TaskContract = {
      taskId: brandString<TaskId>(randomUUID()),
      runId: delegation?.childRunId ?? brandString<RunId>(randomUUID()),
      objective: input.objective,
      constraints: input.constraints ?? [],
      acceptance: input.acceptance ?? this.config.acceptanceByClass[taskClass] ?? this.config.acceptance,
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
      metadata: kernelEventMetadata(task.runId, task.taskId, actor, provenance),
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
   * @returns the contract at the transition's resulting status and revision.
   */
  private transition(
    session: Session,
    task: TaskContract,
    to: TaskStatus,
    trigger: TransitionTrigger,
    actor: ActorKind,
    effects: readonly StateEffect[] = [],
  ): TaskContract {
    const transition: StateTransition = {
      transitionId: brandString<TransitionId>(randomUUID()),
      taskId: task.taskId,
      from: task.status,
      to,
      trigger,
      preconditions: [],
      effects,
      taskRevision: task.revision,
      revision: task.revision + 1,
      actor,
      at: Date.now(),
    }
    // Apply the same compare-and-set the fold applies, before the append, so an
    // inconsistent record can never reach the log.
    const next = applyTransition(task, transition)
    session.append('task/transitioned', {
      ...transition,
      metadata: kernelEventMetadata(task.runId, task.taskId, actor, provenanceForActor(actor, trigger.kind), transition.at),
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
    const tracked = this.progress.get(session.id)
    if (tracked === undefined || tracked.signature !== `${exec.name}:${digestOf(exec.arguments)}`) return undefined
    if (tracked.count < 2) return undefined
    if (tracked.refused !== true) {
      this.recordFailure(
        session,
        'no-progress',
        `${String(tracked.count)} identical ${exec.name} calls returned the same result`,
      )
      this.progress.set(session.id, { ...tracked, refused: true })
    }
    if (this.config.mode !== 'enforce') return undefined
    return {
      kind: 'deny',
      reason: `no progress: ${exec.name} was called ${String(tracked.count)} times with the same arguments and the same result; consolidate what you have or change approach`,
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
    const decision = this.quarantineUntrusted(proposal, composed)
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
    // The no-progress detector counts a run of calls that asked the same
    // question and got the same answer back.
    this.progress.set(session.id, nextProgress(this.progress.get(session.id), exec, receipt))
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
   * when the task declares a required acceptance criterion.
   * @param session - the agent's session.
   * @param turn - the turn that is stopping.
   */
  private async closeTurn(agent: Agent, turn: number): Promise<void> {
    const session = agent.session
    const view = this.state.view(session)
    if (view === undefined) return
    if (!isActive(view.task.status)) return
    // §17.1: index the observed state before it advances toward
    // verification, so a resume never replays past this turn's boundary.
    this.checkpoint(agent, 'turn-boundary')
    const observed = canTransition(view.task.status, 'observing')
      ? this.transition(session, view.task, 'observing', { kind: 'turn-ended', detail: `turn ${turn}` }, 'kernel')
      : view.task
    if (observed.acceptance.length === 0 && !this.verification.requiredFor(observed)) {
      // Nothing to verify: a task of this class answers without a criterion, so
      // its completion is vacuous rather than unproven, and the log records no
      // verification pair to fold.
      const detail = `a ${observed.taskClass ?? 'conversational'} task requires no acceptance criterion`
      const verifying = canTransition(observed.status, 'verifying')
        ? this.transition(session, observed, 'verifying', { kind: 'verification-requested', detail }, 'kernel')
        : observed
      if (canTransition(verifying.status, 'completed')) {
        this.transition(session, verifying, 'completed', { kind: 'verification-passed', detail }, 'kernel')
      }
      return
    }
    const changed = this.changedScopes(session, turn)
    const entry = this.state.entryOf(session)
    // Nothing changed since the last passing verification of this task, so the
    // result still stands: re-running the verifiers could only reproduce it.
    const passed = entry.passingVerification
    if (changed.length === 0 && passed !== undefined && passed.taskId === observed.taskId) {
      const detail = `no scope changed since the passing verification at revision ${String(passed.revision)}`
      const verifying = canTransition(observed.status, 'verifying')
        ? this.transition(session, observed, 'verifying', { kind: 'verification-requested', detail }, 'kernel')
        : observed
      if (canTransition(verifying.status, 'completed')) {
        this.transition(session, verifying, 'completed', { kind: 'verification-passed', detail }, 'kernel')
      }
      return
    }
    const decision = await this.verifyTask(session, observed, changed)
    const current = this.state.ledgerTask(session)
    if (decision.allowed && canTransition(current.status, 'completed')) {
      this.transition(session, current, 'completed', { kind: 'verification-passed', detail: decision.reasons.join('; ') }, 'kernel')
      return
    }
    this.recordFailure(session, 'verification-failed', decision.reasons.join('; '))
    const failed = this.state.ledgerTask(session)
    // The gate keeps the turn open through a steering message while repairs
    // remain; past the cap the decision belongs to the user.
    if (this.verificationFailures(session, failed.taskId) < this.config.maxRepairAttempts) {
      if (canTransition(failed.status, 'recovering')) {
        this.transition(session, failed, 'recovering', { kind: 'verification-failed', detail: decision.reasons.join('; ') }, 'kernel')
      }
      // §17.1: index the failing state before the repair steer changes it.
      this.checkpoint(agent, 'verification-failure')
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: REPAIR_PROMPT(decision.reasons) }],
        source: { kind: 'agent-kernel', form: 'notice', summary: 'verification failed; repair the task' },
      }))
      return
    }
    const exhausted = this.state.ledgerTask(session)
    if (canTransition(exhausted.status, 'awaiting-user')) {
      this.transition(session, exhausted, 'awaiting-user', {
        kind: 'human-required',
        detail: decision.reasons.join('; '),
      }, 'kernel')
    }
  }

  /**
   * How many verification failures this task has already recorded, so the gate
   * can tell a first repair from a loop that keeps failing the same way.
   * @param session - the session whose log is read.
   * @param taskId - the task the failures must belong to.
   * @returns the recorded count.
   */
  private verificationFailures(session: Session, taskId: TaskId): number {
    return session.snapshotEvents().filter(event =>
      event.type === 'failure/recorded'
      && event.data.kind === 'verification-failed'
      && event.data.metadata?.taskId === taskId
    ).length
  }

  /**
   * Record one verification request, collect its verdicts, and decide completion.
   * @param session - the session whose task is verified.
   * @param task - the contract the verification is requested for.
   * @param changedScopes - scopes the task changed, for `diff` verifiers.
   * @returns the completion decision.
   */
  private async verifyTask(session: Session, task: TaskContract, changedScopes: readonly string[]): Promise<CompletionDecision> {
    if (canTransition(task.status, 'verifying')) {
      this.transition(session, task, 'verifying', { kind: 'verification-requested' }, 'kernel')
    }
    const current = this.state.ledgerTask(session)
    const request = this.verification.request(current, changedScopes)
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
   * Record one classified failure and the recovery chosen for it.
   * @param session - the session that observed it.
   * @param kind - its classification.
   * @param detail - human- and model-readable detail.
   * @returns the recorded failure.
   */
  private recordFailure(session: Session, kind: FailureKind, detail: string): FailureRecord {
    const task = this.state.entryOf(session).task
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
    const decision = this.recovery.classify({ failure, attempts: 0, maxAttemptsPerAction: this.config.maxAttemptsPerAction })
    session.append('recovery/decided', {
      ...decision,
      metadata: kernelEventMetadata(task.runId, task.taskId, 'kernel', { source: 'kernel' }, decision.at),
    })
    return failure
  }
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

const PROVENANCE_SOURCE_BY_ACTOR = {
  user: 'user',
  model: 'model',
  kernel: 'kernel',
  tool: 'tool',
  system: 'kernel',
} as const satisfies Readonly<Record<ActorKind, Provenance['source']>>

/**
 * Build the versioned audit fields attached to a new kernel event.
 * @param runId - the execution run this record belongs to.
 * @param taskId - the task this record belongs to, when one exists.
 * @param actor - the actor that caused the record.
 * @param provenance - the source and locator of the recorded fact.
 * @param timestamp - the time the record was committed.
 * @returns the event's audit metadata.
 */
function kernelEventMetadata(
  runId: RunId,
  taskId: TaskId | undefined,
  actor: ActorKind,
  provenance: Provenance,
  timestamp = Date.now(),
): KernelEventMetadata {
  return {
    version: 1,
    runId,
    ...taskId === undefined ? {} : { taskId },
    actor,
    timestamp,
    provenance,
  }
}

/**
 * Derive an event's provenance source from its actor.
 * @param actor - the actor that caused the event.
 * @param locator - the state-transition trigger.
 * @returns the provenance record.
 */
function provenanceForActor(actor: ActorKind, locator: string): Provenance {
  return { source: PROVENANCE_SOURCE_BY_ACTOR[actor], locator }
}
/**
 * Hash one parsed tool-argument value without retaining its text.
 * @param arguments_ - the lossless JSON arguments materialized by the tool registry.
 * @returns the SHA-256 digest of their JSON serialization.
 * @throws When the value cannot be serialized as JSON.
 */
function digestArguments(arguments_: ActionProposal['arguments']): string {
  const serialized = JSON.stringify(arguments_)
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
function proposalOf(exec: ToolExecution, agent: Agent, task: TaskContract, argumentsDigest: string, trust: TrustLabel | undefined): ActionProposal {
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
