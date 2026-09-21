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

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
// Type-only: activates the `ctx.sandboxPolicy` Context declaration.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { ToolCapabilityRegistry } from './capabilities.ts'
import { delegationReceipt, policyDigest } from './delegation.ts'
import { actionIdOf, KernelLedger, type LedgerEntry } from './ledger.ts'
import { admittedCapabilities, compilePolicy, composeAuthorization, PermissionPolicyEngine, POLICY_ACTIONS, POLICY_EFFECTS } from './policy.ts'
import { DefaultRecoveryEngine } from './recovery.ts'
import { applyTransition, canTransition, isActive } from './state-machine.ts'
import type {
  AcceptanceCriterion,
  ActionProposal,
  ActionReceipt,
  ActorKind,
  AuthorizationDecision,
  Capability,
  CapabilityRegistry,
  Checkpoint,
  CheckpointId,
  CheckpointReason,
  CompletionDecision,
  DelegationId,
  FailureId,
  FailureKind,
  FailureRecord,
  GovernanceReceipt,
  KernelAttachment,
  KernelView,
  PolicyContext,
  PolicyDocument,
  PolicyEngine,
  ResourceBudget,
  RunId,
  StateEffect,
  StateTransition,
  TaskContract,
  TaskId,
  TaskStatus,
  TransitionId,
  TransitionTrigger,
  VerificationGate,
} from './types.ts'
import { CriterionVerifierRegistry, DefaultVerificationGate } from './verification.ts'

export type * from './types.ts'

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
  /** The permission document every action is evaluated against. */
  policy?: PolicyDocument
  /** Whether a task with no acceptance criterion may be reported complete. */
  requireAcceptanceCriteria?: boolean
  /** Whether a task whose only passing evidence is human-reported may complete. */
  allowHumanOnlyCompletion?: boolean
  /** Retry cap per action before the recovery engine reports no attempts remaining. */
  maxAttemptsPerAction?: number
  /** Whether a retry must be preceded by a checkpoint. */
  checkpointBeforeRetry?: boolean
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
  }),
  policy: z.object({
    defaults: z.object({ effect: z.union(POLICY_EFFECTS) }),
    rules: z.array(z.object({
      action: z.union(POLICY_ACTIONS),
      resource: z.string(),
      effect: z.union(POLICY_EFFECTS),
    })),
  }),
  acceptance: z.array(z.object({
    id: z.string(),
    description: z.string(),
    verifier: z.union(['test', 'build', 'diff', 'assertion', 'human', 'research'] as const),
    required: z.boolean(),
  })),
  requireAcceptanceCriteria: z.boolean().default(false),
  allowHumanOnlyCompletion: z.boolean().default(false),
  maxAttemptsPerAction: z.number().default(2),
  checkpointBeforeRetry: z.boolean().default(true),
})

/** The permission document a deployment that configures none evaluates under: ask before anything. */
export const DEFAULT_POLICY_DOCUMENT: PolicyDocument = { defaults: { effect: 'ask' }, rules: [] }

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
  /** Retry cap per action. */
  readonly maxAttemptsPerAction: number
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
 * waterfalls in its constructor, so unloading the plugin unloads every
 * listener, declaration, and attachment with it.
 */
