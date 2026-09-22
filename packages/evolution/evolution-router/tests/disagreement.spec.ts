import { describe, expect, it } from 'vitest'
import { routeDisagreement, routeDisagreements } from '../src/disagreement.ts'
import type { RouteEffectiveness } from '../src/types.ts'

const effectiveness = (overrides: Partial<RouteEffectiveness> & { provider: string; model: string }): RouteEffectiveness => ({
  taskClass: 'writer',
  role: 'evaluation',
  samples: 4,
  passes: 3,
  passRate: 0.75,
  meanTokens: 1000,
  meanWallTimeMs: 2000,
  lastAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const rate = (
  provider: string,
  model: string,
  passRate: number,
  extra: Partial<RouteEffectiveness> = {},
) => effectiveness({ provider, model, passRate, passes: Math.round(passRate * (extra.samples ?? 4)), ...extra })

describe('routeDisagreement', () => {
  it('names the two most divergent routes of a task class and role', () => {
    const rows = [rate('deepseek', 'chat', 0.9), rate('deepseek', 'reasoner', 0.2), rate('deepseek', 'middle', 0.5)]
    expect(routeDisagreement(rows, 'writer', 'evaluation', 3, 0.5)).toEqual({
      taskClass: 'writer',
      role: 'evaluation',
      leader: { provider: 'deepseek', model: 'chat' },
      trailer: { provider: 'deepseek', model: 'reasoner' },
      leaderPassRate: 0.9,
      trailerPassRate: 0.2,
      gap: 0.7,
      samples: [4, 4],
      detail: "routes 'deepseek/chat' (0.90 over 4 runs) and 'deepseek/reasoner' (0.20 over 4 runs) disagree by 0.70 on 'writer' in role evaluation",
    })
  })

  it('reports no disagreement while the routes agree or sit inside the threshold', () => {
    const agreeing = [rate('a', 'm1', 0.5), rate('a', 'm2', 0.5), rate('a', 'm3', 0.55)]
    // Equal rates: the gap is zero.
    expect(routeDisagreement(agreeing, 'writer', 'evaluation', 1, 0.1)).toBeUndefined()
    // A gap below the threshold is agreement, not disagreement.
    expect(routeDisagreement([rate('a', 'm1', 0.6), rate('a', 'm2', 0.5)], 'writer', 'evaluation', 1, 0.5)).toBeUndefined()
    // One measured route cannot disagree with itself.
    expect(routeDisagreement([rate('a', 'm1', 1)], 'writer', 'evaluation', 1, 0.5)).toBeUndefined()
  })

  it('ignores routes measured below the run minimum and other task classes or roles', () => {
    const rows = [
      rate('a', 'm1', 1, { samples: 2 }),
      rate('a', 'm2', 0, { samples: 5 }),
      rate('b', 'm3', 0.9, { samples: 5, role: 'candidate-generation' }),
      effectiveness({ provider: 'c', model: 'm4', taskClass: 'reader', passRate: 0, samples: 5 }),
    ]
    expect(routeDisagreement(rows, 'reader', 'evaluation', 3, 0.5)).toBeUndefined()
    expect(routeDisagreement(rows, 'writer', 'evaluation', 3, 0.5)).toBeUndefined()
    // Lowering the run minimum measures 'a/m1' too, and the pair diverges completely.
    expect(routeDisagreement(rows, 'writer', 'evaluation', 2, 0.5)).toMatchObject({
      leader: { provider: 'a', model: 'm1' },
      trailer: { provider: 'a', model: 'm2' },
      gap: 1,
    })
  })
})

describe('routeDisagreements', () => {
  it('reports one disagreement per task class and role, strongest gap first', () => {
    const rows = [
      rate('a', 'm1', 1),
      rate('a', 'm2', 0.25),
      rate('b', 'm1', 0.5),
      rate('b', 'm2', 0.5),
      rate('c', 'm1', 0, { role: 'reflection' }),
      rate('c', 'm2', 0.9, { role: 'reflection' }),
      // A route below the run minimum never joins a comparison.
      rate('e', 'm1', 0, { samples: 1 }),
      effectiveness({ provider: 'd', model: 'm1', taskClass: 'reader', passRate: 1, samples: 5 }),
      effectiveness({ provider: 'd', model: 'm2', taskClass: 'reader', passRate: 0, samples: 5 }),
      rate('f', 'm1', 1, { taskClass: 'planner' }),
      rate('f', 'm2', 0, { taskClass: 'planner' }),
    ]
    expect(routeDisagreements(rows, 3, 0.5).map(found => `${found.taskClass}/${found.role}:${found.gap}`)).toEqual([
      'planner/evaluation:1',
      'reader/evaluation:1',
      'writer/reflection:0.9',
      'writer/evaluation:0.75',
    ])
  })

  it('reports nothing when every measured pair agrees', () => {
    expect(routeDisagreements([rate('a', 'm1', 0.5), rate('a', 'm2', 0.5)], 3, 0.5)).toEqual([])
    expect(routeDisagreements([], 3, 0.5)).toEqual([])
  })
})
