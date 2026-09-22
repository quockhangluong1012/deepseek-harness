import { describe, expect, it } from 'vitest'
import { priorityOf, queueFor, UNCERTAINTY_KINDS } from '../src/uncertainty.ts'
import type { UncertaintySignal } from '../src/types.ts'

const signal = (overrides: Partial<UncertaintySignal>): UncertaintySignal => ({
  signalId: 's1',
  skill: 'writer',
  taskId: 't1',
  kind: 'disagreement',
  score: 0.5,
  detail: 'channels split on routing',
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('priorityOf', () => {
  it('takes the strongest score as the base', () => {
    expect(priorityOf([0.25, 0.75, 0.5], 1, 0.15)).toBe(0.75)
  })

  it('adds the bonus per distinct kind past the first', () => {
    expect(priorityOf([0.5], 1, 0.25)).toBe(0.5)
    expect(priorityOf([0.5, 0.25], 3, 0.25)).toBe(1)
  })

  it('caps the corroborated priority at 1', () => {
    expect(priorityOf([0.9], 2, 0.25)).toBe(1)
  })

  it('scores an empty signal list as zero', () => {
    expect(priorityOf([], 0, 0.15)).toBe(0)
  })
})

describe('queueFor', () => {
  it('merges signals sharing a skill and task into one corroborated task', () => {
    const tasks = queueFor([
      signal({ signalId: 's1', score: 0.5 }),
      signal({ signalId: 's2', kind: 'low-confidence', score: 0.75, detail: 'judge hedged' }),
    ], 0.25)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      skill: 'writer',
      taskId: 't1',
      kinds: ['disagreement', 'low-confidence'],
      topScore: 0.75,
      priority: 1,
      signals: 2,
    })
  })

  it('keeps null-task signals in their own skill-wide group', () => {
    const tasks = queueFor([
      signal({ signalId: 's1', taskId: 't1' }),
      signal({ signalId: 's2', taskId: null, detail: 'skill-wide doubt' }),
    ], 0.25)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((task) => task.taskId).sort()).toEqual([null, 't1'])
    expect(tasks.find((task) => task.taskId === null)).toMatchObject({ skill: 'writer', signals: 1 })
  })

  it('orders kinds canonically regardless of signal order', () => {
    expect(UNCERTAINTY_KINDS).toEqual([
      'disagreement',
      'low-confidence',
      'instability',
      'retrieval-ambiguity',
      'conflicting-evidence',
    ])
    const tasks = queueFor([
      signal({ signalId: 's1', kind: 'conflicting-evidence' }),
      signal({ signalId: 's2', kind: 'retrieval-ambiguity' }),
      signal({ signalId: 's3', kind: 'instability' }),
      signal({ signalId: 's4', kind: 'low-confidence' }),
      signal({ signalId: 's5', kind: 'disagreement' }),
    ], 0.25)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.kinds).toEqual([...UNCERTAINTY_KINDS])
  })

  it('breaks priority ties by skill, then task, with null last', () => {
    const tasks = queueFor([
      signal({ signalId: 's2', taskId: 't2', score: 0.5 }),
      signal({ signalId: 's4', skill: 'auditor', taskId: null, score: 0.5 }),
      signal({ signalId: 's1', taskId: 't1', score: 0.5 }),
      signal({ signalId: 's3', taskId: null, score: 0.5 }),
    ], 0.25)
    expect(tasks.map((task) => [task.skill, task.taskId])).toEqual([
      ['auditor', null],
      ['writer', 't1'],
      ['writer', 't2'],
      ['writer', null],
    ])
  })

  it('reaches the same tie order from the reverse insertion order', () => {
    const tasks = queueFor([
      signal({ signalId: 's3', taskId: null, score: 0.5 }),
      signal({ signalId: 's1', taskId: 't1', score: 0.5 }),
      signal({ signalId: 's2', taskId: 't2', score: 0.5 }),
      signal({ signalId: 's4', skill: 'auditor', taskId: null, score: 0.5 }),
    ], 0.25)
    expect(tasks.map((task) => [task.skill, task.taskId])).toEqual([
      ['auditor', null],
      ['writer', 't1'],
      ['writer', 't2'],
      ['writer', null],
    ])
  })

  it('lifts a corroborated task above a hotter single-kind one', () => {
    const tasks = queueFor([
      signal({ signalId: 'hot', taskId: 'hot', score: 0.9 }),
      signal({ signalId: 'warm-a', taskId: 'warm', score: 0.75 }),
      signal({ signalId: 'warm-b', taskId: 'warm', kind: 'low-confidence', score: 0.5, detail: 'judge hedged' }),
    ], 0.25)
    expect(tasks.map((task) => task.taskId)).toEqual(['warm', 'hot'])
    expect(tasks[0]).toMatchObject({ priority: 1, signals: 2 })
    expect(tasks[1]).toMatchObject({ priority: 0.9, signals: 1 })
  })

  it('returns an empty queue for no signals', () => {
    expect(queueFor([], 0.15)).toEqual([])
  })
})
