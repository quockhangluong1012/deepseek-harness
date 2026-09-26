/**
 * The delegation ledger one parent session owns: the cumulative child count the
 * policy's caps read, the in-flight set, the retained completed results the
 * overlap decision reuses, and the bound on what a parent keeps.
 *
 * @module @deepseek-ai/dsh-tool-subagent/tests/delegation-children
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DelegationLedger } from '../src/delegation-children.ts'

/** One live parent session for the ledger to key by. */
function parentSession(id: string): Session {
  return Session.create(SessionId(id))
}

describe('delegation ledger', () => {
  it('counts every admitted spawn and reports the in-flight ones', () => {
    const ledger = new DelegationLedger()
    const parent = parentSession('ledger-parent')

    expect(ledger.history(parent)).toEqual({ children: 0, concurrent: 0 })

    ledger.spawn(parent, { objective: 'first task' })
    const second = ledger.spawn(parent, { objective: 'second task', childId: 'child-2' })

    expect(ledger.history(parent)).toEqual({ children: 2, concurrent: 2 })
    expect(ledger.activeTasks(parent)).toEqual([
      { childId: 'delegation-1', objective: 'first task' },
      { childId: 'child-2', objective: 'second task' },
    ])

    ledger.settle(parent, second, { text: 'second answer', output: [{ type: 'text', text: 'second answer' }] })

    expect(ledger.history(parent)).toEqual({ children: 2, concurrent: 1 })
    expect(ledger.activeTasks(parent)).toEqual([{ childId: 'delegation-1', objective: 'first task' }])
    expect(ledger.completedTasks(parent)).toEqual([
      { childId: 'child-2', objective: 'second task', result: 'second answer' },
    ])
    expect(ledger.retainedResult(parent, 'child-2')?.text).toBe('second answer')
    expect(ledger.retainedResult(parent, 'delegation-1')).toBeUndefined()
  })

  it('settles a published child by the identity a subagent/end carries', () => {
    const ledger = new DelegationLedger()
    const parent = parentSession('settling-parent')
    ledger.spawn(parent, { objective: 'durable child', childId: 'child-7' })

    ledger.settleChild('child-7', { text: 'finished', output: [{ type: 'text', text: 'finished' }] })

    expect(ledger.history(parent)).toEqual({ children: 1, concurrent: 0 })
    expect(ledger.completedTasks(parent)).toEqual([
      { childId: 'child-7', objective: 'durable child', result: 'finished' },
    ])
    // A second end for the same child finds nothing in flight and changes nothing.
    ledger.settleChild('child-7')
    expect(ledger.completedTasks(parent)).toHaveLength(1)
    // An unknown child belongs to no delegation this ledger holds.
    ledger.settleChild('child-unknown')
    expect(ledger.history(parent)).toEqual({ children: 1, concurrent: 0 })
  })

  it('keeps a finished child without a result and settles an unknown handle once', () => {
    const ledger = new DelegationLedger()
    const parent = parentSession('failed-parent')
    const spawn = ledger.spawn(parent, { objective: 'failed task' })

    ledger.settle(parent, spawn)
    expect(ledger.completedTasks(parent)).toEqual([{ childId: 'delegation-1', objective: 'failed task' }])
    expect(ledger.retainedResult(parent, 'delegation-1')).toBeUndefined()

    // Settling the same handle twice, or a handle of another ledger, is a no-op.
    ledger.settle(parent, spawn, { text: 'late answer', output: [] })
    expect(ledger.history(parent)).toEqual({ children: 1, concurrent: 0 })
    expect(ledger.completedTasks(parent)).toEqual([{ childId: 'delegation-1', objective: 'failed task' }])
    const other = parentSession('other-parent')
    ledger.settle(other, { id: 'delegation-1' })
    expect(ledger.completedTasks(other)).toEqual([])
  })

  it('keeps only the most recent completed children of one parent', () => {
    const ledger = new DelegationLedger()
    const parent = parentSession('bounded-parent')
    for (let index = 0; index < 10; index += 1) {
      const spawn = ledger.spawn(parent, { objective: `task ${String(index)}` })
      ledger.settle(parent, spawn, { text: `answer ${String(index)}`, output: [] })
    }

    const completed = ledger.completedTasks(parent)
    expect(completed).toHaveLength(8)
    expect(completed[0]?.objective).toBe('task 9')
    expect(completed[7]?.objective).toBe('task 2')
    expect(ledger.history(parent)).toEqual({ children: 10, concurrent: 0 })
  })

  it("keeps one parent's history apart from another's", () => {
    const ledger = new DelegationLedger()
    const first = parentSession('first-parent')
    const second = parentSession('second-parent')

    ledger.spawn(first, { objective: 'only for the first parent' })

    expect(ledger.history(second)).toEqual({ children: 0, concurrent: 0 })
    expect(ledger.activeTasks(second)).toEqual([])
    expect(ledger.completedTasks(second)).toEqual([])
  })
})
