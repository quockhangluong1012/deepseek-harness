import { describe, expect, it } from 'vitest'
import { bestRoute, EVOLUTION_ROLES, mergeEvidence, routeKey } from '../src/routes.ts'
import type { EvolutionRole, RouteEvidence, RouteRow, RouteSummary } from '../src/types.ts'

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

describe('routeKey', () => {
  it('joins provider and model with a separator that cannot appear in either', () => {
    expect(routeKey({ provider: 'deepseek', model: 'deepseek-chat' })).toBe('deepseek\0deepseek-chat')
    expect(routeKey({ provider: 'p', model: 'm' })).not.toEqual('p\0m\0')
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

  it('aggregates pass rate, mean tokens, and newest instant per route of the role', () => {
    const summaries = mergeEvidence(rows, evidenceRows, 'candidate-generation')
    expect(summaries).toEqual([
      { role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat', origin: 'observed', runs: 2, passRate: 0.5, meanTokens: 15, lastAt: '2026-09-13T00:00:00.000Z' },
      { role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-reasoner', origin: 'pinned', runs: 0, passRate: 0, meanTokens: 0, lastAt: null },
    ])
  })

  it('ignores evidence of other roles and orders by provider then model', () => {
    const summaries = mergeEvidence(rows, evidenceRows, 'evaluation')
    expect(summaries).toEqual([
      { role: 'evaluation', provider: 'deepseek', model: 'deepseek-chat', origin: 'observed', runs: 1, passRate: 1, meanTokens: 5, lastAt: '2026-09-12T00:00:00.000Z' },
    ])
    expect(mergeEvidence(rows, evidenceRows, 'reflection')).toEqual([])
  })

  it('keeps the newest instant and a monotonic pass share across equal instants', () => {
    const sameAt = [
      evidence({ id: 'a', role: 'evaluation', provider: 'p', model: 'm', pass: true, at: '2026-09-12T00:00:00.000Z' }),
      evidence({ id: 'b', role: 'evaluation', provider: 'p', model: 'm', pass: false, at: '2026-09-12T00:00:00.000Z' }),
    ]
    const [summary] = mergeEvidence([row({ role: 'evaluation', provider: 'p', model: 'm' })], sameAt, 'evaluation')
    expect(summary).toMatchObject({ runs: 2, passRate: 0.5, lastAt: '2026-09-12T00:00:00.000Z' })
  })
})

describe('bestRoute', () => {
  const rows = [
    row({ role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat' }),
    row({ role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-reasoner', origin: 'pinned', at: '2026-09-11T00:00:00.000Z' }),
    row({ role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-max', origin: 'pinned', at: '2026-09-12T00:00:00.000Z' }),
  ]
  const summaries: RouteSummary[] = [
    { role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat', origin: 'observed', runs: 2, passRate: 0.5, meanTokens: 15, lastAt: '2026-09-12T00:00:00.000Z' },
    { role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-reasoner', origin: 'pinned', runs: 0, passRate: 0, meanTokens: 0, lastAt: null },
    { role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-max', origin: 'pinned', runs: 0, passRate: 0, meanTokens: 0, lastAt: null },
  ]

  it('prefers the newest pinned assignment over any evidence', () => {
    expect(bestRoute(rows, summaries, 'candidate-generation')).toEqual({ provider: 'deepseek', model: 'deepseek-max' })
  })

  it('falls back to the best measured route when nothing is pinned', () => {
    const unpinned = rows.map(entry => ({ ...entry, origin: 'observed' as const }))
    expect(bestRoute(unpinned, summaries, 'candidate-generation')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('picks the higher pass rate, then the fewer mean tokens', () => {
    const mixed = [
      row({ role: 'evaluation', provider: 'a', model: 'm1' }),
      row({ role: 'evaluation', provider: 'a', model: 'm2' }),
      row({ role: 'evaluation', provider: 'a', model: 'm3' }),
    ]
    const measured: RouteSummary[] = [
      { role: 'evaluation', provider: 'a', model: 'm2', origin: 'observed', runs: 1, passRate: 1, meanTokens: 30, lastAt: '2026-09-12T00:00:00.000Z' },
      { role: 'evaluation', provider: 'a', model: 'm1', origin: 'observed', runs: 1, passRate: 1, meanTokens: 10, lastAt: '2026-09-12T00:00:00.000Z' },
      { role: 'evaluation', provider: 'a', model: 'm3', origin: 'observed', runs: 1, passRate: 0, meanTokens: 5, lastAt: '2026-09-12T00:00:00.000Z' },
    ]
    expect(bestRoute(mixed, measured, 'evaluation')).toEqual({ provider: 'a', model: 'm1' })
  })

  it('excludes unmeasured routes and yields undefined with no candidates', () => {
    const unmeasured: RouteSummary[] = [
      { role: 'evaluation', provider: 'a', model: 'm1', origin: 'observed', runs: 0, passRate: 0, meanTokens: 0, lastAt: null },
    ]
    expect(bestRoute([row({ role: 'evaluation', provider: 'a', model: 'm1' })], unmeasured, 'evaluation')).toBeUndefined()
    expect(bestRoute([], [], 'evaluation')).toBeUndefined()
  })

  it('covers the topology in spec §28 order', () => {
    expect(EVOLUTION_ROLES).toEqual(['task-execution', 'reflection', 'candidate-generation', 'evaluation', 'promotion-review'])
  })
})
