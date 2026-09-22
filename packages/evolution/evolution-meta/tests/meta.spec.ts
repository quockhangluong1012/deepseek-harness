import { describe, expect, it } from 'vitest'
import { configIdOf, ENGINE_COMPONENTS, recommendConfig, scoreOf, summarize, updatedSummary, workflowIdOf } from '../src/meta.ts'
import type { ConfigSummary, EngineConfig, EngineRun, WorkflowStep } from '../src/types.ts'

const config = (overrides: Partial<EngineConfig> = {}): EngineConfig => ({
  operators: 'portfolio-v1',
  evaluator: 'scorer-v1',
  budget: 'balanced-v1',
  routing: 'evidence-v1',
  ...overrides,
})

/** The four-stage sequence a run performs when it records one. */
const workflow: readonly WorkflowStep[] = [
  { component: 'operators', choice: 'portfolio-v1' },
  { component: 'evaluator', choice: 'scorer-v1' },
  { component: 'budget', choice: 'balanced-v1' },
  { component: 'routing', choice: 'evidence-v1' },
]

const run = (overrides: Partial<EngineRun> = {}): EngineRun => ({
  runId: 'r1',
  taskClass: 'writer',
  config: config(),
  workflow,
  pass: true,
  tokens: 5000,
  wallTimeMs: 60000,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const summary = (overrides: Partial<ConfigSummary> = {}): ConfigSummary => ({
  configId: configIdOf(config(), workflow),
  config: config(),
  workflow,
  workflowId: workflowIdOf(workflow),
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

describe('workflowIdOf', () => {
  it('names the stages in the order the run performed them', () => {
    expect(workflowIdOf(workflow)).toBe('operators=portfolio-v1>evaluator=scorer-v1>budget=balanced-v1>routing=evidence-v1')
    expect(workflowIdOf([...workflow].reverse())).toBe('routing=evidence-v1>budget=balanced-v1>evaluator=scorer-v1>operators=portfolio-v1')
    expect(workflowIdOf([])).toBe('')
  })
})

describe('configIdOf', () => {
  it('joins the four choices and the workflow deterministically', () => {
    expect(configIdOf(config(), workflow)).toBe(`portfolio-v1\0scorer-v1\0balanced-v1\0evidence-v1\0${workflowIdOf(workflow)}`)
    // Field order never matters: the identity follows the documented order.
    expect(configIdOf({ operators: 'a', evaluator: 'b', budget: 'c', routing: 'd' }, []))
      .toBe('a\0b\0c\0d\0')
  })

  it('separates the same components run in a different order', () => {
    expect(configIdOf(config(), workflow)).not.toBe(configIdOf(config(), [...workflow].reverse()))
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
    expect(row.configId).toBe(configIdOf(config(), workflow))
    expect(row.workflowId).toBe(workflowIdOf(workflow))
    expect(row.lastAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('carries the workflow of the folded runs', () => {
    const row = updatedSummary(undefined, run({ workflow: [] }), 3)
    expect(row).toMatchObject({ workflow: [] })
    expect(row.workflowId).toBe('')
    expect(row.configId).toBe('portfolio-v1\0scorer-v1\0balanced-v1\0evidence-v1\0')
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
    const writerDefault = rows2.find(row => row.taskClass === 'writer' && row.configId === configIdOf(config(), workflow))
    expect(writerDefault).toMatchObject({ samples: 2, passes: 2, passRate: 1 })
    const reader = rows2.find(row => row.taskClass === 'reader')
    expect(reader?.samples).toBe(1)
  })

  it('separates the same configuration run in two orders', () => {
    const rows = [
      run({ runId: 'forward' }),
      run({ runId: 'reverse', workflow: [...workflow].reverse() }),
    ]
    const rows2 = summarize(rows, 3)
    expect(rows2).toHaveLength(2)
    expect(rows2.map(row => row.workflowId).sort()).toEqual([
      'operators=portfolio-v1>evaluator=scorer-v1>budget=balanced-v1>routing=evidence-v1',
      'routing=evidence-v1>budget=balanced-v1>evaluator=scorer-v1>operators=portfolio-v1',
    ])
  })

  it('sorts each task class best configuration first with identity tie-break', () => {
    const rows = [
      run({ runId: 'a' }),
      run({ runId: 'b' }),
      run({ runId: 'c', config: config({ operators: 'portfolio-v2' }) }),
    ]
    const ranked = summarize(rows, 3)
    // The two-run default configuration outranks the one-run alternative.
    expect(ranked[0]?.configId).toBe(configIdOf(config(), workflow))
    expect(ranked[1]?.configId).toBe(configIdOf(config({ operators: 'portfolio-v2' }), workflow))
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
    expect(recommended?.workflow).toEqual(workflow)
    expect(recommended?.workflowId).toBe(workflowIdOf(workflow))
    expect(recommended?.reason).toContain('2/3 passed')
    expect(recommended?.reason).toContain('workflow operators=portfolio-v1>evaluator=scorer-v1>budget=balanced-v1>routing=evidence-v1')
  })

  it('says so when the winning runs recorded no sequence', () => {
    const summaries = [summary({ workflow: [], workflowId: '' })]
    expect(recommendConfig(summaries, 'writer', 3)?.reason).toContain('workflow unrecorded')
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
