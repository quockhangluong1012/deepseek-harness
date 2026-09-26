/**
 * The kernel ledger: a cursor-based fold of one session's kernel events into
 * the task view the service reads, plus the budget observation derived from
 * the session's own step and tool-call events and the background budget
 * owner's spend beside it.
 *
 * The session log is the only source of truth. The fold keeps a cursor per
 * session and folds each event once, the way `ApprovalService` folds
 * `approval/policy`; a shortened log (repair or truncation) resets the cursor
 * and refolds from the start, so no cached value can outlive the events that
 * produced it.
 *
 * @module @deepseek-ai/dsh-agent-kernel/ledger
 */

import { randomUUID } from 'node:crypto'
import { SessionSeq, type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { deriveSessionTokenSpend } from '@deepseek-ai/dsh-token-meter'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type {
  ActionId,
  ActionProposal,
  AuthorizationDecision,
  BudgetGovernor,
  BackgroundSpend,
  PolicyDecision,
  BudgetSnapshot,
  BudgetReservation,
  BudgetReservationId,
  Checkpoint,
  TaskClaim,
  TaskClaimId,
  DelegationReceipt,
  Evidence,
  EvidenceId,
  FailureDiagnosis,
  FailureId,
  FailureRef,
  TaskHypothesis,
  TaskHypothesisId,
  KernelStateReader,
  KernelView,
  PlanRevision,
  RecordedTaskContract,
  RecoveryDecision,
  ResourceBudget,
  RunId,
  TaskContract,
  TaskId,
  VerificationResult,
} from './types.ts'
import { applyTransition } from './state-machine.ts'

/**
 * Stable action identity for one tool call. The kernel keys its whole ledger by
 * this value, so a proposal, its decisions, and its receipt all correlate
 * without a second identifier.
 * @param callId - the registry-assigned call identity.
 * @returns the same value carrying the action brand.
 */
export function actionIdOf(callId: string): ActionId {
  return callId as ActionId
}

/**
 * Everything one session's kernel events fold into. The kernel service holds
 * this object to propose actions and commit receipts; everything a reader
 * sees is projected from it.
 */
export interface LedgerEntry {
  /** Session sequence already folded. */
  floor: number
  /** Task contract at the folded revision, or undefined before `task/created`. */
  task: TaskContract | undefined
  /** Unix epoch milliseconds of the `task/created` event. */
  createdAt: number
  /** `step/start` events folded. */
  steps: number
  /** `tool/call` events folded. */
  toolCalls: number
  /** Actions proposed and not yet committed. */
  openActions: Set<ActionId>
  /** The proposal of every action seen this run, so a commit can name it. */
  proposals: Map<ActionId, ActionProposal>
  /** Attempts spent per action id, counted as proposals under that id. */
  attempts: Map<ActionId, number>
  /** The composed decision recorded for every action this run. */
  authorizations: Map<ActionId, AuthorizationDecision>
  /** The permission rules' decision recorded for every action this run. */
  policies: Map<ActionId, PolicyDecision>
  /** Approval request identity to the action whose tool call asked. */
  approvalRequests: Map<ApprovalRequestId, ActionId>
  /** Human outcome observed per action. */
  approvals: Map<ActionId, ApprovalOutcome>
  /** Failures with no accepted resolution. */
  failures: Map<FailureId, FailureRef>
  /** The action each action-owned failure belongs to, so a success can resolve it. */
  failureAction: Map<FailureId, ActionId>
  /** The task and revision of the last verification that passed, when one did. */
  passingVerification: { readonly taskId: TaskId; readonly revision: number } | undefined
  /**
   * The verification result folded before {@link latestVerification}, when one
   * was: the verification a repair answered. The §8.5 regression leg compares
   * the two.
   */
  priorVerification: VerificationResult | undefined
  /**
   * The most recent verification result folded for this session, whatever its
   * status.
   */
  latestVerification: VerificationResult | undefined
  /** Latest plan revision. */
  plan: PlanRevision | undefined
  /** `goal/change` events folded, so a step's goal movement is measurable. */
  goalChanges: number
  /** Recovery decision recorded per failure, when the engine decided one. */
  recoveries: Map<FailureId, RecoveryDecision>
  /** Observations recorded for this task, in log order. */
  evidence: Map<EvidenceId, Evidence>
  /** Claims asserted by this task. */
  claims: Map<TaskClaimId, TaskClaim>
  /** Questions this task is testing. */
  hypotheses: Map<TaskHypothesisId, TaskHypothesis>
  /** Diagnoses recorded for this task's failures, in log order. */
  diagnoses: FailureDiagnosis[]
  /** Latest checkpoint. */
  checkpoint: Checkpoint | undefined
  /** The delegation this session's agent acts under, when it is a child. */
  delegation: DelegationReceipt | undefined
}

/**
 * Everything one session's kernel events fold into, as a durable record: the
 * replayable half of a kernel view, rebuilt from a Session log alone.
 *
 * The record carries no live handle and no wall-clock reading, so any reader
 * holding the log — a crash-recovery scan, a review command, a test — sees the
 * same task state the live kernel folded, without the kernel or the Agent.
 */
export interface KernelRecord {
  /** Task contract at the folded revision. */
  readonly task: TaskContract
  /** Model steps counted from `step/start`. */
  readonly steps: number
  /** Tool calls counted from `tool/call`. */
  readonly toolCalls: number
  /** Milliseconds between `task/created` and the last folded event. */
  readonly wallMs: number
  /** Evidence recorded for the task, in log order. */
  readonly evidence: readonly Evidence[]
  /** Claims recorded for the task, newest state per claim. */
  readonly claims: readonly TaskClaim[]
  /** Hypotheses recorded for the task, newest state per hypothesis. */
  readonly hypotheses: readonly TaskHypothesis[]
  /** Diagnoses recorded for the task's failures, in log order. */
  readonly diagnoses: readonly FailureDiagnosis[]
  /** Actions proposed and not yet committed. */
  readonly openActionIds: readonly ActionId[]
  /** Failures with no accepted resolution. */
  readonly unresolvedFailures: readonly FailureRef[]
  /** Proposals seen this run, keyed by action id. */
  readonly proposals: ReadonlyMap<ActionId, ActionProposal>
  /** Attempts spent per action id. */
  readonly attempts: ReadonlyMap<ActionId, number>
  /** The composed decision recorded for each action. */
  readonly authorizations: ReadonlyMap<ActionId, AuthorizationDecision>
  /** Human approval outcome observed per action. */
  readonly approvals: ReadonlyMap<ActionId, ApprovalOutcome>
  /** The task's latest plan revision, when one was recorded. */
  readonly plan?: PlanRevision
  /** The task's latest checkpoint, when one was recorded. */
  readonly checkpoint?: Checkpoint
  /** The delegation receipt this run received, when it is a child run. */
  readonly delegation?: DelegationReceipt
}

/**
 * Fold a persisted kernel event sequence into the record a reader sees. This
 * is the same fold the live kernel applies to a session; it needs no live
 * Session, so a reader can rebuild task state from storage.
 * @param events - the session's events, in log order.
 * @returns the task record, or undefined when the log holds no `task/created`.
 */
export function readKernelRecord(events: Iterable<SessionEvent>): KernelRecord | undefined {
  const entry = emptyEntry()
  let lastTime = 0
  for (const event of events) {
    fold(entry, event)
    lastTime = Math.max(lastTime, event.time)
  }
  const task = entry.task
  if (task === undefined) return undefined
  return {
    task,
    steps: entry.steps,
    toolCalls: entry.toolCalls,
    wallMs: entry.createdAt === 0 ? 0 : Math.max(0, lastTime - entry.createdAt),
    evidence: [...entry.evidence.values()],
    claims: [...entry.claims.values()],
    hypotheses: [...entry.hypotheses.values()],
    diagnoses: entry.diagnoses,
    openActionIds: [...entry.openActions],
    unresolvedFailures: [...entry.failures.values()],
    proposals: entry.proposals,
    attempts: entry.attempts,
    authorizations: entry.authorizations,
    approvals: entry.approvals,
    ...entry.plan === undefined ? {} : { plan: entry.plan },
    ...entry.checkpoint === undefined ? {} : { checkpoint: entry.checkpoint },
    ...entry.delegation === undefined ? {} : { delegation: entry.delegation },
  }
}

/** One session's ledger entry in its initial state. */
function emptyEntry(): LedgerEntry {
  return {
    floor: 0,
    task: undefined,
    createdAt: 0,
    steps: 0,
    toolCalls: 0,
    openActions: new Set(),
    proposals: new Map(),
    attempts: new Map(),
    authorizations: new Map(),
    policies: new Map(),
    approvalRequests: new Map(),
    approvals: new Map(),
    failures: new Map(),
    failureAction: new Map(),
    passingVerification: undefined,
    priorVerification: undefined,
    latestVerification: undefined,
    plan: undefined,
    goalChanges: 0,
    recoveries: new Map(),
    evidence: new Map(),
    claims: new Map(),
    hypotheses: new Map(),
    diagnoses: [],
    checkpoint: undefined,
    delegation: undefined,
  }
}

/**
 * The ledger's public surface: the read model the kernel service answers from,
 * the budget observation it records on checkpoints, and the reservations it
 * holds against a session's remaining allowance. The observation reads both
 * budget owners and enforces neither.
 */
export class KernelLedger implements KernelStateReader, BudgetGovernor {
  /** Per-session fold cursor and folded state. */
  private readonly entries = new WeakMap<Session, LedgerEntry>()
  /**
   * Holds placed on each session's allowance, by reservation id. Holds belong
   * to the work in flight, so they are process state: a restart has no child
   * running to hold budget for, and the durable record of what a session
   * promised is the delegation receipt it wrote.
   */
  private readonly reservations = new Map<BudgetReservationId, BudgetReservation>()
  /** Spend settled work reported against each session, by session id. */
  private readonly debited = new Map<SessionId, ResourceBudget>()

  /**
   * @param background - reads what background work has spent, so the
   * observation carries the background budget owner's numbers beside the
   * session's own. Omitted when no background budget owner is mounted.
   */
  constructor(private readonly background: (() => BackgroundSpend | undefined) | undefined = undefined) {}

  /**
   * Fold every event appended since the last call and return the current view.
   * @param session - the session whose log is folded.
   * @returns the task view, or undefined when the log holds no `task/created`.
   */
  view(session: Session): KernelView | undefined {
    const entry = this.entryOf(session)
    const task = entry.task
    if (task === undefined) return undefined
    return {
      task,
      sessionId: session.id,
      budgets: this.measure(task, session),
      openActionIds: [...entry.openActions],
      unresolvedFailures: [...entry.failures.values()],
      evidence: [...entry.evidence.values()],
      claims: [...entry.claims.values()],
      hypotheses: [...entry.hypotheses.values()],
      diagnoses: entry.diagnoses,
      ...entry.plan === undefined ? {} : { plan: entry.plan },
      ...entry.checkpoint === undefined ? {} : { checkpoint: entry.checkpoint },
      ...entry.delegation === undefined ? {} : { delegation: entry.delegation },
    }
  }

  /**
   * The folded entry for one session, advancing the cursor first. Callers that
   * mutate kernel state use this rather than folding a second time.
   * @param session - the session whose log is folded.
   * @returns the session's live ledger entry.
   */
  entryOf(session: Session): LedgerEntry {
    return this.advance(session)
  }

  /**
   * The task contract of a session known to have one.
   * @param session - the session whose log is folded.
   * @returns the session's current task contract.
   * @throws When the session holds no `task/created` event.
   */
  ledgerTask(session: Session): TaskContract {
    const task = this.entryOf(session).task
    if (task === undefined) throw new Error('agent-kernel: no task contract for this session')
    return task
  }

  /**
   * Measure one task against its configured ceilings. The background budget
   * owner's spend is reported beside the session's own use and debits nothing
   * here: the remaining allowance is the session's alone, and `guard/budgets`
   * is what enforces it.
   * @param task - the task whose configured ceilings apply.
   * @param session - the session whose events were counted.
   * @returns the observation and the remaining allowance per configured ceiling.
   */
  measure(task: TaskContract, session: Session): BudgetSnapshot {
    const entry = this.entryOf(session)
    const wallMs = entry.createdAt === 0 ? 0 : Math.max(0, Date.now() - entry.createdAt)
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const tokens = deriveSessionTokenSpend(session.snapshotEvents())
    const background = this.background?.()
    return {
      steps: entry.steps,
      toolCalls: entry.toolCalls,
      tokens,
      wallMs,
      remaining: remainingAllowance(task.budget, entry.steps, entry.toolCalls, wallMs, tokens),
      ...background === undefined ? {} : { background },
    }
  }

  /**
   * What one session can still promise: its measured remaining allowance less
   * the holds its in-flight work placed and the spend its settled children
   * reported, per axis. An axis the session does not bound is absent.
   * @param session - the session whose allowance is read.
   * @returns the still-uncommitted allowance, per bounded axis.
   */
  available(session: Session): ResourceBudget {
    const task = this.entryOf(session).task
    if (task === undefined) return {}
    const remaining = this.measure(task, session).remaining
    const held = this.heldBy(session.id)
    const debited = this.debited.get(session.id)
    const allowance: Partial<Record<keyof ResourceBudget, number>> = { ...remaining }
    for (const axis of RESERVED_AXES) {
      const left = remaining[axis]
      if (left === undefined) continue
      allowance[axis] = Math.max(0, left - (held[axis] ?? 0) - (debited?.[axis] ?? 0))
    }
    return allowance
  }

  /**
   * Hold part of one session's allowance for work that is about to run. The
   * hold is capped at what the session has available, so two hold requests made
   * before either settles cannot together exceed what the session had.
   * @param session - the session whose allowance is held.
   * @param amount - the ceilings the work may spend.
   * @param runId - the run the hold is placed for, when the caller knows it.
   * @returns the hold, carrying the ceilings it placed.
   */
  reserve(session: Session, amount: ResourceBudget, runId?: RunId): BudgetReservation {
    const available = this.available(session)
    const held: Partial<Record<keyof ResourceBudget, number>> = {}
    for (const axis of RESERVED_AXES) {
      const left = available[axis]
      const requested = amount[axis]
      if (left === undefined || requested === undefined) continue
      held[axis] = Math.min(Math.max(0, requested), left)
    }
    const reservation: BudgetReservation = {
      reservationId: brandString<BudgetReservationId>(randomUUID()),
      sessionId: session.id,
      ...runId === undefined ? {} : { runId },
      amount: held,
      at: Date.now(),
    }
    this.reservations.set(reservation.reservationId, reservation)
    return reservation
  }

  /**
   * Settle a hold with what the work it covered reported spending. The hold
   * ends and the spend is debited from the session's available allowance; the
   * session's measured remaining allowance is unchanged, because the work's
   * spend is measured in its own session.
   * @param reservationId - the hold being settled.
   * @param actual - what the work spent, per axis, when the caller measured it.
   */
  commit(reservationId: BudgetReservationId, actual?: ResourceBudget): void {
    const reservation = this.reservations.get(reservationId)
    if (reservation === undefined) return
    this.reservations.delete(reservationId)
    if (actual === undefined) return
    const debited: Partial<Record<keyof ResourceBudget, number>> = { ...this.debited.get(reservation.sessionId) }
    for (const axis of RESERVED_AXES) {
      const spent = actual[axis]
      if (spent === undefined) continue
      debited[axis] = (debited[axis] ?? 0) + Math.max(0, spent)
    }
    this.debited.set(reservation.sessionId, debited)
  }

  /**
   * Release a hold for work that never ran.
   * @param reservationId - the hold being released.
   */
  release(reservationId: BudgetReservationId): void {
    this.reservations.delete(reservationId)
  }

  /**
   * Every hold one session currently carries, summed per axis.
   * @param sessionId - the session whose holds are summed.
   * @returns the held ceilings; empty when the session carries none.
   */
  private heldBy(sessionId: SessionId): ResourceBudget {
    const held: Partial<Record<keyof ResourceBudget, number>> = {}
    for (const reservation of this.reservations.values()) {
      if (reservation.sessionId !== sessionId) continue
      for (const axis of RESERVED_AXES) {
        const value = reservation.amount[axis]
        if (value === undefined) continue
        held[axis] = (held[axis] ?? 0) + value
      }
    }
    return held
  }

  /**
   * Fold every event appended since the last call.
   * @param session - the session to advance.
   * @returns the session's ledger entry after folding.
   */
  private advance(session: Session): LedgerEntry {
    const cached = this.entries.get(session)
    // A shortened log invalidates the cursor: a repair or truncation may have
    // rewritten events the cursor already passed.
    const entry = cached !== undefined && cached.floor <= session.seq ? cached : emptyEntry()
    for (let seq = entry.floor; seq < session.seq; seq += 1) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(SessionSeq(seq))
      /* v8 ignore next -- `eventAt` is total for every seq below `session.seq`; the guard only narrows its declared optional return. */
      if (event === undefined) continue
      fold(entry, event)
    }
    entry.floor = session.seq
    this.entries.set(session, entry)
    return entry
  }
}

