/**
 * Novelty of a candidate body: distinct instruction lines it states that the
 * starting body did not, order-insensitively and insensitive to case and
 * spacing — so reformatting is not novelty and a new rule is.
 */
import { describe, expect, it } from 'vitest'
import { noveltyOf } from '../src/novelty.ts'

describe('noveltyOf', () => {
  it('reports zero for the body itself, a reorder, and a reformat', () => {
    expect(noveltyOf('# Writer\nDo the thing.', '# Writer\nDo the thing.')).toBe(0)
    expect(noveltyOf('Do the thing.\n# Writer', '# Writer\nDo the thing.')).toBe(0)
    expect(noveltyOf('# WRITER\n   do   THE thing.', '# Writer\nDo the thing.')).toBe(0)
  })

  it('measures the share of lines the reference does not carry', () => {
    const reference = '# Writer\nDo the thing.\nKeep it short.'
    // One of three lines is new material.
    expect(noveltyOf('# Writer\nDo the thing.\nRefuse unsafe paths.', reference)).toBeCloseTo(1 / 3)
    expect(noveltyOf('Refuse unsafe paths.', reference)).toBe(1)
  })

  it('counts a blank body as nothing to be novel about', () => {
    expect(noveltyOf('   \n\n', '# Writer')).toBe(0)
  })
})
