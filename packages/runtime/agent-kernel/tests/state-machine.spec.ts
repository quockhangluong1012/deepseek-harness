import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { applyTransition, assertTransition, canTransition, isActive, TASK_STATUSES } from '../src/state-machine.ts'
import type { RunId, StateTransition, TaskContract, TaskId, TaskStatus, TransitionId } from '../src/types.ts'

/** A minimal contract at revision 2 in the `ready` state. */
function contract(status: TaskStatus = 'ready'): TaskContract {
  return {
    taskId: brandString<TaskId>('task-1'),
    runId: brandString<RunId>('run-1'),
    objective: 'do the thing',
    constraints: [],
    acceptance: [],
    agentProfile: 'default',
    policyProfile: 'default',
    budget: {},
    status,
    revision: 2,
  }
}

/** One recorded transition answering {@link contract}. */
function transition(overrides: Partial<StateTransition> = {}): StateTransition {
  return {
    transitionId: brandString<TransitionId>('t-1'),
    taskId: brandString<TaskId>('task-1'),
    from: 'ready',
    to: 'executing',
    trigger: { kind: 'step-admitted' },
    preconditions: [],
    effects: [],
    taskRevision: 2,
    revision: 3,
    actor: 'kernel',
    at: 1,
    ...overrides,
  }
}

describe('task state machine', () => {
  it('admits every edge the kernel drives and rejects the edges leaving a terminal state', () => {
    expect(canTransition('intake', 'planning')).toBe(true)
    expect(canTransition('planning', 'ready')).toBe(true)
    expect(canTransition('ready', 'executing')).toBe(true)
    expect(canTransition('executing', 'observing')).toBe(true)
    expect(canTransition('observing', 'verifying')).toBe(true)
    expect(canTransition('verifying', 'completed')).toBe(true)
    expect(canTransition('recovering', 'planning')).toBe(true)

    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      expect(TASK_STATUSES.filter(status => canTransition(terminal, status))).toEqual([])
      expect(isActive(terminal)).toBe(false)
    }
    expect(isActive('ready')).toBe(true)
  })

  it('lists only the statuses a producer reaches', () => {
    expect(TASK_STATUSES).toEqual([
      'intake', 'planning', 'ready', 'executing', 'observing', 'verifying', 'recovering',
      'awaiting-approval', 'awaiting-user', 'paused', 'completed', 'failed', 'cancelled',
    ])
  })

  it('rejects an edge the table does not carry', () => {
    expect(canTransition('intake', 'executing')).toBe(false)
    expect(() => { assertTransition('intake', 'executing') }).toThrow(
      'agent-kernel: illegal task transition intake -> executing',
    )
    expect(() => { assertTransition('ready', 'executing') }).not.toThrow()
  })

  it('projects an accepted transition onto the contract', () => {
    expect(applyTransition(contract(), transition())).toMatchObject({ status: 'executing', revision: 3 })
  })

  it('rejects a transition belonging to another task, a stale edge, and a stale revision', () => {
    expect(() => applyTransition(contract(), transition({ taskId: brandString<TaskId>('task-2') }))).toThrow(
      'agent-kernel: transition for task "task-2" applied to task "task-1"',
    )
    expect(() => applyTransition(contract(), transition({ from: 'observing' }))).toThrow(
      'agent-kernel: transition observing -> executing applied to a task in ready',
    )
    expect(() => applyTransition(contract(), transition({ taskRevision: 1 }))).toThrow(
      'agent-kernel: stale transition at revision 1, task is at revision 2',
    )
  })
})