/**
 * Apply one session event to a ledger entry. Every event type this package
 * does not own is ignored, so the fold is independent of unrelated plugins.
 * @param entry - the entry to mutate.
 * @param event - the event to fold.
 */
function fold(entry: LedgerEntry, event: SessionEvent): void {
  switch (event.type) {
    case 'task/created': {
      const { metadata: _metadata, ...recorded } = event.data
      void _metadata
      const contract: RecordedTaskContract = recorded
      entry.task = {
        ...contract,
        dependencies: contract.dependencies ?? [],
        evidence: contract.evidence ?? [],
      }
      entry.createdAt = event.time
      return
    }
    case 'task/transitioned':
      // A transition whose task is unknown belongs to a prefix this fold never
      // saw; without the create event there is no contract to apply it to.
      if (entry.task !== undefined) entry.task = applyTransition(entry.task, event.data)
      return
    case 'verification/result': {
      const { metadata: _verificationMetadata, ...verification } = event.data
      void _verificationMetadata
      entry.priorVerification = entry.latestVerification
      entry.latestVerification = verification
      if (event.data.status !== 'pass') return
      const verified = entry.task
      if (verified !== undefined) entry.passingVerification = { taskId: verified.taskId, revision: event.data.revision }
      // A later pass is what resolves an earlier verification failure: the
      // criterion that failed now holds, so it no longer blocks completion. The
      // same pass resolves plan drift, because a task whose outcome a verifier
      // confirmed is not still unaccounted for by the path it took.
      resolveFailuresOfKind(entry, 'verification-failed')
      resolveFailuresOfKind(entry, 'verification-regressed')
      resolveFailuresOfKind(entry, 'plan-drift')
      return
    }
    case 'task/plan': {
      const { metadata: _metadata, ...plan } = event.data
      void _metadata
      entry.plan = plan
      // A new revision answers whatever the task was drifting from.
      resolveFailuresOfKind(entry, 'plan-drift')
      return
    }
    case 'evidence/recorded': {
      const { metadata: _metadata, ...evidence } = event.data
      void _metadata
      entry.evidence.set(evidence.evidenceId, evidence)
      // The contract carries the same refs, so a reader of one task sees the
      // observations recorded for it without folding the evidence records.
      const observed = entry.task
      if (observed !== undefined) {
        entry.task = { ...observed, evidence: [...observed.evidence, evidence.evidenceId] }
      }
      return
    }
    case 'claim/updated': {
      const { metadata: _metadata, ...claim } = event.data
      void _metadata
      entry.claims.set(claim.claimId, claim)
      return
    }
    case 'hypothesis/updated': {
      const { metadata: _metadata, ...hypothesis } = event.data
      void _metadata
      entry.hypotheses.set(hypothesis.hypothesisId, hypothesis)
      return
    }
    case 'action/decided': {
      const actionId = event.data.proposal.actionId
      entry.openActions.add(actionId)
      entry.proposals.set(actionId, event.data.proposal)
      entry.attempts.set(actionId, (entry.attempts.get(actionId) ?? 0) + 1)
      entry.authorizations.set(actionId, event.data.decision)
      entry.policies.set(actionId, event.data.policy)
      return
    }
    case 'action/committed':
      entry.openActions.delete(event.data.actionId)
      // A successful action resolves the failures recorded against it: the
      // retry worked, so those failures no longer block completion.
      if (event.data.outcome === 'succeeded') resolveActionFailures(entry, event.data.actionId)
      return
    case 'approval/asked':
      if (event.data.callId !== undefined) {
        entry.approvalRequests.set(event.data.id, actionIdOf(event.data.callId))
      }
      return
    case 'approval/decided': {
      const action = entry.approvalRequests.get(event.data.id)
      if (action !== undefined) entry.approvals.set(action, event.data.outcome)
      return
    }
    case 'failure/recorded':
      entry.failures.set(event.data.failureId, { failureId: event.data.failureId, kind: event.data.kind })
      if (event.data.actionId !== undefined) entry.failureAction.set(event.data.failureId, event.data.actionId)
      return
    case 'failure/diagnosed': {
      const { metadata: _metadata, ...diagnosis } = event.data
      void _metadata
      entry.diagnoses.push(diagnosis)
      return
    }
    case 'recovery/decided': {
      const { metadata: _metadata, ...decision } = event.data
      void _metadata
      entry.recoveries.set(decision.failureId, decision)
      return
    }
    case 'governor/decided':
      // A step that moved something answers the loop and liveness failures
      // recorded against the step that did not: the run replied to the guard by
      // changing what it was doing, so neither failure still blocks completion.
      if (event.data.progressScore > 0) {
        resolveFailuresOfKind(entry, 'no-progress')
        resolveFailuresOfKind(entry, 'stalled')
      }
      return
    case 'goal/change':
      // The goal is another plane's event; the kernel only counts its
      // movement, which is one axis of a step's progress.
      entry.goalChanges += 1
      return
    case 'checkpoint/created': {
      const { metadata: _metadata, ...checkpoint } = event.data
      void _metadata
      entry.checkpoint = checkpoint
      return
    }
    case 'delegation/received': {
      const { metadata: _metadata, ...delegation } = event.data
      void _metadata
      entry.delegation = delegation
      return
    }
    case 'step/start':
      entry.steps += 1
      return
    case 'tool/call':
      entry.toolCalls += 1
      return
    case 'tool/result':
      // A call that produced a model-facing result whether or not it failed has
      // been parsed and dispatched, so an earlier malformed argument set no
      // longer says anything about the tool: the model supplied arguments a
      // schema accepted.
      resolveFailuresOfKind(entry, 'tool-args-malformed')
      return
    case 'turn/end':
      // A truncated turn is retried with a larger output limit; a turn that
      // ended for any other reason produced its output, so the retry answered
      // the failure and it no longer blocks completion.
      if (event.data.reason.kind !== 'max-tokens') resolveFailuresOfKind(entry, 'output-truncated')
      return
    default:
      return
  }
}

