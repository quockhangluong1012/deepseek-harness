import { describe, expect, it } from 'vitest'
import { configIdOf, ENGINE_COMPONENTS, recommendConfig, scoreOf, summarize, updatedSummary } from '../src/meta.ts'
import type { ConfigSummary, EngineConfig, EngineRun } from '../src/types.ts'

const config = (overrides: Partial<EngineConfig> = {}): EngineConfig => ({
  operators: 'portfolio-v1',
  evaluator: 'scorer-v1',
  budget: 'balanced-v1',
  routing: 'evidence-v1',
  ...overrides,
})

const run = (overrides: Partial<EngineRun> = {}): EngineRun => ({
  runId: 'r1',
  taskClass: 'writer',
  config: config(),
  pass: true,
  tokens: 5000,
  wallTimeMs: 60000,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const summary = (overrides: Partial<ConfigSummary> = {}): ConfigSummary => ({
  configId: 'portfolio-v1\0scorer-v1\0balanced-v1\0evidence-v1',
  config: config(),
  taskClass: 'writer',
  samples: 4,
  passes: 3,
  passRate: 0.75,
  meanTokens: 5000,
  score: scoreOf(3, 4, 3),
  lastAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('ENGINE_COMPONENTS', () => {
  it('lists the four engine components in order', () => {
    expect([...ENGINE_COMPONENTS]).toEqual(['operators', 'evaluator', 'budget', 'routing'])
  })
})

describe('configIdOf', () => {
  it('joins the four choices deterministically', () => {
    expect(configIdOf(config())).toBe('portfolio-v1\0scorer-v1\0balanced-v1\0evidence-v1')
    // Field order never matters: the identity follows the documented order.
    expect(configIdOf({ operators: 'a', evaluator: 'b', budget: 'c', routing: 'd' }))
      .toBe('a\0b\0c\0d')
  })
})

describe('scoreOf', () => {
  it('smooths the pass rate and scales by sample confidence', () => {
    expect(scoreOf(3, 4, 3)).toBeCloseTo(2 / 3, 10)
    expect(scoreOf(1, 1, 3)).toBeCloseTo((2 / 3) * (1 / 3), 10)
  })
})

describe('updatedSummary', () => {
  it('creates the first summary from one run', () => {
    const row = updatedSummary(undefined, run(), 3)
    expect(row).toMatchObject({
      taskClass: 'writer',
      samples: 1,
      passes: 1,
      passRate: 1,
      meanTokens: 5000,
    })
    expect(row.configId).toBe('portfolio-v1\0scorer-v1\0balanced-v1\0evidence-v1')
    expect(row.lastAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('keeps running pass rates and mean tokens exact', () => {
    let row = updatedSummary(undefined, run(), 3)
    row = updatedSummary(row, run({ pass: false, tokens: 15000 }), 3)
    expect(row).toMatchObject({ samples: 2, passes: 1, passRate: 0.5, meanTokens: 10000 })
  })
})

describe('summarize', () => {
  it('groups runs by task class and configuration identity', () => {
    const rows = [
      run(),
      run({ runId: 'r2' }),
      run({ runId: 'r3', config: config({ operators: 'portfolio-v2' }) }),
      run({ runId: 'r4', taskClass: 'reader' }),
    ]
    const rows2 = summarize(rows, 3)
    expect(rows2).toHaveLength(3)
    const writerDefault = rows2.find(row => row.taskClass === 'writer' && row.configId === configIdOf(config()))
    expect(writerDefault).toMatchObject({ samples: 2, passes: 2, passRate: 1 })
    const reader = rows2.find(row => row.taskClass === 'reader')
    expect(reader?.samples).toBe(1)
  })

  it('sorts each task class best configuration first with identity tie-break', () => {
    const rows = [
      run({ runId: 'a' }),
      run({ runId: 'b' }),
      run({ runId: 'c', config: config({ operators: 'portfolio-v2' }) }),
    ]
    const ranked = summarize(rows, 3)
    // The two-run default configuration outranks the one-run alternative.
    expect(ranked[0]?.configId).toBe(configIdOf(config()))
    expect(ranked[1]?.configId).toBe(configIdOf(config({ operators: 'portfolio-v2' })))
  })
})

describe('recommendConfig', () => {
  it('returns the best-scored configuration with enough runs', () => {
    const summaries = [
      summary({ configId: 'a', samples: 1, passes: 1, passRate: 1, score: scoreOf(1, 1, 3) }),
      summary({ configId: 'b', samples: 3, passes: 2, passRate: 2 / 3, score: scoreOf(2, 3, 3) }),
    ]
    const recommended = recommendConfig(summaries, 'writer', 3)
    expect(recommended?.configId).toBe('b')
    expect(recommended?.reason).toContain('2/3 passed')
  })

  it('yields undefined while no configuration has enough runs', () => {
    const summaries = [summary({ samples: 2, score: scoreOf(2, 2, 3) })]
    expect(recommendConfig(summaries, 'writer', 3)).toBeUndefined()
    expect(recommendConfig([], 'writer', 3)).toBeUndefined()
  })

  it('ignores other task classes', () => {
    const summaries = [summary({ samples: 4, score: scoreOf(4, 4, 3) })]
    expect(recommendConfig(summaries, 'reader', 3)).toBeUndefined()
  })
})