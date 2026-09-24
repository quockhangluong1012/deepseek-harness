/**
 * The kernel metrics one session's log already carries. Every counter here is
 * derived from events the kernel writes anyway, so a deployment reads what
 * happened without instrumenting a second time and without trusting a
 * self-report.
 *
 * Rates are omitted rather than guessed when their denominator is zero, and a
 * denominator counts only the events that make a rate meaningful: a task
 * success rate counts tasks that reached a terminal status, not tasks still
 * running.
 *
 * @module @deepseek-ai/dsh-agent-kernel/metrics
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ActionId, FailureKind, RecoveryAction, TaskStatus } from './types.ts'

/**
 * The kernel-owned metrics of one session.
 *
 * Names follow the metric families the subsystem contract lists: `task.*` for
 * lifecycle outcomes, `run.*` for the work one task spent, `policy.*`,
 * `approval.*`, `sandbox.*`, `recovery.*`, and `checkpoint.*`. Metrics owned by
 * other packages — context compaction, memory recall utility, skill utility,
 * evolution gain — are not derived here: their owners write them.
 */
export interface KernelMetrics {
  /** Tasks the session opened. */
  readonly tasksCreated: number
  /** Terminal task statuses observed, by status. */
  readonly taskOutcomes: Readonly<Partial<Record<TaskStatus, number>>>
  /** `completed` tasks over tasks that reached any terminal status; absent when none did. */
  readonly taskSuccessRate?: number
  /** Verification results recorded. */
  readonly verifications: number
  /** Verification results with status `pass`. */
  readonly verificationsPassed: number
  /** Passing verifications over recorded ones; absent when none was recorded. */
  readonly verificationPassRate?: number
  /** Model steps started (`step/start`). */
  readonly steps: number
  /** Tool calls recorded (`tool/call`). */
  readonly toolCalls: number
  /** Actions proposed. */
  readonly actionsProposed: number
  /** Actions whose receipt reports `succeeded`. */
  readonly actionsSucceeded: number
  /** Actions whose receipt reports `failed`. */
  readonly actionsFailed: number
  /** Actions refused by policy or by a human answer. */
  readonly actionsDenied: number
  /** Composed decisions whose effect was `deny`. */
  readonly policyDenied: number
  /** Composed decisions whose effect was `ask`. */
  readonly policyAsked: number
  /** Human answers that were not `allowed-once`. */
  readonly approvalsRejected: number
  /** Failures recorded, by classified kind. */
  readonly failuresByKind: Readonly<Partial<Record<FailureKind, number>>>
  /** Recovery decisions recorded, by action taken. */
  readonly recoveryByAction: Readonly<Partial<Record<RecoveryAction, number>>>
  /** Failures that no recovery decision answered. */
  readonly failuresWithoutRecovery: number
  /** Checkpoints recorded. */
  readonly checkpoints: number
  /** Checkpoint resumes observed. */
  readonly checkpointResumes: number
  /** Distinct actions that were proposed more than once. */
  readonly retriedActions: number
  /** Actions that were proposed but never received a receipt. */
  readonly unfinishedActions: number
}

/**
 * Fold one session's events into the kernel metrics they imply.
 *
 * The fold reads only kernel-owned events, so a log written by a kernel of an
 * older revision yields the counters its vocabulary supports and nothing else.
 * @param events - the session's events, in log order.
 * @returns the metrics this log implies.
 */
export function readKernelMetrics(events: Iterable<SessionEvent>): KernelMetrics {
  let tasksCreated = 0
  const taskOutcomes: Partial<Record<TaskStatus, number>> = {}
  let verifications = 0
  let verificationsPassed = 0
  let steps = 0
  let toolCalls = 0
  const proposals = new Map<ActionId, number>()
  const receipts = new Map<ActionId, 'succeeded' | 'failed' | 'denied'>()
  let policyDenied = 0
  let policyAsked = 0
  let approvalsRejected = 0
  const failuresByKind: Partial<Record<FailureKind, number>> = {}
  const recoveryByAction: Partial<Record<RecoveryAction, number>> = {}
  let checkpoints = 0
  let checkpointResumes = 0

  for (const event of events) {
    switch (event.type) {
      case 'task/created':
        tasksCreated += 1
        break
      case 'task/transitioned': {
        const status = event.data.to
        if (isTerminal(status)) taskOutcomes[status] = (taskOutcomes[status] ?? 0) + 1
        break
      }
      case 'verification/result':
        verifications += 1
        if (event.data.status === 'pass') verificationsPassed += 1
        break
      case 'step/start':
        steps += 1
        break
      case 'tool/call':
        toolCalls += 1
        break
      case 'action/decided': {
        const actionId = event.data.proposal.actionId
        proposals.set(actionId, (proposals.get(actionId) ?? 0) + 1)
        // The rule decision answers what the permission document said; the
        // composed authorization answers what the pipeline did with it.
        if (event.data.policy.effect === 'ask') policyAsked += 1
        if (event.data.policy.effect === 'deny') policyDenied += 1
        break
      }
      case 'action/committed':
        receipts.set(event.data.actionId, event.data.outcome)
        break
      case 'approval/decided':
        if (event.data.outcome !== 'allowed-once') approvalsRejected += 1
        break
      case 'failure/recorded': {
        const kind = event.data.kind
        failuresByKind[kind] = (failuresByKind[kind] ?? 0) + 1
        break
      }
      case 'recovery/decided': {
        const action = event.data.action
        recoveryByAction[action] = (recoveryByAction[action] ?? 0) + 1
        break
      }
      case 'checkpoint/created':
        checkpoints += 1
        break
      case 'checkpoint/resumed':
        checkpointResumes += 1
        break
      default:
        break
    }
  }

  const recovered = Object.values(recoveryByAction).reduce((total, count) => total + count, 0)
  const recordedFailures = Object.values(failuresByKind).reduce((total, count) => total + count, 0)
  let actionsSucceeded = 0
  let actionsFailed = 0
  let actionsDenied = 0
  for (const outcome of receipts.values()) {
    if (outcome === 'succeeded') actionsSucceeded += 1
    else if (outcome === 'failed') actionsFailed += 1
    else actionsDenied += 1
  }
  const terminalOutcomes = Object.values(taskOutcomes).reduce((total, count) => total + count, 0)
  const completed = taskOutcomes.completed ?? 0

  return {
    tasksCreated,
    taskOutcomes,
    ...terminalOutcomes === 0 ? {} : { taskSuccessRate: completed / terminalOutcomes },
    verifications,
    verificationsPassed,
    ...verifications === 0 ? {} : { verificationPassRate: verificationsPassed / verifications },
    steps,
    toolCalls,
    actionsProposed: [...proposals.values()].reduce((total, count) => total + count, 0),
    actionsSucceeded,
    actionsFailed,
    actionsDenied,
    policyDenied,
    policyAsked,
    approvalsRejected,
    failuresByKind,
    recoveryByAction,
    failuresWithoutRecovery: Math.max(0, recordedFailures - recovered),
    checkpoints,
    checkpointResumes,
    retriedActions: [...proposals.values()].filter(count => count > 1).length,
    unfinishedActions: [...proposals.keys()].filter(actionId => !receipts.has(actionId)).length,
  }
}

/**
 * Whether a task status ends the task's life.
 * @param status - the status a transition entered.
 * @returns true when no further transition is expected.
 */
function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