/**
 * Drop one action's failures from the unresolved set.
 * @param entry - the entry to mutate.
 * @param actionId - the action whose failures are resolved.
 */
function resolveActionFailures(entry: LedgerEntry, actionId: ActionId): void {
  for (const [failureId, owner] of entry.failureAction) {
    if (owner !== actionId) continue
    entry.failures.delete(failureId)
    entry.failureAction.delete(failureId)
  }
}

/**
 * Drop every unresolved failure of one kind.
 * @param entry - the entry to mutate.
 * @param kind - the failure kind that no longer blocks.
 */
function resolveFailuresOfKind(entry: LedgerEntry, kind: FailureRef['kind']): void {
  for (const [failureId, failure] of entry.failures) {
    if (failure.kind !== kind) continue
    entry.failures.delete(failureId)
    entry.failureAction.delete(failureId)
  }
}

/**
 * Ceilings a reservation holds: the axes a child's own spend consumes one for
 * one, so promising them to two children at once would spend the parent's
 * allowance twice. `maxCostUsd` is priced by the deployment's guard rather than
 * measured here, and `maxSubagentDepth` and `maxConcurrentActions` bound
 * authority rather than consumption — a held depth cap would refuse a
 * grandchild and a held action slot would refuse a sibling's every call — so
 * the three stay with the parent's own ceilings.
 */
