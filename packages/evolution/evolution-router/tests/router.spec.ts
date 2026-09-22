import { describe, expect, it } from 'vitest'
import { rankRoutes, recommendRoute, ROUTING_ROLES, routeKey, scoreOf, updatedEffectiveness } from '../src/router.ts'
import type { RouteEffectiveness, RouteOutcome } from '../src/types.ts'

const outcome = (overrides: Partial<RouteOutcome> = {}): RouteOutcome => ({
  taskClass: 'writer',
  role: 'evaluation',
  provider: 'deepseek',
  model: 'chat',
  pass: true,
  tokens: 1000,
  wallTimeMs: 2000,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const effectiveness = (overrides: Partial<RouteEffectiveness> = {}): RouteEffectiveness => ({
  taskClass: 'writer',
  role: 'evaluation',
  provider: 'deepseek',
  model: 'chat',
  samples: 4,
  passes: 3,
  passRate: 0.75,
  meanTokens: 1000,
  meanWallTimeMs: 2000,
  lastAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('ROUTING_ROLES', () => {
  it('lists the five evolutionary roles in order', () => {
    expect([...ROUTING_ROLES]).toEqual([
      'task-execution',
      'reflection',
      'candidate-generation',
      'evaluation',
      'promotion-review',
    ])
  })
})

describe('routeKey', () => {
  it('joins task class, role, and route with separators', () => {
    expect(routeKey('writer', 'evaluation', 'deepseek', 'chat')).toBe('writer\0evaluation\0deepseek\0chat')
  })
})

describe('scoreOf', () => {
  it('smooths the pass rate and scales by sample confidence', () => {
    // (3 + 1) / (4 + 2) = 0.667, confidence min(1, 4/3) = 1.
    expect(scoreOf(3, 4, 3)).toBeCloseTo(2 / 3, 10)
    // One sample at minimum 3 gets one third of the confidence.
    expect(scoreOf(1, 1, 3)).toBeCloseTo((2 / 3) * (1 / 3), 10)
  })
})

describe('updatedEffectiveness', () => {
  it('creates the first effectiveness row from one outcome', () => {
    const row = updatedEffectiveness(undefined, outcome())
    expect(row).toMatchObject({
      taskClass: 'writer',
      role: 'evaluation',
      provider: 'deepseek',
      model: 'chat',
      samples: 1,
      passes: 1,
      passRate: 1,
      meanTokens: 1000,
      meanWallTimeMs: 2000,
    })
    expect(row.lastAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('keeps running means and pass rates exact', () => {
    let row = updatedEffectiveness(undefined, outcome())
    row = updatedEffectiveness(row, outcome({ pass: false, tokens: 3000, wallTimeMs: 6000 }))
    expect(row).toMatchObject({ samples: 2, passes: 1, passRate: 0.5, meanTokens: 2000, meanWallTimeMs: 4000 })
  })
})

describe('rankRoutes', () => {
  it('ranks the task class and role by score with provider/model tie-break', () => {
    const rows = [
      effectiveness({ provider: 'b', model: 'm' }),
      effectiveness({ provider: 'a', model: 'm', samples: 4, passes: 4, passRate: 1 }),
      effectiveness({ provider: 'c', model: 'm' }),
    ]
    // The 'a' route with a perfect pass rate outranks; equal-score routes break
    // by provider ascending.
    const ranked = rankRoutes(rows, 'writer', 'evaluation', 3)
    expect(ranked[0]?.provider).toBe('a')
    expect(ranked[1]?.provider).toBe('b')
    expect(ranked[2]?.provider).toBe('c')
  })

  it('ignores other task classes and roles', () => {
    const rows = [
      effectiveness(),
      effectiveness({ taskClass: 'reader' }),
      effectiveness({ role: 'reflection' }),
    ]
    expect(rankRoutes(rows, 'writer', 'evaluation', 3)).toHaveLength(1)
    expect(rankRoutes([], 'writer', 'evaluation', 3)).toEqual([])
  })

  it('names the numbers in the reason', () => {
    const ranked = rankRoutes([effectiveness({ samples: 4, passes: 3, passRate: 0.75, meanTokens: 1000, meanWallTimeMs: 2000 })], 'writer', 'evaluation', 3)
    expect(ranked[0]?.reason).toContain('3/4 passed')
    expect(ranked[0]?.reason).toContain('0.75')
    expect(ranked[0]?.reason).toContain('1000 mean tokens')
  })
})

describe('recommendRoute', () => {
  it('returns the best-ranked route with enough outcomes', () => {
    const ranked = rankRoutes([
      effectiveness({ provider: 'a', samples: 3, passes: 2, passRate: 2 / 3 }),
      effectiveness({ provider: 'b', samples: 1, passes: 1, passRate: 1 }),
    ], 'writer', 'evaluation', 3)
    expect(recommendRoute(ranked, 3)?.provider).toBe('a')
  })

  it('yields undefined while no route has enough outcomes', () => {
    const ranked = rankRoutes([effectiveness({ samples: 2 })], 'writer', 'evaluation', 3)
    expect(recommendRoute(ranked, 3)).toBeUndefined()
    expect(recommendRoute([], 3)).toBeUndefined()
  })
})