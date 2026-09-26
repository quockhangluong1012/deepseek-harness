import { describe, expect, it } from 'vitest'
import {
  assignmentKey,
  effectivenessKey,
  effectivenessRows,
  EVOLUTION_ROLES,
  mergeEvidence,
  rankRoutes,
  roleConflicts,
  routeKey,
  scoreOf,
  updatedEffectiveness,
} from '../src/routes.ts'
import type { EvolutionRole, RouteEffectiveness, RouteEvidence, RouteRow } from '../src/types.ts'

const row = (overrides: Partial<RouteRow> & { role: EvolutionRole; provider: string; model: string }): RouteRow => ({
  origin: 'observed',
  at: '2026-09-12T00:00:00.000Z',
  ...overrides,
})

const evidence = (
  overrides: Partial<RouteEvidence> & { id: string; role: EvolutionRole; provider: string; model: string },
): RouteEvidence => ({
  pass: true,
  tokens: 10,
  wallTimeMs: 100,
  at: '2026-09-12T00:00:00.000Z',
  ...overrides,
})

const effectiveness = (overrides: Partial<RouteEffectiveness> & { provider: string; model: string }): RouteEffectiveness => ({
  taskClass: 'writer',
  role: 'evaluation',
  origin: 'observed',
  runs: 4,
  passes: 3,
  passRate: 0.75,
  meanTokens: 1000,
  meanWallTimeMs: 2000,
  lastAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('routeKey', () => {
  it('joins provider and model with a separator that cannot appear in either', () => {
    expect(routeKey({ provider: 'deepseek', model: 'deepseek-chat' })).toBe('deepseek\0deepseek-chat')
    expect(routeKey({ provider: 'p', model: 'm' })).not.toEqual('p\0m\0')
  })
})

describe('assignmentKey and effectivenessKey', () => {
  it('compose the one route identity rather than repeating it', () => {
    expect(assignmentKey('evaluation', { provider: 'p', model: 'm' })).toBe('evaluation\0p\0m')
    expect(effectivenessKey('writer', 'evaluation', { provider: 'p', model: 'm' })).toBe('writer\0evaluation\0p\0m')
  })
})

describe('EVOLUTION_ROLES', () => {
  it('lists the five evolutionary roles in order', () => {
    expect(EVOLUTION_ROLES).toEqual([
      'task-execution',
      'reflection',
      'candidate-generation',
      'evaluation',
      'promotion-review',
    ])
  })
})

describe('mergeEvidence', () => {
  const rows = [
    row({ role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat' }),
    row({ role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-reasoner', origin: 'pinned' }),
    row({ role: 'evaluation', provider: 'deepseek', model: 'deepseek-chat' }),
  ]
  const evidenceRows = [
    evidence({ id: 'e1', role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat', pass: true, tokens: 10, at: '2026-09-12T00:00:00.000Z' }),
    evidence({ id: 'e2', role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat', pass: false, tokens: 20, at: '2026-09-13T00:00:00.000Z' }),
    evidence({ id: 'e3', role: 'evaluation', provider: 'deepseek', model: 'deepseek-chat', pass: true, tokens: 5 }),
  ]

  it('aggregates runs, passes, means, and the newest instant per route of the role', () => {
    const summaries = mergeEvidence(rows, evidenceRows, 'candidate-generation')
    expect(summaries).toEqual([
      { role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat', origin: 'observed', runs: 2, passes: 1, passRate: 0.5, meanTokens: 15, meanWallTimeMs: 100, lastAt: '2026-09-13T00:00:00.000Z' },
      { role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-reasoner', origin: 'pinned', runs: 0, passes: 0, passRate: 0, meanTokens: 0, meanWallTimeMs: 0, lastAt: null },
    ])
  })

  it('ignores evidence of other roles and orders by provider then model', () => {
    const summaries = mergeEvidence(rows, evidenceRows, 'evaluation')
    expect(summaries).toEqual([
      { role: 'evaluation', provider: 'deepseek', model: 'deepseek-chat', origin: 'observed', runs: 1, passes: 1, passRate: 1, meanTokens: 5, meanWallTimeMs: 100, lastAt: '2026-09-12T00:00:00.000Z' },
    ])
    expect(mergeEvidence(rows, evidenceRows, 'reflection')).toEqual([])
  })

  it('keeps the newest instant and a monotonic pass share across equal instants', () => {
    const sameAt = [
      evidence({ id: 'a', role: 'evaluation', provider: 'p', model: 'm', pass: true, at: '2026-09-12T00:00:00.000Z' }),
      evidence({ id: 'b', role: 'evaluation', provider: 'p', model: 'm', pass: false, at: '2026-09-12T00:00:00.000Z' }),
    ]
    const [summary] = mergeEvidence([row({ role: 'evaluation', provider: 'p', model: 'm' })], sameAt, 'evaluation')
    expect(summary).toMatchObject({ runs: 2, passes: 1, passRate: 0.5, lastAt: '2026-09-12T00:00:00.000Z' })
  })
})

describe('effectivenessRows', () => {
  const rows = [
    row({ role: 'evaluation', provider: 'deepseek', model: 'chat', origin: 'pinned' }),
    row({ role: 'evaluation', provider: 'openai', model: 'gpt' }),
  ]
  const outcomes = [
    evidence({ id: 'e1', role: 'evaluation', provider: 'deepseek', model: 'chat', pass: true, tokens: 1000, wallTimeMs: 2000, taskClass: 'writer' }),
    evidence({ id: 'e2', role: 'evaluation', provider: 'deepseek', model: 'chat', pass: false, tokens: 3000, wallTimeMs: 6000, taskClass: 'writer' }),
    evidence({ id: 'e3', role: 'evaluation', provider: 'openai', model: 'gpt', taskClass: 'reader' }),
    evidence({ id: 'e4', role: 'evaluation', provider: 'openai', model: 'gpt' }),
  ]

  it('groups by task class, role, and route with running means and the assignment origin', () => {
    const derived = effectivenessRows(outcomes, rows, {})
    expect(derived).toEqual([
      { taskClass: 'reader', role: 'evaluation', provider: 'openai', model: 'gpt', origin: 'observed', runs: 1, passes: 1, passRate: 1, meanTokens: 10, meanWallTimeMs: 100, lastAt: '2026-09-12T00:00:00.000Z' },
      { taskClass: 'writer', role: 'evaluation', provider: 'deepseek', model: 'chat', origin: 'pinned', runs: 2, passes: 1, passRate: 0.5, meanTokens: 2000, meanWallTimeMs: 4000, lastAt: '2026-09-12T00:00:00.000Z' },
    ])
  })

  it('leaves an outcome recorded without a task class to the per-role summary', () => {
    // 'e4' is the same route as the class-scoped 'e3' with no task class, so a
    // per-class reading counts that route exactly once and the role-wide run
    // reaches no class row at all.
    expect(effectivenessRows(outcomes, rows, {}).filter(entry => entry.provider === 'openai')).toHaveLength(1)
    expect(mergeEvidence(rows, outcomes, 'evaluation')
      .filter(summary => summary.provider === 'openai'))
      .toMatchObject([{ runs: 2, passes: 2 }])
  })

  it('filters by task class and role', () => {
    expect(effectivenessRows(outcomes, rows, { taskClass: 'writer' })).toHaveLength(1)
    expect(effectivenessRows(outcomes, rows, { role: 'reflection' })).toEqual([])
    expect(effectivenessRows(outcomes, rows, { taskClass: 'ghost' })).toEqual([])
  })
})

describe('scoreOf', () => {
  it('smooths the pass rate and scales by run confidence', () => {
    // (3 + 1) / (4 + 2) = 0.667, confidence min(1, 4/3) = 1.
    expect(scoreOf(3, 4, 3)).toBeCloseTo(2 / 3, 10)
    // One run at minimum 3 gets one third of the confidence.
    expect(scoreOf(1, 1, 3)).toBeCloseTo((2 / 3) * (1 / 3), 10)
  })
})

describe('updatedEffectiveness', () => {
  const outcome = evidence({ id: 'e1', role: 'evaluation', provider: 'deepseek', model: 'chat', taskClass: 'writer', tokens: 1000, wallTimeMs: 2000 })

  it('creates the first effectiveness row from one outcome', () => {
    const row2 = updatedEffectiveness(undefined, outcome, 'writer', 'observed')
    expect(row2).toMatchObject({
      taskClass: 'writer',
      role: 'evaluation',
      provider: 'deepseek',
      model: 'chat',
      origin: 'observed',
      runs: 1,
      passes: 1,
      passRate: 1,
      meanTokens: 1000,
      meanWallTimeMs: 2000,
    })
    expect(row2.lastAt).toBe('2026-09-12T00:00:00.000Z')
  })

  it('keeps running means and pass rates exact', () => {
    const first = updatedEffectiveness(undefined, outcome, 'writer', 'observed')
    const second = updatedEffectiveness(
      first,
      evidence({ id: 'e2', role: 'evaluation', provider: 'deepseek', model: 'chat', taskClass: 'writer', pass: false, tokens: 3000, wallTimeMs: 6000 }),
      'writer',
      'observed',
    )
    expect(second).toMatchObject({ runs: 2, passes: 1, passRate: 0.5, meanTokens: 2000, meanWallTimeMs: 4000 })
  })
})

describe('rankRoutes', () => {
  it('ranks by score with provider/model tie-break', () => {
    const rows = [
      effectiveness({ provider: 'b', model: 'm' }),
      effectiveness({ provider: 'a', model: 'm', runs: 4, passes: 4, passRate: 1 }),
      effectiveness({ provider: 'c', model: 'm' }),
    ]
    // The 'a' route with a perfect pass rate outranks; equal-score routes break
    // by provider ascending.
    const ranked = rankRoutes(rows, 3)
    expect(ranked[0]?.provider).toBe('a')
    expect(ranked[1]?.provider).toBe('b')
    expect(ranked[2]?.provider).toBe('c')
    // Two equal-scoring routes of one provider break by model ascending.
    const sameProvider = rankRoutes([
      effectiveness({ provider: 'a', model: 'chat' }),
      effectiveness({ provider: 'a', model: 'reasoner' }),
    ], 3)
    expect(sameProvider.map(entry => entry.model)).toEqual(['chat', 'reasoner'])
  })

  it('carries the assignment origin and names the numbers in the reason', () => {
    const [entry] = rankRoutes([effectiveness({ provider: 'a', model: 'm', origin: 'pinned' })], 3)
    expect(entry?.origin).toBe('pinned')
    expect(entry?.reason).toContain('3/4 passed')
    expect(entry?.reason).toContain('0.75')
    expect(entry?.reason).toContain('1000 mean tokens')
    expect(entry?.reason).toContain('pinned by an operator')
    expect(rankRoutes([], 3)).toEqual([])
  })
})

describe('roleConflicts', () => {
  it('reports a route that both produces work and judges it, in topology order', () => {
    const rules = [
      row({ role: 'evaluation', provider: 'deepseek', model: 'chat' }),
      row({ role: 'candidate-generation', provider: 'deepseek', model: 'chat', origin: 'pinned' }),
      row({ role: 'reflection', provider: 'deepseek', model: 'chat' }),
      row({ role: 'promotion-review', provider: 'deepseek', model: 'reasoner' }),
    ]
    expect(roleConflicts(rules)).toEqual([{
      route: { provider: 'deepseek', model: 'chat' },
      producing: ['reflection', 'candidate-generation'],
      judging: ['evaluation'],
      pinned: true,
      detail: "route 'deepseek/chat' serves reflection, candidate-generation and also judges evaluation",
    }])
  })

  it('reports nothing while every route stays on one side of the topology', () => {
    const producingOnly = [
      row({ role: 'task-execution', provider: 'a', model: 'fast' }),
      row({ role: 'reflection', provider: 'a', model: 'cheap' }),
    ]
    const judgingOnly = [
      row({ role: 'task-execution', provider: 'a', model: 'fast' }),
      row({ role: 'evaluation', provider: 'b', model: 'judge' }),
      row({ role: 'promotion-review', provider: 'c', model: 'strongest' }),
    ]
    expect(roleConflicts(producingOnly)).toEqual([])
    expect(roleConflicts(judgingOnly)).toEqual([])
    expect(roleConflicts([])).toEqual([])
  })

  it('lists every conflicting route in provider then model order', () => {
    const rules = [
      row({ role: 'candidate-generation', provider: 'b', model: 'm' }),
      row({ role: 'evaluation', provider: 'b', model: 'm' }),
      row({ role: 'task-execution', provider: 'a', model: 'z' }),
      row({ role: 'promotion-review', provider: 'a', model: 'z' }),
      row({ role: 'reflection', provider: 'a', model: 'm' }),
      row({ role: 'evaluation', provider: 'a', model: 'm' }),
    ]
    expect(roleConflicts(rules).map(conflict => `${conflict.route.provider}/${conflict.route.model}`))
      .toEqual(['a/m', 'a/z', 'b/m'])
    expect(roleConflicts(rules).map(conflict => conflict.judging)).toEqual([['evaluation'], ['promotion-review'], ['evaluation']])
  })
})
