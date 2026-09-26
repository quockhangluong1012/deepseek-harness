/**
 * The §13.5 long-horizon readings and the robustness share they make
 * measurable. The pure fold's arithmetic is covered directly; the service is
 * then driven over a benchmark-store stub the way a host mounts it, so the
 * window bounds and the unmeasurable cases are exercised through the public
 * read path rather than through the builder alone.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BenchmarkOutcome } from '@deepseek-ai/dsh-evolution-benchmark'
import EvolutionMetrics, { longHorizonReport, resolveConfig } from '../src/index.ts'
import type { LongHorizonReport, MetricsReport } from '../src/index.ts'

/** The §13.5 tiers the shipped datasets span. */
const TIERS = [10, 20, 50, 100]

/** Every reading one tier reports, in the order the report fixes. */
const AXES = [
  'benchmark-robustness',
  'verification-coverage',
  'recovery-efficiency',
  'context-pressure',
  'cost',
  'latency',
]

/** The gap the service reports when the benchmark store is not mounted. */
const GAP = 'the benchmark store is not mounted, so no task outcome is recorded'

/** One recorded outcome, with the fields a test does not care about defaulted. */
function outcome(overrides: Partial<BenchmarkOutcome> = {}): BenchmarkOutcome {
  return {
    id: 'o1',
    at: '2026-09-01T00:00:00.000Z',
    taskId: 't1',
    capability: 'long-horizon-refactor',
    family: 'long-horizon',
    profile: 'coding',
    stepSpan: 10,
    tier: 10,
    pass: true,
    status: 'scored',
    reason: null,
    attempts: 1,
    tokens: 100,
    wallTimeMs: 1000,
    samples: [1000],
    changes: [],
    steps: 5,
    verifications: 1,
    verificationsPassed: 1,
    tasksClosed: 1,
    tasksCompleted: 1,
    failures: 0,
    failuresAnswered: 0,
    contextTokens: 4000,
    contextWindow: 8000,
    trajectory: 's1',
    sessionIds: ['s1'],
    ...overrides,
  }
}

/** The reading with this id from one tier. */
function value(report: LongHorizonReport, tier: number, id: string) {
  const found = report.tiers.find(entry => entry.tier === tier)?.metrics.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no metric '${id}' in tier ${tier}`)
  return found
}

/** The metric with this id from either half of the §55 report. */
function supporting(report: MetricsReport, id: string) {
  const found = [...report.northStar, ...report.supporting].find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no metric '${id}' in the report`)
  return found
}

describe('the §13.5 long-horizon report', () => {
  it('reports every tier unmeasurable, naming the gap, when no outcome is recorded', () => {
    const report = longHorizonReport([], GAP)

    expect(report.window).toEqual({ tasks: 0, scored: 0, failed: 0, from: null, to: null })
    expect(report.tiers.map(tier => tier.tier)).toEqual(TIERS)
    for (const tier of report.tiers) {
      expect(tier.tasks).toBe(0)
      expect(tier.metrics.map(entry => entry.id)).toEqual(AXES)
      for (const entry of tier.metrics) {
        expect(entry.value, entry.id).toBeNull()
        expect(entry.unavailableReason, entry.id).toContain(GAP)
      }
    }
  })

  it('measures success, discipline, recoveries, pressure, and budget over one tier', () => {
    const rows = [
      outcome({ id: 'a', verifications: 2, tasksClosed: 2, tasksCompleted: 2, tokens: 100, wallTimeMs: 1000 }),
      outcome({
        id: 'b',
        pass: false,
        verifications: 0,
        tasksClosed: 1,
        tasksCompleted: 0,
        tokens: 300,
        wallTimeMs: 3000,
        contextTokens: 3000,
        failures: 4,
        failuresAnswered: 3,
      }),
    ]

    const report = longHorizonReport(rows, GAP)

    expect(report.window).toEqual({
      tasks: 2,
      scored: 2,
      failed: 0,
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
    })
    expect(report.tiers.find(tier => tier.tier === 10)?.tasks).toBe(2)
    expect(value(report, 10, 'benchmark-robustness').value).toBe(0.5)
    expect(value(report, 10, 'verification-coverage').value).toBe(0.5)
    expect(value(report, 10, 'recovery-efficiency').value).toBe(0.75)
    // The peak share any run reached, not the mean of the two shares.
    expect(value(report, 10, 'context-pressure').value).toBe(0.5)
    expect(value(report, 10, 'cost').value).toBe(200)
    expect(value(report, 10, 'latency').value).toBe(2000)
  })

  it('reports the horizon span from its oldest and newest outcomes', () => {
    const report = longHorizonReport([
      outcome({ id: 'new', at: '2026-09-03T00:00:00.000Z' }),
      outcome({ id: 'old', at: '2026-09-02T00:00:00.000Z' }),
    ], GAP)

    expect(report.window.from).toBe('2026-09-02T00:00:00.000Z')
    expect(report.window.to).toBe('2026-09-03T00:00:00.000Z')
  })

  it('reports a failed run in the window instead of counting it as a task that did not pass', () => {
    const rows = [
      outcome({ id: 'ok', tokens: 100, wallTimeMs: 1000 }),
      outcome({
        id: 'gone',
        status: 'failed',
        pass: false,
        reason: 'the runner refused to boot',
        attempts: 0,
        tokens: 0,
        wallTimeMs: 0,
        samples: [],
        verifications: 0,
        tasksClosed: 0,
        tasksCompleted: 0,
        contextTokens: null,
        contextWindow: null,
      }),
    ]

    const report = longHorizonReport(rows, GAP)

    expect(report.window).toEqual({
      tasks: 2,
      scored: 1,
      failed: 1,
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
    })
    // The share is over the one task that reached a verdict.
    expect(value(report, 10, 'benchmark-robustness').value).toBe(1)
  })

  it('names the tier a window does not reach while measuring the one it does', () => {
    const report = longHorizonReport([outcome({ tier: 100, stepSpan: 120 })], GAP)

    expect(report.tiers.find(tier => tier.tier === 100)?.tasks).toBe(1)
    expect(value(report, 100, 'benchmark-robustness').value).toBe(1)
    expect(value(report, 10, 'benchmark-robustness').unavailableReason)
      .toContain('no recorded outcome reaches the 10-step tier in this window')
    expect(value(report, 50, 'cost').unavailableReason).toContain('no recorded outcome reaches the 50-step tier')
  })

  it('names the missing window and the missing failures rather than reporting zeros', () => {
    const silent = longHorizonReport([outcome({ contextTokens: null, contextWindow: null, failures: 0 })], GAP)

    expect(value(silent, 10, 'context-pressure').value).toBeNull()
    expect(value(silent, 10, 'context-pressure').unavailableReason)
      .toContain('no run in the tier reported both a context occupancy and the window')
    expect(value(silent, 10, 'recovery-efficiency').value).toBeNull()
    expect(value(silent, 10, 'recovery-efficiency').unavailableReason)
      .toContain('no run in the tier recorded a failure')
  })
})

