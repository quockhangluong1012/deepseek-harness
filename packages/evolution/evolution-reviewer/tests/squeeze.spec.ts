import { describe, expect, it } from 'vitest'
import { DEFAULT_SQUEEZE_ORDER, squeezeLessons } from '../src/squeeze.ts'

const ORDER = DEFAULT_SQUEEZE_ORDER

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

describe('lean squeeze', () => {
  it('keeps only the memory headings and reports dropped prose', () => {
    const out = squeezeLessons(
      'Here is your document:\n## Purpose\nship the parser\n## Notes\nscratch that\n## References\n-',
      4096,
      ORDER,
    )
    expect(out.text).toBe('## Purpose\nship the parser\n## References\n-')
    expect(out.truncated).toBe(true)
  })

  it('returns output without a single memory heading unchanged', () => {
    const out = squeezeLessons('partial doc', 4096, ORDER)
    expect(out).toEqual({ text: 'partial doc', truncated: false })
  })

  it('leaves a fitting document byte-identical', () => {
    const text = '## Purpose\nship\n## Preferences\nshort\n## Decisions\none\n## References\n-'
    expect(squeezeLessons(text, 4096, ORDER)).toEqual({ text, truncated: false })
  })

  it('sheds bodies in pressure order until the document fits', () => {
    const text = [
      '## Purpose',
      'p'.repeat(80),
      '## Preferences',
      'e'.repeat(80),
      '## Decisions',
      'd'.repeat(80),
      '## References',
      'r'.repeat(80),
    ].join('\n')
    // Room for the headings plus a single body.
    const budget = bytes('## Purpose\n## Preferences\n## Decisions\n## References') + 90
    const out = squeezeLessons(text, budget, ORDER)
    expect(out.truncated).toBe(true)
    expect(bytes(out.text)).toBeLessThanOrEqual(budget)
    // References, Decisions, and Preferences shed first; Purpose stays longest.
    expect(out.text).toContain('p'.repeat(80))
    expect(out.text).not.toContain('r'.repeat(80))
    expect(out.text).not.toContain('d'.repeat(80))
    expect(out.text).not.toContain('e'.repeat(80))
    expect(out.text).toContain('## References')
  })

  it('honors a configured pressure order', () => {
    const text = '## Purpose\nppp\n## References\nrrr'
    const out = squeezeLessons(text, bytes('## Purpose\n## References') + 4, ['## Purpose', '## References'])
    expect(out.text).toContain('rrr')
    expect(out.text).not.toContain('ppp')
  })

  it('clips the last standing body at a UTF-8 boundary', () => {
    const text = `## Purpose\n${'a😀'.repeat(2000)}`
    const budget = bytes('## Purpose') + 6
    const out = squeezeLessons(text, budget, ORDER)
    expect(out.truncated).toBe(true)
    expect(bytes(out.text)).toBeLessThanOrEqual(budget)
    expect(out.text).toBe('## Purpose\na😀')
  })

  it('drops a body whose whole section is empty and merges repeats', () => {
    const text = '## References\n\n## Purpose\nfirst\n## Purpose\nsecond\n## Decisions\n'
    const out = squeezeLessons(text, 4096, ORDER)
    expect(out.text).toBe('## References\n## Purpose\nfirst\nsecond\n## Decisions')
    expect(out.truncated).toBe(false)
  })

  it('trims blank edges and leading prose without flagging clean documents', () => {
    const out = squeezeLessons('prose before\n\n## Purpose\nbody\n\n## References\n-\n\n', 4096, ORDER)
    expect(out.text).toBe('## Purpose\nbody\n## References\n-')
    expect(out.truncated).toBe(true)
    const clean = squeezeLessons('## Purpose\nbody\n\n## References\n-', 4096, ORDER)
    expect(clean.text).toBe('## Purpose\nbody\n## References\n-')
    expect(clean.truncated).toBe(false)
  })

  it('keeps the headings when every body is already empty', () => {
    const text = '## Purpose\n\n## Preferences\n\n## Decisions\n\n## References\n'
    expect(squeezeLessons(text, 1, ORDER).text).toBe('## Purpose\n## Preferences\n## Decisions\n## References')
  })

  it('returns the headings alone when the budget cannot hold a body', () => {
    const out = squeezeLessons('## Purpose\nneeds room', 0, ORDER)
    expect(out.text).toBe('## Purpose')
    expect(out.truncated).toBe(true)
  })
})
