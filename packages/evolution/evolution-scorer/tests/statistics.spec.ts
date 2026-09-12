import { describe, expect, it } from 'vitest'
import { medianOf } from '../src/statistics.ts'

describe('medianOf', () => {
  it('returns the middle sample of an odd count regardless of observation order', () => {
    expect(medianOf([900, 100, 200])).toBe(200)
  })

  it('averages the two middle samples of an even count', () => {
    expect(medianOf([50, 30])).toBe(40)
    expect(medianOf([300, 100, 200, 400])).toBe(250)
  })

  it('returns the only sample of a single-attempt run', () => {
    expect(medianOf([7])).toBe(7)
  })

  it('rejects an empty sample list instead of reporting a number', () => {
    expect(() => medianOf([])).toThrow(/at least one sample/)
  })
})