describe('the metric layer over recorded benchmark outcomes', () => {
  /** Mount the metric layer over a benchmark-store stub. */
  async function boot(rows?: readonly BenchmarkOutcome[], config: Record<string, unknown> = {}) {
    const ctx = new Context()
    if (rows !== undefined) ctx.provide('evolutionBenchmark', { outcomes: () => rows } as never)
    const metrics = await ctx.plugin(EvolutionMetrics, config).then(() => ctx.evolutionMetrics)
    return { ctx, metrics }
  }

  it('measures benchmark-robustness from the outcomes a run pass recorded', async () => {
    const { metrics } = await boot([outcome(), outcome({ id: 'o2', pass: false }), outcome({ id: 'o3', pass: true })])

    const reading = supporting(metrics.report(), 'benchmark-robustness')

    expect(reading.value).toBeCloseTo(2 / 3)
    expect(reading.unit).toBe('share')
    expect(reading.unavailableReason).toBeNull()
    expect(reading.caveat).toContain('a task nobody ran has no outcome and is not counted')
  })

  it('names the unrecorded outcome when the store holds no row', async () => {
    const { metrics } = await boot([])

    const reading = supporting(metrics.report(), 'benchmark-robustness')

    expect(reading.value).toBeNull()
    expect(reading.unavailableReason).toContain('no benchmark task outcome is recorded')
    expect(reading.unavailableReason).toContain('records whether it passed')
  })

  it('names the unmounted store when nothing provides outcomes', async () => {
    const { metrics } = await boot()

    const reading = supporting(metrics.report(), 'benchmark-robustness')

    expect(reading.value).toBeNull()
    expect(reading.unavailableReason).toContain('the benchmark store is not mounted')
  })

  it('reports robustness as unmeasurable when every recorded run failed', async () => {
    const { metrics } = await boot([outcome({ status: 'failed', pass: false }), outcome({ id: 'o2', status: 'failed', pass: false })])

    const reading = supporting(metrics.report(), 'benchmark-robustness')

    expect(reading.value).toBeNull()
    expect(reading.unavailableReason).toContain('every one of the 2 recorded outcomes is a failed run')
  })

  it('windows the long-horizon report by instant and by the configured cap', async () => {
    const rows = [
      outcome({ id: 'a', at: '2026-09-01T00:00:00.000Z' }),
      outcome({ id: 'b', at: '2026-09-02T00:00:00.000Z' }),
      outcome({ id: 'c', at: '2026-09-03T00:00:00.000Z' }),
    ]
    const { metrics } = await boot(rows, { maxOutcomes: 2 })

    const capped = metrics.longHorizon()

    // The newest two of the three, newest first then narrowed by the cap.
    expect(capped.window).toEqual({
      tasks: 2,
      scored: 2,
      failed: 0,
      from: '2026-09-02T00:00:00.000Z',
      to: '2026-09-03T00:00:00.000Z',
    })
    expect(metrics.longHorizon({ since: '2026-09-03T00:00:00.000Z' }).window.tasks).toBe(1)
    expect(metrics.longHorizon({ until: '2026-09-01T00:00:00.000Z' }).window.tasks).toBe(1)
    expect(metrics.longHorizon({ limit: 1 }).window.tasks).toBe(1)
  })

  it('resolves the outcome window default alongside the other bounds', async () => {
    expect(resolveConfig({}).maxOutcomes).toBe(200)
    expect(resolveConfig({ maxOutcomes: 3 }).maxOutcomes).toBe(3)
    const { metrics } = await boot([])

    const report = metrics.longHorizon()

    expect(report.window.tasks).toBe(0)
    expect(report.tiers.map(tier => tier.tier)).toEqual(TIERS)
    expect(report.tiers[0]?.metrics.map(entry => entry.id)).toEqual(AXES)
  })
})
