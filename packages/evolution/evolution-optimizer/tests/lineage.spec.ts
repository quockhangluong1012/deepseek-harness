/**
 * Changed components: added and removed line counts between a starting body
 * and its winner. Pure, so specs drive the arithmetic without a run.
 */
import { describe, expect, it } from 'vitest'
import { diffLineCounts } from '../src/lineage.ts'

describe('diffLineCounts', () => {
  it('reports zero for identical bodies', () => {
    expect(diffLineCounts('# writer\nrule one\n', '# writer\nrule one\n')).toEqual({ addedLines: 0, removedLines: 0 })
  })

  it('counts one added and one removed line for a changed rule', () => {
    expect(diffLineCounts('# writer\nold rule\n', '# writer\nnew rule\n')).toEqual({ addedLines: 1, removedLines: 1 })
  })

  it('counts appended lines as added only', () => {
    expect(diffLineCounts('# writer\n', '# writer\nrule one\nrule two\n')).toEqual({ addedLines: 2, removedLines: 0 })
  })

  it('counts a pure reorder as change, since order is content', () => {
    expect(diffLineCounts('a\nb\n', 'b\na\n')).toEqual({ addedLines: 1, removedLines: 1 })
  })

  it('shares context across a substitution, so surrounding lines cost nothing', () => {
    expect(diffLineCounts('head\nold\ntail\n', 'head\nnew\ntail\n')).toEqual({ addedLines: 1, removedLines: 1 })
  })
})
