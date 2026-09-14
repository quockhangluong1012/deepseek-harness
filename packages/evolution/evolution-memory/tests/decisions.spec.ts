import { describe, expect, it } from 'vitest'
import { applyLessonDecisions, lessonDecision } from '../src/decisions.ts'
import type { LessonDecision } from '../src/decisions.ts'
import { artifactKey } from '../src/lesson-artifact.ts'
import type { LessonArtifact, LessonArtifactInput } from '../src/lesson-artifact.ts'
import type { EvolutionMemoryRecord } from '../src/types.ts'

const NOW = '2026-09-14T00:00:00.000Z'

/** One stored artifact with the fields these tests vary pinned. */
function artifact(statement: string, overrides: Partial<LessonArtifact> = {}): LessonArtifact {
  return {
    id: artifactKey(statement), statement, source: 's1', conditions: 'first', evidence: 'inference',
    confidence: 0.6, validationCount: 2, refutationCount: 1, scope: 'project',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

/** One caller-supplied candidate with the fields these tests vary pinned. */
function candidate(statement: string, overrides: Partial<LessonArtifactInput> = {}): LessonArtifactInput {
  return { statement, source: 's2', conditions: 'second', evidence: 'fact', confidence: 0.9, scope: 'project', ...overrides }
}

/** One record carrying the given artifacts and nothing else. */
function record(artifacts: readonly LessonArtifact[] = []): EvolutionMemoryRecord {
  return {
    instructions: '', agentLessons: artifacts, userProfile: '',
    instructionsUpdatedAt: null, lessonsUpdatedAt: null, profileUpdatedAt: null, memoryUpdatedAt: null,
    contextItems: [], outputs: [], lastExtraction: null, staged: [], resolutions: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** Apply one batch with no pre-resolved merge target unless one is supplied. */
function apply(
  base: EvolutionMemoryRecord,
  decisions: readonly LessonDecision[],
  addTargets: ReadonlyMap<number, LessonArtifact | undefined> = new Map(),
): EvolutionMemoryRecord {
  return applyLessonDecisions(base, decisions, addTargets, NOW, 30)
}

describe('lesson decision vocabulary', () => {
  it('accepts each of the three decisions and a batch of them', () => {
    const decisions: LessonDecision[] = [
      { kind: 'confirms', artifactId: 'use postgres' },
      { kind: 'contradicts', artifactId: 'use postgres', statement: 'use mysql', confidence: 0.2 },
      { kind: 'new', candidate: candidate('prefers terse answers') },
      { kind: 'new', candidate: candidate('avoid orm generators'), strategy: 'merge' },
    ]
    expect(lessonDecision.array().parse(decisions)).toEqual(decisions)
  })

  it('rejects an unaddressed or blank-text decision', () => {
    expect(() => lessonDecision.parse({ kind: 'unrelated', artifactId: 'x' })).toThrow()
    expect(() => lessonDecision.parse({ kind: 'confirms' })).toThrow()
    expect(() => lessonDecision.parse({ kind: 'confirms', artifactId: '' })).toThrow()
    // A corrected statement an artifact could never be keyed by is refused at
    // the vocabulary, not when the fold reaches it.
    expect(() => lessonDecision.parse({ kind: 'contradicts', artifactId: 'x', statement: ' \n ' })).toThrow('blank once normalized')
    expect(() => lessonDecision.parse({ kind: 'contradicts', artifactId: 'x', confidence: 2 })).toThrow()
    expect(() => lessonDecision.parse({ kind: 'new', candidate: candidate('x'), strategy: 'replace' })).toThrow()
    expect(() => lessonDecision.parse({ kind: 'new', candidate: { ...candidate('x'), evidence: 'guess' } })).toThrow()
  })
})

describe('applying a decision batch', () => {
  it('confirms an artifact: one counter and the instant, nothing else', () => {
    const existing = artifact('use postgres', { ttlDays: 7 })
    const next = apply(record([existing]), [{ kind: 'confirms', artifactId: existing.id }])
    expect(next.agentLessons).toEqual([{ ...existing, validationCount: 3, updatedAt: NOW }])
    // The family stamp is the caller's job: the fold returns an unstamped record.
    expect(next.lessonsUpdatedAt).toBeNull()
  })

  it('skips a decision whose artifact the record no longer holds', () => {
    const base = record([artifact('use postgres')])
    const pruned = apply(base, [
      { kind: 'confirms', artifactId: 'pruned fact' },
      { kind: 'contradicts', artifactId: 'pruned fact', statement: 'rewritten' },
    ])
    expect(pruned).toBe(base)
  })

  it('contradicts an artifact: bumps the counter and applies the correction it carries', () => {
    const existing = artifact('use postgres', { conditions: 'database work' })
    const next = apply(record([existing]), [
      { kind: 'contradicts', artifactId: existing.id, statement: 'use mysql 8', confidence: 0.2 },
    ])
    expect(next.agentLessons).toEqual([{
      ...existing,
      statement: 'use mysql 8',
      confidence: 0.2,
      refutationCount: 2,
      updatedAt: NOW,
    }])
    // The correction keeps the id it is addressed by, so the id no longer
    // equals the normalized statement the artifact now carries.
    expect(next.agentLessons[0]?.id).toBe(existing.id)
    expect(next.agentLessons[0]?.createdAt).toBe(existing.createdAt)
    expect(next.agentLessons[0]?.validationCount).toBe(existing.validationCount)
  })

  it('contradicts an artifact with one field and with none, touching only that counter', () => {
    const existing = artifact('use postgres')
    const confidenceOnly = apply(record([existing]), [
      { kind: 'contradicts', artifactId: existing.id, confidence: 0.1 },
    ])
    expect(confidenceOnly.agentLessons[0]).toEqual({ ...existing, confidence: 0.1, refutationCount: 2, updatedAt: NOW })

    const bare = apply(record([existing]), [{ kind: 'contradicts', artifactId: existing.id }])
    expect(bare.agentLessons[0]).toEqual({ ...existing, refutationCount: 2, updatedAt: NOW })
  })

  it('adds a new candidate with no target as its own artifact', () => {
    const next = apply(record(), [{ kind: 'new', candidate: candidate('  Prefers Terse Answers  ') }])
    expect(next.agentLessons).toHaveLength(1)
    expect(next.agentLessons[0]).toEqual({
      id: 'prefers terse answers',
      statement: '  Prefers Terse Answers  ',
      source: 's2',
      conditions: 'second',
      evidence: 'fact',
      confidence: 0.9,
      validationCount: 0,
      refutationCount: 0,
      scope: 'project',
      ttlDays: 30,
      createdAt: NOW,
      updatedAt: NOW,
    })
  })

  it('folds a new candidate into the target resolved for it', () => {
    const target = artifact('use postgres', { conditions: 'database work' })
    const overwritten = apply(
      record([target]),
      [{ kind: 'new', candidate: candidate('use postgres 15', { conditions: 'rechecked' }), strategy: 'overwrite' }],
      new Map([[0, target]]),
    )
    // The default ttl is assigned only to a candidate that becomes its own
    // artifact: a merge keeps the ttl the target already had, and drops it
    // when the candidate carries none and the target had none either.
    expect(overwritten.agentLessons).toEqual([{
      ...target,
      conditions: 'rechecked',
      source: 's2',
      evidence: 'fact',
      confidence: 0.9,
      updatedAt: NOW,
    }])

    const merged = apply(
      record([target]),
      [{ kind: 'new', candidate: candidate('use postgres 15', { conditions: 'rechecked', confidence: 0.4 }), strategy: 'merge' }],
      new Map([[0, target]]),
    )
    expect(merged.agentLessons).toEqual([{
      ...target,
      conditions: 'database work; rechecked',
      confidence: 0.6,
      updatedAt: NOW,
    }])
  })

  it('cannot tell a duplicate apart, so keep_both stores nothing', () => {
    const base = record([artifact('use postgres')])
    const sameIdentity = apply(base, [{ kind: 'new', candidate: candidate('Use Postgres') }])
    expect(sameIdentity).toBe(base)
    // A resolved target changes nothing either: under keep_both the artifact
    // the candidate matches is left exactly as it was.
    const targeted = record([artifact('use postgres')])
    const withTarget = apply(
      targeted,
      [{ kind: 'new', candidate: candidate('Use Postgres'), strategy: 'keep_both' }],
      new Map([[0, artifact('use postgres')]]),
    )
    expect(withTarget).toBe(targeted)
  })

  it('falls back to the candidate identity when the resolved target is gone', () => {
    const base = record([artifact('unrelated fact')])
    const next = apply(
      base,
      [{ kind: 'new', candidate: candidate('use postgres 15'), strategy: 'overwrite' }],
      new Map([[0, artifact('vanished target')]]),
    )
    expect(next.agentLessons.map(entry => entry.statement)).toEqual(['unrelated fact', 'use postgres 15'])
  })

  it('applies a mixed batch in order against the record each earlier decision produced', () => {
    const existing = artifact('use postgres')
    const next = apply(
      record([existing]),
      [
        { kind: 'confirms', artifactId: existing.id },
        { kind: 'new', candidate: candidate('prefers terse answers') },
        { kind: 'contradicts', artifactId: existing.id, statement: 'use postgres 15' },
        // Confirms the artifact the `new` decision just inserted, which no
        // resolution against the pre-batch record could have named.
        { kind: 'confirms', artifactId: 'prefers terse answers' },
      ],
      new Map([[1, undefined]]),
    )
    expect(next.agentLessons).toEqual([
      {
        ...existing,
        statement: 'use postgres 15',
        validationCount: 3,
        refutationCount: 2,
        updatedAt: NOW,
      },
      {
        id: 'prefers terse answers',
        statement: 'prefers terse answers',
        source: 's2',
        conditions: 'second',
        evidence: 'fact',
        confidence: 0.9,
        validationCount: 1,
        refutationCount: 0,
        scope: 'project',
        ttlDays: 30,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ])
  })

  it('leaves an empty batch with the record it was given', () => {
    const base = record([artifact('use postgres')])
    expect(apply(base, [])).toBe(base)
  })

  it('refuses a candidate that cannot key an artifact', () => {
    expect(() => apply(record(), [{ kind: 'new', candidate: candidate('   ') }])).toThrow('is blank once normalized')
  })
})
