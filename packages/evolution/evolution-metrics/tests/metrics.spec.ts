import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import EvolutionBudget from '../../evolution-budget/src/index.ts'
import EvolutionMemoryStore, { EvolutionScopeId } from '../../evolution-memory/src/index.ts'
import EvolutionMeta from '../../evolution-meta/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionMetrics from '../src/index.ts'
import { elapsedDays, gainPerComputeHour, gainPerDay, gainPerMillionTokens, ratio, share, splitHalves } from '../src/metrics.ts'
import type { MetricsReport } from '../src/index.ts'

const HOUR = 3_600_000
const T0 = Date.parse('2026-01-01T00:00:00.000Z')

/** Provenance of the decision batch the memory-utility test applies. */
const extraction = {
  at: new Date(T0 + HOUR).toISOString(),
  sessionId: 's-asking',
  provider: 'p',
  model: 'm',
  origin: 'background_review' as const,
  inputBytes: 10,
  truncated: false,
}

/** ISO-8601 instant the given number of hours after the window's start. */
function at(hours: number): string {
  return new Date(T0 + hours * HOUR).toISOString()
}

async function boot(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  return { ctx, metrics: await ctx.plugin(EvolutionMetrics, config).then(() => ctx.evolutionMetrics) }
}

/** Record one engine run whose instant the fake clock fixes. */
async function recordRun(
  ctx: Context,
  runId: string,
  hour: number,
  pass: boolean,
  tokens = 100,
  wallTimeMs = 60_000,
): Promise<void> {
  vi.setSystemTime(T0 + hour * HOUR)
  await ctx.evolutionMeta.record({ runId, taskClass: 'writer', config: {}, pass, tokens, wallTimeMs })
}

