/**
 * The panel's two derivations over the facts its owners publish: produced
 * files gathered off the Chat target's Turn data, and the "has anything to
 * report" test the reveal reads.
 */
import { describe, expect, it } from 'vitest'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { hasProgress, producedPaths } from '../src/client/progress.ts'

/** A timeline whose turns carry the `deliverables` Turn data, in the given order. */
function timelineOf(...turns: ReadonlyArray<readonly string[]>): ConversationTimelineSnapshot {
  return {
    turnOrder: turns.map((_, index) => index + 1),
    turns: new Map(turns.map((paths, index) => [index + 1, {
      data: {
        get: (key: string) => key === 'deliverables'
          ? { produced: paths.map((path, seq) => ({ seq, path })) }
          : undefined,
      },
    }])),
  } as unknown as ConversationTimelineSnapshot
}

const TODOS: readonly TodoItem[] = [{ content: 'write the panel', status: 'completed' }]

describe('producedPaths', () => {
  it('reports nothing before a timeline exists', () => {
    expect(producedPaths(undefined)).toEqual([])
  })

  it('gathers the turns in timeline order, each turn in production order', () => {
    expect(producedPaths(timelineOf(['a.md'], ['b.md', 'c.md']))).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('lists a path rewritten by a later turn once, where it first appeared', () => {
    expect(producedPaths(timelineOf(['a.md', 'b.md'], ['a.md']))).toEqual(['a.md', 'b.md'])
  })

  it('skips turns that produced nothing and timelines with no produced file', () => {
    expect(producedPaths(timelineOf([], ['a.md']))).toEqual(['a.md'])
    expect(producedPaths({ turnOrder: [], turns: new Map() })).toEqual([])
  })

  it('skips a listed turn with no row and a turn that published no Turn data', () => {
    const timeline = {
      turnOrder: [1, 2, 3],
      turns: new Map([
        [1, { data: { get: () => undefined } }],
        [3, { data: { get: () => ({ produced: [{ seq: 0, path: 'a.md' }] }) } }],
      ]),
    } as unknown as ConversationTimelineSnapshot
    expect(producedPaths(timeline)).toEqual(['a.md'])
    expect(hasProgress(null, timeline)).toBe(true)
  })
})

describe('hasProgress', () => {
  it('is true for a non-empty checklist, empty and null checklists included as absent', () => {
    expect(hasProgress(TODOS, undefined)).toBe(true)
    expect(hasProgress([], undefined)).toBe(false)
    expect(hasProgress(null, undefined)).toBe(false)
    expect(hasProgress(undefined, undefined)).toBe(false)
  })

  it('is true for a product file even with no checklist', () => {
    expect(hasProgress(null, timelineOf(['a.md']))).toBe(true)
    expect(hasProgress(null, timelineOf([]))).toBe(false)
  })
})