export class AgentKernelService extends Service {
  /** The permission-rule evaluator compiled from `Config.policy`. */
  readonly policy: PolicyEngine
  /** The registry of tool capability declarations. */
  readonly capabilities: CapabilityRegistry
  /** The completion gate. */
  readonly verification: VerificationGate
  /** The local criterion verifiers the gate collects results from. */
  readonly verifiers: CriterionVerifierRegistry
  /** The failure classifier and recovery chooser. */
  readonly recovery: DefaultRecoveryEngine
  /** The read model and budget observer over session logs. */
  readonly state: KernelLedger
  private readonly config: ResolvedConfig
  /** Capabilities the deployment's document admits at all, handed to a root parent's children. */
  private readonly admitted: readonly Capability[]
  /** Digest of the permission document, recorded on every delegation receipt. */
  private readonly permissionDigest: string
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
      maxAttemptsPerAction: config.maxAttemptsPerAction ?? 2,
    }
    const document = config.policy ?? DEFAULT_POLICY_DOCUMENT
    this.policy = new PermissionPolicyEngine(document)
    this.admitted = admittedCapabilities(compilePolicy(document))
    this.permissionDigest = policyDigest(document, this.config.policyProfile)
    this.capabilities = new ToolCapabilityRegistry()
    this.verification = new DefaultVerificationGate({
      requireAcceptanceCriteria: config.requireAcceptanceCriteria ?? false,
      allowHumanOnlyCompletion: config.allowHumanOnlyCompletion ?? false,
    })
    this.verifiers = new CriterionVerifierRegistry()
    this.recovery = new DefaultRecoveryEngine({ checkpointBeforeRetry: config.checkpointBeforeRetry ?? true })
    this.state = new KernelLedger()

    ctx.on('agent/created', (payload) => { this.delegate(payload.agent) })
    ctx.on('agent/pre-step', (payload, next) => {
      this.openOrAdvance(payload.agent.session, payload.messages, payload.turn, payload.step)
      return next()
    })
    ctx.on('agent/turn-stopping', payload => this.closeTurn(payload.agent.session, payload.turn))
    ctx.on('tools/pre-execute', (exec, next) => this.authorize(exec, next))
    ctx.on('tools/post-execute', (exec, result, next) => {
      this.commit(exec, result.isError)
      return next()
    })
    ctx.effect(() => () => {
      for (const attachment of [...this.attachments]) void attachment.dispose()
    }, 'agent-kernel.attachments')
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
    session.append('checkpoint/created', checkpoint)
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
   * @param session - the agent's session.
   * @param messages - the messages this step claims.
   * @param turn - the turn that will own the step.
   * @param step - the step the loop proposed.
   */
  private openOrAdvance(session: Session, messages: readonly UserMessage[], turn: number, step: number): void {
    const task = this.state.entryOf(session).task ?? this.intake(session, messages)
    if (canTransition(task.status, 'executing')) {
      this.transition(session, task, 'executing', { kind: 'step-admitted', detail: `turn ${turn} step ${step}` }, 'kernel')
    }
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
    session.append('delegation/received', receipt)
    parentSession?.append('delegation/issued', receipt)
  }

  /**
   * Open a task contract from the messages that started the work.
   * @param session - the session the contract belongs to.
   * @param messages - the claimed messages the objective is read from.
   * @returns the contract after its `ready` transition.
   */
  private intake(session: Session, messages: readonly UserMessage[]): TaskContract {
    const cwd = session.header.cwd
    const delegation = this.state.entryOf(session).delegation
    const created: TaskContract = {
      taskId: brandString<TaskId>(randomUUID()),
      // A delegated child keeps the run identity its receipt was issued under,
      // so the receipt and the contract name the same run.
      runId: delegation?.childRunId ?? brandString<RunId>(randomUUID()),
      objective: humanObjective(messages),
      constraints: [],
      acceptance: this.config.acceptance,
      ...cwd === undefined ? {} : { workspace: { root: cwd } },
      ...delegation?.parentTaskId === undefined ? {} : { parentTaskId: delegation.parentTaskId },
      agentProfile: this.config.agentProfile,
      policyProfile: this.config.policyProfile,
      budget: delegation?.resourceLimits ?? this.config.budgets,
      status: 'intake',
      revision: 1,
    }
    session.append('task/created', created)
    return this.transition(session, created, 'ready', { kind: 'task-intake' }, 'kernel')
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
    session.append('task/transitioned', transition)
    return next
  }

  /**
   * Propose, evaluate, and compose authorization for one tool call.
   * @param exec - the pending call.
   * @param next - the waterfall continuation that allows the call.
   * @returns the decision the tool pipeline acts on.
   */
  private async authorize(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const agent = exec.agent
    if (agent === undefined) return next()
    const session = agent.session
    const entry = this.state.entryOf(session)
    const task = entry.task
    if (task === undefined) return next()
    const proposal = proposalOf(exec, agent, task)
    session.append('action/proposed', proposal)
    const declared = this.capabilities.resolve(exec.name, exec.arguments)
    const context: PolicyContext = {
      action: proposal,
      capabilities: declared ?? [],
      undeclared: declared === undefined,
      sandbox: this.sandboxOf(session),
      ...entry.delegation === undefined ? {} : { parentGrant: entry.delegation },
    }
    const decision = this.policy.evaluate(context)
    session.append('policy/decision', { proposal, decision })
    const enforced = this.config.mode === 'enforce'
    const authorization = composeAuthorization(decision, proposal, context, enforced)
    // `ask` is a conditional authorization whose outcome the governance receipt
    // records; only a composed `deny` refuses the action outright.
    session.append(
      authorization.effect === 'deny' ? 'action/denied' : 'action/authorized',
      { proposal, decision: authorization },
    )
    if (authorization.capabilityGrants.length > 0) {
      session.append('capability/grant', { actionId: proposal.actionId, capabilities: authorization.capabilityGrants })
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
  private commit(exec: ToolExecution, isError: boolean): void {
    const agent = exec.agent
    if (agent === undefined) return
    const session = agent.session
    const actionId = actionIdOf(exec.callId)
    const entry = this.state.entryOf(session)
    const authorization = entry.authorizations.get(actionId)
    if (authorization === undefined) return
    const receipt: ActionReceipt = {
      actionId,
      toolName: exec.name,
      decisionId: authorization.decisionId,
      outcome: outcomeOf(authorization, entry.approvals.get(actionId), isError),
      governance: governanceOf(actionId, authorization, entry),
      committedAt: Date.now(),
    }
    session.append('action/committed', receipt)
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
  private async closeTurn(session: Session, turn: number): Promise<void> {
    const view = this.state.view(session)
    if (view === undefined) return
    if (!isActive(view.task.status)) return
    const observed = canTransition(view.task.status, 'observing')
      ? this.transition(session, view.task, 'observing', { kind: 'turn-ended', detail: `turn ${turn}` }, 'kernel')
      : view.task
    if (!observed.acceptance.some(criterion => criterion.required)) return
    const decision = await this.verifyTask(session, observed, [])
    const current = this.state.ledgerTask(session)
    if (decision.allowed && canTransition(current.status, 'completed')) {
      this.transition(session, current, 'completed', { kind: 'verification-passed', detail: decision.reasons.join('; ') }, 'kernel')
      return
    }
    this.recordFailure(session, 'verification-failed', decision.reasons.join('; '))
    const failed = this.state.ledgerTask(session)
    if (canTransition(failed.status, 'recovering')) {
      this.transition(session, failed, 'recovering', { kind: 'verification-failed', detail: decision.reasons.join('; ') }, 'kernel')
    }
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
    session.append('verification/requested', request)
    const { results, commands } = await this.verifiers.collect(request)
    const result = this.verification.evaluate(request, results, commands)
    session.append('verification/result', result)
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
    const failure: FailureRecord = {
      failureId: brandString<FailureId>(randomUUID()),
      kind,
      detail,
      at: Date.now(),
    }
    session.append('failure/recorded', failure)
    const decision = this.recovery.classify({ failure, attempts: 0, maxAttemptsPerAction: this.config.maxAttemptsPerAction })
    session.append('recovery/decided', decision)
    return failure
  }
}

/**
 * Build the proposal record for one call.
 * @param exec - the pending call.
 * @param agent - the agent on whose behalf it runs.
 * @param task - the task contract the proposal is made against.
 * @returns the proposal.
 */
function proposalOf(exec: ToolExecution, agent: Agent, task: TaskContract): ActionProposal {
  return {
    actionId: actionIdOf(exec.callId),
    agentId: agent.id,
    callId: exec.callId,
    toolName: exec.name,
    // The registry materializes and freezes arguments as lossless JSON before
    // the pre-execute waterfall runs, so this is the value's own type.
    arguments: exec.arguments as ActionProposal['arguments'],
    source: 'model',
    taskRevision: task.revision,
    trust: 'unknown',
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