/** The metric with this id from either half of the report. */
function value(report: MetricsReport, id: string) {
  const found = [...report.northStar, ...report.supporting].find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no metric '${id}' in the report`)
  return found
}

afterEach(() => {
  vi.useRealTimers()
})

describe('metric arithmetic', () => {
  it('gives the newer half the extra run of an odd series', () => {
    expect(splitHalves([])).toEqual([[], []])
    expect(splitHalves(['a'])).toEqual([[], ['a']])
    expect(splitHalves(['a', 'b', 'c'])).toEqual([['a'], ['b', 'c']])
    expect(splitHalves(['a', 'b', 'c', 'd'])).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('refuses to divide by an empty population or a zero denominator', () => {
    expect(share(1, 0)).toBeUndefined()
    expect(ratio(5, 0)).toBeUndefined()
    expect(share(1, 4)).toBe(0.25)
    expect(ratio(9, 3)).toBe(3)
  })

  it('scales a gain by each compute denominator', () => {
    expect(gainPerMillionTokens(0.5, 1_000_000)).toBeCloseTo(0.5, 12)
    expect(gainPerMillionTokens(0.5, 0)).toBeUndefined()
    expect(gainPerComputeHour(0.5, HOUR)).toBeCloseTo(0.5, 12)
    expect(gainPerComputeHour(0.5, 0)).toBeUndefined()
    expect(gainPerDay(0.5, 2)).toBe(0.25)
    expect(gainPerDay(0.5, 0)).toBeUndefined()
    expect(elapsedDays(at(0), at(48))).toBe(2)
  })
})

describe('metric report', () => {
  it('measures capability gain per unit of compute, and the velocity, over the run window', async () => {
    vi.useFakeTimers()
    const { ctx, metrics } = await boot()
    await ctx.plugin(EvolutionMeta, {})
    // Older half: one pass in three. Newer half: three passes in three.
    await recordRun(ctx, 'r1', 0, true)
    await recordRun(ctx, 'r2', 1, false)
    await recordRun(ctx, 'r3', 2, false)
    await recordRun(ctx, 'r4', 3, true)
    await recordRun(ctx, 'r5', 4, true)
    await recordRun(ctx, 'r6', 5, true)

    const report = metrics.report()

    expect(report.window).toEqual({
      taskClass: null,
      runs: 6,
      from: at(0),
      to: at(5),
      baselineRuns: 3,
      treatmentRuns: 3,
      baselinePassRate: 1 / 3,
      treatmentPassRate: 1,
    })
    // gain = 2/3 over 600 tokens, 360000ms of compute, and 5/24 of a day.
    expect(value(report, 'capability-gain-per-million-tokens').value).toBeCloseTo((2 / 3) * 1e6 / 600, 6)
    expect(value(report, 'capability-gain-per-compute-hour').value).toBeCloseTo((2 / 3) * 10, 6)
    expect(value(report, 'learning-velocity').value).toBeCloseTo((2 / 3) / (5 / 24), 6)
    expect(value(report, 'capability-gain-per-million-tokens').unavailableReason).toBeNull()
  })

  it('reports the whole metric set as unmeasurable, naming the missing store, when nothing is mounted', async () => {
    const { metrics } = await boot()

    const report = metrics.report()

    expect(report.window.runs).toBe(0)
    expect(report.window.from).toBeNull()
    expect(report.northStar.map(entry => entry.id)).toEqual([
      'capability-gain-per-cost-unit',
      'capability-gain-per-million-tokens',
      'capability-gain-per-compute-hour',
    ])
    expect(report.supporting.map(entry => entry.id)).toEqual([
      'learning-velocity',
      'compute-overhead-ratio',
      'failure-recurrence',
      'skill-incremental-utility',
      'memory-utility',
      'benchmark-robustness',
      'regression-debt',
      'promotion-quality',
      'rollback-rate',
      'evaluator-reliability',
    ])
    for (const entry of [...report.northStar, ...report.supporting]) {
      expect(entry.value, entry.id).toBeNull()
      expect(entry.unavailableReason, entry.id).not.toBeNull()
    }
    // The unrecorded metrics name the record that is missing, not a store.
    expect(value(report, 'skill-incremental-utility').unavailableReason).toContain('no-skill control')
    expect(value(report, 'skill-incremental-utility').unavailableReason)
      .toContain('a producer that scores one scenario with the skill absent')
    expect(value(report, 'benchmark-robustness').unavailableReason).toContain('no outcome field')
    expect(value(report, 'benchmark-robustness').unavailableReason)
      .toContain('a producer that executes a task and records whether it passed')
  })

  it('withholds a gain the window cannot evidence, keeping the measured costs', async () => {
    vi.useFakeTimers()
    const { ctx, metrics } = await boot()
    await ctx.plugin(EvolutionMeta, {})
    await recordRun(ctx, 'r1', 0, true)
    await recordRun(ctx, 'r2', 1, true)
    await recordRun(ctx, 'r3', 2, true)

    const report = metrics.report()

    // One run in the older half is below the two-run floor on each side.
    expect(report.window).toMatchObject({ runs: 3, baselineRuns: 1, treatmentRuns: 2, baselinePassRate: null })
    expect(value(report, 'capability-gain-per-million-tokens').unavailableReason)
      .toContain('2 runs are needed on each side of the split')
    expect(value(report, 'learning-velocity').unavailableReason)
      .toContain('2 runs are needed on each side of the split')
  })

  it('measures the search overhead against the winner tokens without adding the two scopes', async () => {
    vi.useFakeTimers()
    const { ctx, metrics } = await boot()
    await ctx.plugin(EvolutionMeta, {})
    await ctx.plugin(EvolutionBudget, {})
    await recordRun(ctx, 'r1', 0, true)
    await recordRun(ctx, 'r2', 5, true)
    await ctx.evolutionBudget.allocate({ batchId: 'b1', taskClass: 'writer', candidateClass: 'standard' })
    vi.setSystemTime(T0 + 2 * HOUR)
    await ctx.evolutionBudget.spend('b1', { tokens: 800, wallTimeMs: 1000, rollouts: 4 })

    const report = metrics.report()

    // 800 tokens of search bought the 200 winner tokens the runs recorded.
    expect(value(report, 'compute-overhead-ratio').value).toBe(4)
    expect(value(report, 'compute-overhead-ratio').caveat).toContain('never be added')
  })

  it('measures capability gain per cost unit the window\'s own runs were billed', async () => {
    vi.useFakeTimers()
    const { ctx, metrics } = await boot()
    await ctx.plugin(EvolutionMeta, {})
    await ctx.plugin(EvolutionBudget, {})
    // Older half: one pass in three. Newer half: three passes in three.
    const runs = [
      ['r1', 0, true], ['r2', 1, false], ['r3', 2, false],
      ['r4', 3, true], ['r5', 4, true], ['r6', 5, true],
    ] as const
    for (const [runId, hour, pass] of runs) {
      await recordRun(ctx, runId, hour, pass)
      await ctx.evolutionBudget.allocate({ batchId: runId, taskClass: 'writer', candidateClass: 'standard' })
      await ctx.evolutionBudget.spend(runId, { tokens: 100, wallTimeMs: 60_000, rollouts: 1, cost: 2 })
    }

    const billed = value(metrics.report(), 'capability-gain-per-cost-unit')

    // A gain of 2/3 over six runs billed at two cost units each.
    expect(billed.value).toBeCloseTo((2 / 3) / 12, 12)
    expect(billed.unit).toBe('gain-per-cost-unit')
    expect(billed.unavailableReason).toBeNull()
    expect(billed.inputs).toEqual([
      'ctx.evolutionMeta.runs(): EngineRun.runId',
      'ctx.evolutionBudget.spends(): SpendRecord.batchId / cost',
    ])
    expect(billed.caveat).toContain('the deployment\'s own cost unit')
  })

  it('refuses a cost denominator the window cannot bill completely', async () => {
    vi.useFakeTimers()
    const { ctx, metrics } = await boot()
    await ctx.plugin(EvolutionMeta, {})
    await recordRun(ctx, 'r1', 0, true)
    await recordRun(ctx, 'r2', 1, true)
    await recordRun(ctx, 'r3', 2, true)
    await recordRun(ctx, 'r4', 3, true)

    // No budget store: nothing bills a run at all.
    expect(value(metrics.report(), 'capability-gain-per-cost-unit').unavailableReason)
      .toContain('the evolution budget store that bills a run is not mounted')

    await ctx.plugin(EvolutionBudget, {})
    // A run whose batch spent nothing leaves the bill open.
    expect(value(metrics.report(), 'capability-gain-per-cost-unit').unavailableReason)
      .toContain("the run 'r1' recorded no spend on its own batch")

    for (const runId of ['r1', 'r2', 'r3', 'r4']) {
      await ctx.evolutionBudget.allocate({ batchId: runId, taskClass: 'writer', candidateClass: 'standard' })
      await ctx.evolutionBudget.spend(runId, { tokens: 100, wallTimeMs: 60_000, rollouts: 1 })
    }
    // An unpriced spend is not a zero, so the reading names the missing producer.
    expect(value(metrics.report(), 'capability-gain-per-cost-unit').unavailableReason)
      .toContain('carries no billed cost')
  })

  it('reads the supporting metrics from the stores that own them', async () => {
    const { ctx, metrics } = await boot()
    ctx.provide('evolutionCanary', {
      summary: () => ({
        total: 5,
        byState: { shadow: 1, canary: 0, promoted: 3, 'rolled-back': 1, rejected: 1 },
      }),
    } as never)
    ctx.provide('evolutionLineage', {
      experiments: () => [
        { outcome: 'improved' }, { outcome: 'improved' },
        { outcome: 'regressed' }, { outcome: 'inconclusive' },
      ],
    } as never)
    ctx.provide('evolutionCurator', { debt: () => [{ name: 'writer' }, { name: 'alpha' }] } as never)
    ctx.provide('evolutionEvaluatorHealth', {
      summary: () => ({
        runs: 10,
        unanimousRate: 0.8,
        approvalRate: 0.9,
        recentApprovalRate: 0.9,
        drift: 0,
        falsePositiveRate: 0.2,
        channels: [],
      }),
    } as never)
    ctx.provide('evolutionSkillTelemetry', {
      entries: () => [{ name: 'writer', usage: { sessionIds: ['s1', 's2', 's3'] } }],
    } as never)
    ctx.provide('evolutionFeedback', {
      signals: () => [{ sessions: 3 }, { sessions: 1 }, { sessions: 2 }],
    } as never)

    const report = metrics.report()

    // One of four deployments that went live was rolled back.
    expect(value(report, 'rollback-rate').value).toBe(0.25)
    expect(value(report, 'promotion-quality').value).toBe(0.5)
    expect(value(report, 'regression-debt').value).toBe(2)
    expect(value(report, 'evaluator-reliability').value).toBeCloseTo(0.8, 6)
    // Two of three observed failures recurred in more than one session.
    expect(value(report, 'failure-recurrence').value).toBeCloseTo(2 / 3, 6)
  })

  it('reports memory utility from the recall ledger, and names the missing record without one', async () => {
    vi.useFakeTimers()
    const { ctx, metrics } = await boot()
    await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 65536 })

    // Nothing recalled yet: the reading names the record it is missing.
    const empty = value(metrics.report(), 'memory-utility')
    expect(empty.value).toBeNull()
    expect(empty.unavailableReason).toContain('no recall row is recorded')
    expect(empty.inputs).toEqual(['ctx.evolutionMemory.recallUtility(): MemoryUtility.utility'])

    const id = EvolutionScopeId('test', 'ws-1')
    await ctx.evolutionMemory.addContextItem(id, { kind: 'text', label: 'Recall: s-1', text: 'prior work' })
    // Retrieved but nothing after it: relevance alone, no proven gain.
    expect(value(metrics.report(), 'memory-utility').value).toBe(0)

    await ctx.evolutionMemory.applyExtractionDecisions(id, [], extraction)
    await ctx.evolutionMemory.recordRecallOutcome(id, 's-1', 'ok')
    const measured = value(metrics.report(), 'memory-utility')

    // relevance 1/2 x decision impact 1 x outcome gain 1.
    expect(measured.value).toBeCloseTo(0.5, 12)
    expect(measured.unavailableReason).toBeNull()
    expect(measured.caveat).toContain('used')
    expect(measured.caveat).toContain('source quality')
  })

  it('reports memory utility as unmeasurable when the memory store is not mounted', async () => {
    const { metrics } = await boot()
    expect(value(metrics.report(), 'memory-utility').unavailableReason)
      .toBe('the evolution memory store is not mounted')
  })

  it('filters the window by task class and by the query bounds', async () => {
    vi.useFakeTimers()
    const { ctx, metrics } = await boot()
    await ctx.plugin(EvolutionMeta, {})
    await recordRun(ctx, 'w1', 0, true)
    await recordRun(ctx, 'w2', 1, false)
    vi.setSystemTime(T0 + 2 * HOUR)
    await ctx.evolutionMeta.record({ runId: 'a1', taskClass: 'alpha', config: {}, pass: true, tokens: 10, wallTimeMs: 10 })

    expect(metrics.report({ taskClass: 'alpha' }).window).toMatchObject({ taskClass: 'alpha', runs: 1 })
    expect(metrics.report({ since: at(1) }).window).toMatchObject({ runs: 2, from: at(1) })
    expect(metrics.report({ limit: 1 }).window.runs).toBe(1)
  })
})
