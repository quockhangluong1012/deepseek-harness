/**
 * The kernel ledger: a cursor-based fold of one session's kernel events into
 * the task view the service reads, plus the budget observation derived from
 * the session's own step and tool-call events.
 *
 * The session log is the only source of truth. The fold keeps a cursor per
 * session and folds each event once, the way `ApprovalService` folds
 * `approval/policy`; a shortened log (repair or truncation) resets the cursor
 * and refolds from the start, so no cached value can outlive the events that
 * produced it.
 *
 * @module @deepseek-ai/dsh-agent-kernel/ledger
 */

import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type {
  ActionId,
  ActionProposal,
  AuthorizationDecision,
  BudgetGovernor,
  BudgetSnapshot,
  Checkpoint,
  FailureId,
  FailureRef,
  KernelStateReader,
  KernelView,
  PlanRevision,
  ResourceBudget,
  TaskContract,
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
  /** Approval request identity to the action whose tool call asked. */
  approvalRequests: Map<ApprovalRequestId, ActionId>
  /** Human outcome observed per action. */
  approvals: Map<ActionId, ApprovalOutcome>
  /** Failures with no accepted resolution. */
  failures: Map<FailureId, FailureRef>
  /** The action each action-owned failure belongs to, so a success can resolve it. */
  failureAction: Map<FailureId, ActionId>
  /** Latest plan revision. */
  plan: PlanRevision | undefined
  /** Latest checkpoint. */
  checkpoint: Checkpoint | undefined
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
    approvalRequests: new Map(),
    approvals: new Map(),
    failures: new Map(),
    failureAction: new Map(),
    plan: undefined,
    checkpoint: undefined,
  }
}

/**
 * The ledger's public surface: the read model the kernel service answers from,
 * plus the budget observation it records on checkpoints.
 */
export class KernelLedger implements KernelStateReader, BudgetGovernor {
  /** Per-session fold cursor and folded state. */
  private readonly entries = new WeakMap<Session, LedgerEntry>()

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
      ...entry.plan === undefined ? {} : { plan: entry.plan },
      ...entry.checkpoint === undefined ? {} : { checkpoint: entry.checkpoint },
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
   * Measure one task against its configured ceilings.
   * @param task - the task whose configured ceilings apply.
   * @param session - the session whose events were counted.
   * @returns the observation and the remaining allowance per configured ceiling.
   */
  measure(task: TaskContract, session: Session): BudgetSnapshot {
    const entry = this.entryOf(session)
    const wallMs = entry.createdAt === 0 ? 0 : Math.max(0, Date.now() - entry.createdAt)
    return {
      steps: entry.steps,
      toolCalls: entry.toolCalls,
      wallMs,
      remaining: remainingAllowance(task.budget, entry.steps, entry.toolCalls, wallMs),
    }
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
    case 'task/created':
      entry.task = event.data
      entry.createdAt = event.time
      return
    case 'task/transitioned':
      // A transition whose task is unknown belongs to a prefix this fold never
      // saw; without the create event there is no contract to apply it to.
      if (entry.task !== undefined) entry.task = applyTransition(entry.task, event.data)
      return
    case 'task/plan':
      entry.plan = event.data
      return
    case 'action/proposed':
      entry.openActions.add(event.data.actionId)
      entry.proposals.set(event.data.actionId, event.data)
      entry.attempts.set(event.data.actionId, (entry.attempts.get(event.data.actionId) ?? 0) + 1)
      return
    case 'action/authorized':
    case 'action/denied':
      entry.authorizations.set(event.data.proposal.actionId, event.data.decision)
      return
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
    case 'verification/result':
      // A passing verification resolves the verification failures it answers.
      if (event.data.status === 'pass') resolveFailuresOfKind(entry, 'verification-failed')
      return
    case 'checkpoint/created':
      entry.checkpoint = event.data
      return
    case 'step/start':
      entry.steps += 1
      return
    case 'tool/call':
      entry.toolCalls += 1
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
): ResourceBudget {
  return {
    ...budget.maxSteps === undefined ? {} : { maxSteps: Math.max(0, budget.maxSteps - steps) },
    ...budget.maxToolCalls === undefined ? {} : { maxToolCalls: Math.max(0, budget.maxToolCalls - toolCalls) },
    ...budget.maxWallMs === undefined ? {} : { maxWallMs: Math.max(0, budget.maxWallMs - wallMs) },
    // Token and cost ceilings are measured by the token meter, which this
    // package does not own: the kernel reports them unbounded rather than
    // guessing, and `guard/budgets` remains their enforcement listener.
    ...budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens },
    ...budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd },
    ...budget.maxSubagentDepth === undefined ? {} : { maxSubagentDepth: budget.maxSubagentDepth },
  }
}
