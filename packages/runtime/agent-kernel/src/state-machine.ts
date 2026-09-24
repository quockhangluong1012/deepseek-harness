/**
 * The task-state machine: the legal edge table, the edge assertion the kernel
 * uses before recording a transition, and the compare-and-set projection that
 * applies a recorded transition to a task contract. No I/O — the kernel
 * service owns when a transition is proposed and where it is recorded.
 *
 * @module @deepseek-ai/dsh-agent-kernel/state-machine
 */

import type { StateTransition, TaskContract, TaskStatus } from './types.ts'

/** Every task status, in the order the kernel's lifecycle reaches them. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'intake',
  'planning',
  'ready',
  'executing',
  'observing',
  'verifying',
  'recovering',
  'awaiting-approval',
  'awaiting-user',
  'paused',
  'completed',
  'failed',
  'cancelled',
]

/**
 * Every legal edge of the task state machine. The kernel's driver takes
 * `intake → ready` directly when plan mode is not entered, and records
 * `step-admitted` as the trigger; plan mode moves `intake`/`awaiting-user`/
 * `paused`/`recovering` through `planning` before the next step is admitted.
 * `awaiting-approval`, `awaiting-user`, `paused`, and `cancelled` are reachable
 * from every non-terminal state; terminal states have no outgoing edge.
 */
const LEGAL_EDGES: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  intake: ['planning', 'ready', 'awaiting-approval', 'awaiting-user', 'paused', 'cancelled', 'failed'],
  planning: ['ready', 'executing', 'observing', 'awaiting-approval', 'awaiting-user', 'paused', 'cancelled', 'failed'],
  ready: ['executing', 'planning', 'awaiting-approval', 'awaiting-user', 'paused', 'cancelled', 'failed'],
  executing: ['observing', 'planning', 'awaiting-approval', 'awaiting-user', 'paused', 'cancelled', 'failed'],
  observing: ['executing', 'planning', 'verifying', 'recovering', 'awaiting-approval', 'awaiting-user', 'paused', 'cancelled', 'failed'],
  verifying: ['completed', 'recovering', 'awaiting-user', 'paused', 'cancelled', 'failed'],
  recovering: ['executing', 'planning', 'awaiting-user', 'paused', 'cancelled', 'failed'],
  'awaiting-approval': ['ready', 'executing', 'awaiting-user', 'paused', 'cancelled', 'failed'],
  'awaiting-user': ['executing', 'planning', 'recovering', 'paused', 'cancelled', 'failed'],
  paused: ['executing', 'planning', 'awaiting-user', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
}

/**
 * Whether the edge exists in the legal table. This answers the shape of the
 * machine only; a caller that also needs freshness checks the transition's
 * `taskRevision` against the contract it is applied to.
 * @param from - status the task holds.
 * @param to - status the task would enter.
 * @returns true when the edge is legal.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL_EDGES[from].includes(to)
}

/**
 * Reject an illegal edge before anything is recorded.
 * @param from - status the task holds.
 * @param to - status the task would enter.
 * @throws When the edge is not in the legal table.
 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`agent-kernel: illegal task transition ${from} -> ${to}`)
  }
}

/**
 * Whether a task in this status is still running work.
 * @param status - status to classify.
 * @returns true for every non-terminal status.
 */
export function isActive(status: TaskStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled'
}

/**
 * Apply one recorded transition to the contract it answers, enforcing the
 * compare-and-set identity the kernel promises: the transition must belong to
 * this task, start from its current status, and cite its current revision.
 * @param contract - the contract the transition was evaluated against.
 * @param transition - the accepted transition to project.
 * @returns the contract at the transition's resulting status and revision.
 * @throws When the transition is stale or belongs to another task.
 */
export function applyTransition(contract: TaskContract, transition: StateTransition): TaskContract {
  if (transition.taskId !== contract.taskId) {
    throw new Error(`agent-kernel: transition for task "${transition.taskId}" applied to task "${contract.taskId}"`)
  }
  if (transition.from !== contract.status) {
    throw new Error(`agent-kernel: transition ${transition.from} -> ${transition.to} applied to a task in ${contract.status}`)
  }
  if (transition.taskRevision !== contract.revision) {
    throw new Error(
      `agent-kernel: stale transition at revision ${transition.taskRevision}, task is at revision ${contract.revision}`,
    )
  }
  return { ...contract, status: transition.to, revision: transition.revision }
}