const RESERVED_AXES = ['maxSteps', 'maxToolCalls', 'maxTokens', 'maxWallMs', 'maxCostUsd'] as const satisfies readonly (keyof ResourceBudget)[]

/**
 * The remaining allowance for every configured ceiling, clamped at zero.
 * @param budget - the task's configured ceilings.
 * @param steps - observed model steps.
 * @param toolCalls - observed tool calls.
 * @param wallMs - observed wall-clock milliseconds.
 * @returns one remaining value per configured ceiling.
 */
function remainingAllowance(
  budget: ResourceBudget,
  steps: number,
  toolCalls: number,
  wallMs: number,
  tokens: number,
): ResourceBudget {
  return {
    ...budget.maxSteps === undefined ? {} : { maxSteps: Math.max(0, budget.maxSteps - steps) },
    ...budget.maxToolCalls === undefined ? {} : { maxToolCalls: Math.max(0, budget.maxToolCalls - toolCalls) },
    ...budget.maxWallMs === undefined ? {} : { maxWallMs: Math.max(0, budget.maxWallMs - wallMs) },
    // Token spend is derived from the same per-turn provider accounting the
    // token meter owns, so the remaining allowance is measured spend rather
    // than context pressure. Cost has no price source here, so a cost ceiling
    // stays unreported and `guard/budgets` keeps enforcing it.
    ...budget.maxTokens === undefined ? {} : { maxTokens: Math.max(0, budget.maxTokens - tokens) },
    ...budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd },
    ...budget.maxSubagentDepth === undefined ? {} : { maxSubagentDepth: budget.maxSubagentDepth },
    // A concurrency ceiling bounds the actions in flight rather than an amount
    // spent, and a slot frees when its action settles, so it is reported as
    // configured; the kernel enforces it against the actions in flight.
    ...budget.maxConcurrentActions === undefined ? {} : { maxConcurrentActions: budget.maxConcurrentActions },
  }
}
