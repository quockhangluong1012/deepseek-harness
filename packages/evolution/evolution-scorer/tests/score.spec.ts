import { describe, expect, it } from 'vitest'
import type { WorkspaceSnapshotEntry } from '@deepseek-ai/dsh-session-snapshot'
import { scoreRun } from '../src/score.ts'
import type { ScoreAttempt } from '../src/types.ts'

const text = (path: string, content: string): WorkspaceSnapshotEntry => ({ path, kind: 'text', content })

function attempt(overrides: Partial<ScoreAttempt> = {}): ScoreAttempt {
  return {
    initial: [],
    final: [],
    tokens: 0,
    wallTimeMs: 0,
    ...overrides,
  }
}

describe('scoreRun', () => {
  it('passes when every attempt matches the expected workspace', () => {
    const expected = [text('note.txt', 'seed\n')]
    const score = scoreRun({
      scenario: 'text-turn',
      expected,
      fixtureDigest: 'test-fixture-digest',
      attempts: [
        attempt({ initial: expected, final: [...expected], tokens: 3114, wallTimeMs: 120 }),
        attempt({ initial: expected, final: [...expected], tokens: 3114, wallTimeMs: 140 }),
      ],
    })
    expect(score).toMatchObject({ scenario: 'text-turn', pass: true, changes: [], tokens: 3114, wallTimeMs: 130 })
  })

  it('fails on the first divergent attempt and names its paths', () => {
    const expected = [text('note.txt', 'expected\n'), text('kept.txt', 'same\n')]
    const score = scoreRun({
      scenario: 'workspace-edit',
      expected,
      fixtureDigest: 'test-fixture-digest',
      attempts: [
        attempt({ initial: expected, final: [text('note.txt', 'expected\n'), text('extra.txt', 'new\n'), text('kept.txt', 'same\n')] }),
        attempt({ initial: expected, final: [] }),
      ],
    })
    expect(score.pass).toBe(false)
    // The second attempt's empty workspace would name kept.txt instead, so this
    // assertion proves the first divergent attempt is the one reported.
    expect(score.changes).toEqual([{ path: 'extra.txt', kind: 'added' }])
  })

  it('compares each attempt against its own initial workspace when the scenario ships no expectation', () => {
    const score = scoreRun({
      scenario: 'read-only',
      fixtureDigest: 'test-fixture-digest',
      attempts: [
        attempt({ initial: [text('a.txt', 'one\n')], final: [text('a.txt', 'one\n')] }),
        attempt({ initial: [text('a.txt', 'two\n')], final: [text('a.txt', 'two\n')] }),
      ],
    })
    expect(score).toMatchObject({ pass: true, changes: [] })
  })

  it('fails an attempt that changed its own initial workspace when no expectation is shipped', () => {
    const score = scoreRun({
      scenario: 'read-only',
      fixtureDigest: 'test-fixture-digest',
      attempts: [attempt({ initial: [text('a.txt', 'one\n')], final: [text('a.txt', 'two\n')] })],
    })
    expect(score).toMatchObject({ pass: false, changes: [{ path: 'a.txt', kind: 'changed' }] })
  })

  it('reduces billed tokens and wall time to their medians and keeps every sample', () => {
    const score = scoreRun({
      scenario: 'median',
      expected: [],
      fixtureDigest: 'test-fixture-digest',
      attempts: [
        attempt({ tokens: 30, wallTimeMs: 100 }),
        attempt({ tokens: 50, wallTimeMs: 200 }),
        attempt({ tokens: 40, wallTimeMs: 1000 }),
      ],
    })
    expect(score).toMatchObject({ tokens: 40, wallTimeMs: 200, samples: [100, 200, 1000] })
  })
})
