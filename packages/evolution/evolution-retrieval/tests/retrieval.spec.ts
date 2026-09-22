import { describe, expect, it } from 'vitest'
import {
  configurationKey,
  effectivenessRows,
  gradesOf,
  rankConfigurations,
  recommendConfiguration,
  scoreOf,
  updatedEffectiveness,
} from '../src/index.ts'
import type {
  RetrievalAttribution,
  RetrievalConfiguration,
  RetrievalEffectiveness,
  SessionGrade,
  SkillEvidenceEntry,
} from '../src/index.ts'

const configuration = (overrides: Partial<RetrievalConfiguration> = {}): RetrievalConfiguration => ({
  source: 'hybrid',
  queryExpansion: 'graph-entities',
  weights: { vector: 1, graph: 1 },
  reranker: 'none',
  mmr: { enabled: false, lambda: 1 },
  memoryScope: 'workspace',
  graphDepth: 1,
  threshold: 0.7,
  ...overrides,
})

const attribution = (overrides: Partial<RetrievalAttribution> = {}): RetrievalAttribution => ({
  configKey: 'a',
  configuration: configuration(),
  sessionId: 's1',
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const grade = (overrides: Partial<SessionGrade> = {}): SessionGrade => ({
  sessionId: 's1',
  taskClass: 'writer',
  outcome: 'ok',
  ...overrides,
})

const effectiveness = (overrides: Partial<RetrievalEffectiveness> = {}): RetrievalEffectiveness => ({
  configKey: 'a',
  configuration: configuration(),
  taskClass: 'writer',
  samples: 5,
  passes: 5,
  successRate: 1,
  lastAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const skill = (usage: Partial<SkillEvidenceEntry['usage']> = {}, name = 'writer'): SkillEvidenceEntry => ({
  name,
  usage: { sessionIds: [], sessionOutcomes: [], ...usage },
})

describe('retrieval configuration key', () => {
  it('names one configuration whatever order its fields were built in', () => {
    const reordered: RetrievalConfiguration = {
      threshold: 0.7,
      graphDepth: 1,
      memoryScope: 'workspace',
      mmr: { lambda: 1, enabled: false },
      reranker: 'none',
      weights: { graph: 1, vector: 1 },
      queryExpansion: 'graph-entities',
      source: 'hybrid',
    }
    expect(configurationKey(reordered)).toBe(configurationKey(configuration()))
  })

  it('separates configurations that differ in any dimension', () => {
    const keys = new Set([
      configurationKey(configuration()),
      configurationKey(configuration({ source: 'graph' })),
      configurationKey(configuration({ queryExpansion: 'none' })),
      configurationKey(configuration({ weights: { vector: 2, graph: 1 } })),
      configurationKey(configuration({ weights: { vector: 1, graph: 2 } })),
      configurationKey(configuration({ reranker: 'cross-encoder' })),
      configurationKey(configuration({ mmr: { enabled: true, lambda: 1 } })),
      configurationKey(configuration({ mmr: { enabled: false, lambda: 0.5 } })),
      configurationKey(configuration({ memoryScope: 'session' })),
      configurationKey(configuration({ graphDepth: 2 })),
      configurationKey(configuration({ threshold: 0.5 })),
    ])
    expect(keys.size).toBe(11)
  })
})

describe('session grading from the evidence stores', () => {
  it('takes a graded skill outcome as that session and class outcome', () => {
    const grades = gradesOf(
      ['s1', 's2'],
      [skill({ sessionIds: ['s1', 's2'], sessionOutcomes: [
        { sessionId: 's1', outcome: 'failed' },
        { sessionId: 's2', outcome: 'ok' },
      ] })],
      new Set(),
    )
    expect(grades).toEqual([
      { sessionId: 's1', taskClass: 'writer', outcome: 'failed' },
      { sessionId: 's2', taskClass: 'writer', outcome: 'ok' },
    ])
  })

  it('fails a session on the classes it loaded when the feedback store attributed a failure', () => {
    const grades = gradesOf(
      ['s1', 's2'],
      [skill({ sessionIds: ['s1', 's2'] })],
      new Set(['s2']),
    )
    expect(grades).toEqual([{ sessionId: 's2', taskClass: 'writer', outcome: 'failed' }])
  })

  it('counts a session once and grades each class separately', () => {
    const grades = gradesOf(
      ['s1', 's1'],
      [skill({ sessionIds: ['s1'] }), skill({ sessionOutcomes: [{ sessionId: 's1', outcome: 'ok' }] }, 'polish')],
      new Set(),
    )
    expect(grades).toEqual([{ sessionId: 's1', taskClass: 'polish', outcome: 'ok' }])
  })
})

describe('effectiveness', () => {
  it('folds grades into running success rates with the newest attribution instant', () => {
    const first = updatedEffectiveness(undefined, attribution({ at: '2026-01-01T00:00:00.000Z' }), grade())
    expect(first).toMatchObject({ samples: 1, passes: 1, successRate: 1, lastAt: '2026-01-01T00:00:00.000Z' })
    const second = updatedEffectiveness(first, attribution({ at: '2026-01-02T00:00:00.000Z' }), grade({ outcome: 'failed' }))
    expect(second).toMatchObject({ samples: 2, passes: 1, successRate: 0.5, lastAt: '2026-01-02T00:00:00.000Z' })
    const older = updatedEffectiveness(second, attribution({ at: '2025-12-31T00:00:00.000Z' }), grade())
    expect(older).toMatchObject({ samples: 3, passes: 2, lastAt: '2026-01-02T00:00:00.000Z' })
  })

  it('groups one row per configuration and class, in class then key order', () => {
    const rows = effectivenessRows(
      [
        attribution({ configKey: 'b', sessionId: 's1' }),
        attribution({ configKey: 'a', sessionId: 's1' }),
        attribution({ configKey: 'a', sessionId: 's2' }),
      ],
      [
        grade(),
        grade({ taskClass: 'polish', outcome: 'failed' }),
        grade({ sessionId: 's2', taskClass: 'polish', outcome: 'failed' }),
      ],
    )
    expect(rows.map(row => `${row.configKey}/${row.taskClass}:${row.passes}/${row.samples}`))
      .toEqual(['a/polish:0/2', 'b/polish:0/1', 'a/writer:1/1', 'b/writer:1/1'])
  })

  it('attributes one session to every configuration that served it, and drops ungraded sessions', () => {
    const rows = effectivenessRows(
      [
        attribution({ configKey: 'a', sessionId: 's1' }),
        attribution({ configKey: 'b', sessionId: 's1' }),
        attribution({ configKey: 'c', sessionId: 's9' }),
      ],
      [grade()],
    )
    expect(rows.map(row => `${row.configKey}:${row.samples}`)).toEqual(['a:1', 'b:1'])
  })

  it('scores a smoothed rate scaled by sample confidence', () => {
    expect(scoreOf(0, 0, 5)).toBe(0)
    expect(scoreOf(1, 1, 5)).toBeCloseTo((2 / 3) * 0.2)
    expect(scoreOf(5, 5, 5)).toBeCloseTo(6 / 7)
    // A lucky single session cannot outrank a measured configuration.
    expect(scoreOf(5, 5, 5)).toBeGreaterThan(scoreOf(1, 1, 5))
  })
})

describe('ranking and recommendation', () => {
  it('ranks one class by score, ties by key, and recommends only above the evidence gate', () => {
    const rows = [
      effectiveness({ configKey: 'good', samples: 5, passes: 5, successRate: 1 }),
      effectiveness({ configKey: 'poor', samples: 5, passes: 1, successRate: 0.2 }),
      effectiveness({ configKey: 'thin', samples: 1, passes: 1, successRate: 1 }),
      effectiveness({ configKey: 'other', taskClass: 'reader', samples: 9, passes: 9 }),
    ]
    const ranked = rankConfigurations(rows, 'writer', 5)
    expect(ranked.map(entry => entry.configKey)).toEqual(['good', 'poor', 'thin'])
    expect(ranked[0]?.reason).toBe('5/5 graded sessions succeeded (1.00), score 0.857')
    expect(recommendConfiguration(ranked, 5)?.configKey).toBe('good')
    expect(recommendConfiguration(rankConfigurations(rows.filter(row => row.configKey === 'thin'), 'writer', 5), 5))
      .toBeUndefined()
    const tied = rankConfigurations([
      effectiveness({ configKey: 'b' }),
      effectiveness({ configKey: 'a' }),
    ], 'writer', 5)
    expect(tied.map(entry => entry.configKey)).toEqual(['a', 'b'])
  })
})
