/** Line comparison with its timeout degradation. */
import { describe, expect, it } from 'vitest'
import { compareText, decidedText } from '../src/compare.ts'

describe('compareText', () => {
  it('yields unified hunks with context and counts only changed lines', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n')
    const result = compareText(before, after, 100)
    expect(result.coarse).toBe(false)
    expect(result).toMatchObject({ added: 2, deleted: 1 })
    // Changes whose context lines touch share one hunk.
    expect(result.hunks).toEqual([
      { oldStart: 1, oldLines: 10, newStart: 1, newLines: 11, lines: [' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', ' h', ' i', ' j', '+k'] },
    ])
    const far = compareText(`${before}\n${'z\n'.repeat(10)}end`, `${after}\n${'z\n'.repeat(10)}END`, 100)
    expect(far.hunks.map(hunk => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual([[1, 13, 1, 14], [18, 4, 19, 4]])
  })

  it('treats a missing side as no lines and an unterminated last line by content alone', () => {
    expect(compareText(null, 'x\ny\n', 100)).toMatchObject({ added: 2, deleted: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }] })
    expect(compareText('x\n', null, 100)).toMatchObject({ added: 0, deleted: 1 })
    expect(compareText('last', 'last\nadded', 100)).toMatchObject({ added: 1, deleted: 0 })
    expect(compareText('same\n', 'same\n', 100)).toEqual({ hunks: [], coarse: false, added: 0, deleted: 0 })
    expect(compareText(null, null, 100)).toEqual({ hunks: [], coarse: false, added: 0, deleted: 0 })
  })

  it('degrades to whole-file replacement once the timeout passes', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 4000 }, (_, i) => `new ${i}`).join('\n')
    const result = compareText(before, after, 1)
    expect(result.coarse).toBe(true)
    expect(result).toMatchObject({ added: 4000, deleted: 4000 })
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4000, newStart: 1, newLines: 4000 })
    expect(result.hunks[0]!.lines[0]).toBe('-old 0')
    expect(result.hunks[0]!.lines.at(-1)).toBe('+new 3999')
    const created = compareText(null, `${after}\n${before}`, 1)
    expect(created.coarse).toBe(true)
    expect(created).toMatchObject({ added: 8000, deleted: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 8000 }] })
  })
})

/** Two changed lines, eight lines apart, so their hunks never merge. */
const BEFORE = `${[
  '{',
  '  "name": "app",',
  '  "port": 8080,',
  '  "host": "localhost",',
  '  "secure": false,',
  '  "timeout": 30,',
  '  "keepAlive": true,',
  '  "logLevel": "info",',
  '  "region": "eu",',
  '  "shards": 2,',
  '  "queue": "default",',
  '  "retries": 3,',
  '  "tail": true',
  '}',
].join('\n')}\n`
const AFTER = BEFORE.replace('8080', '9090').replace('"retries": 3,', '"retries": 5,')

describe('decidedText', () => {
  it('keeps a rejected hunk at its turn-start lines while the accepted one takes the turn-end lines', () => {
    const hunks = compareText(BEFORE, AFTER, 100).hunks
    expect(hunks).toHaveLength(2)
    expect(decidedText(BEFORE, AFTER, hunks, ['accept', 'reject']))
      .toEqual({ exists: true, content: BEFORE.replace('8080', '9090') })
    expect(decidedText(BEFORE, AFTER, hunks, ['reject', 'accept']).content)
      .toBe(BEFORE.replace('"retries": 3,', '"retries": 5,'))
    // Every hunk decided the same way reproduces that whole side.
    expect(decidedText(BEFORE, AFTER, hunks, ['accept', 'accept']).content).toBe(AFTER)
    expect(decidedText(BEFORE, AFTER, hunks, ['reject', 'reject']).content).toBe(BEFORE)
  })

  it('follows the side that created or removed the file', () => {
    const created = compareText(null, AFTER, 100).hunks
    expect(decidedText(null, AFTER, created, ['accept'])).toEqual({ exists: true, content: AFTER })
    expect(decidedText(null, AFTER, created, ['reject'])).toEqual({ exists: false, content: '' })
    const removed = compareText(BEFORE, null, 100).hunks
    expect(decidedText(BEFORE, null, removed, ['accept'])).toEqual({ exists: false, content: '' })
    expect(decidedText(BEFORE, null, removed, ['reject'])).toEqual({ exists: true, content: BEFORE })
  })

  it('reproduces the shared lines when there are no hunks and keeps an unterminated last line unterminated', () => {
    // No hunks means both sides hold the same lines, so every decision set reproduces them.
    expect(decidedText(BEFORE, BEFORE, [], [])).toEqual({ exists: true, content: BEFORE })
    // An empty text over an absent side is a file the turn created empty, not a removal.
    expect(decidedText(null, '', [], [])).toEqual({ exists: true, content: '' })
    expect(decidedText('', null, [], [])).toEqual({ exists: false, content: '' })
    const hunks = compareText('a\nb', 'a\nB', 100).hunks
    expect(decidedText('a\nb', 'a\nB', hunks, ['reject']).content).toBe('a\nb')
    expect(decidedText('a\nb', 'a\nB', hunks, ['accept']).content).toBe('a\nB')
  })

  it('refuses a decision set that does not match the hunks', () => {
    const hunks = compareText(BEFORE, AFTER, 100).hunks
    expect(() => decidedText(BEFORE, AFTER, hunks, ['accept'])).toThrow('2 hunks need exactly 2 decisions, got 1')
    expect(() => decidedText(BEFORE, AFTER, [], ['reject'])).toThrow('0 hunks need exactly 0 decisions, got 1')
  })
})
