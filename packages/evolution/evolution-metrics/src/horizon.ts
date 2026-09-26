/**
 * The §13.5 long-horizon readings over the recorded benchmark outcomes: for
 * each shipped horizon tier, success, process discipline, recoveries, context
 * pressure, and budget usage.
 *
 * Every number is read from an outcome row the benchmark store already wrote,
 * and every row was folded from the run's own harvested sessions, so this
 * module re-derives nothing: it aggregates. A tier whose outcomes are not
 * recorded reports each axis unmeasurable with the missing record named,
 * rather than reporting a zero.
 * @module @deepseek-ai/dsh-evolution-metrics/src/horizon
 */

import { HORIZON_TIERS } from '@deepseek-ai/dsh-evolution-benchmark'
import type { BenchmarkOutcome } from '@deepseek-ai/dsh-evolution-benchmark'
import { metric, rate, unavailable } from './metrics.ts'
import type { LongHorizonReport, LongHorizonTierReport, MetricValue } from './types.ts'

/** The outcome fields every §13.5 reading cites. */
const OUTCOME_INPUT = 'ctx.evolutionBenchmark.outcomes(): BenchmarkOutcome'
const SUCCESS_INPUT = [`${OUTCOME_INPUT}.pass / status / tier`]
const DISCIPLINE_INPUT = [`${OUTCOME_INPUT}.verifications`]
const RECOVERY_INPUT = [`${OUTCOME_INPUT}.failures / failuresAnswered`]
const PRESSURE_INPUT = [`${OUTCOME_INPUT}.contextTokens / contextWindow`]
const BUDGET_INPUT = [`${OUTCOME_INPUT}.tokens / wallTimeMs`]

/** The axis order every tier reports, so a reader can index it. */
const AXES = [
  ['benchmark-robustness', 'share'],
  ['verification-coverage', 'share'],
  ['recovery-efficiency', 'ratio'],
  ['context-pressure', 'share'],
  ['cost', 'tokens'],
  ['latency', 'milliseconds'],
] as const

/** One outcome that reported both a context window and an occupancy inside it. */
type MeasuredPressure = BenchmarkOutcome & { contextTokens: number; contextWindow: number }

/** The six readings one tier's verdict-producing outcomes support. */
function tierMetrics(rows: readonly BenchmarkOutcome[]): readonly MetricValue[] {
  const sum = (of: (row: BenchmarkOutcome) => number): number =>
    rows.reduce((total, row) => total + of(row), 0)
  const passed = rows.filter(row => row.pass).length
  const verified = rows.filter(row => row.verifications > 0).length
  const failures = sum(row => row.failures)
  const answered = sum(row => row.failuresAnswered)
  const tokens = sum(row => row.tokens)
  const wallTimeMs = sum(row => row.wallTimeMs)
  const measured = rows.filter((row): row is MeasuredPressure =>
    row.contextTokens !== null && row.contextWindow !== null)
  const peak = measured.length === 0
    ? undefined
    : Math.max(...measured.map(row => row.contextTokens / row.contextWindow))
  return [
    rate(
      'benchmark-robustness',
      'share',
      passed,
      rows.length,
      SUCCESS_INPUT,
      'the tier holds no verdict-producing outcome',
      'the share is over the outcomes the window recorded: a task whose run never started is counted in the'
      + ' window\'s failed total and neither as a pass nor as a failure of the task',
    ),
    rate(
      'verification-coverage',
      'share',
      verified,
      rows.length,
      DISCIPLINE_INPUT,
      'the tier holds no verdict-producing outcome',
      'a run counts as disciplined once it recorded a verification of its own work; the reading does not check'
      + ' that the verification examined the task\'s acceptance statement',
    ),
    rate(
      'recovery-efficiency',
      'ratio',
      answered,
      failures,
      RECOVERY_INPUT,
      'no run in the tier recorded a failure: `failure/recorded` is the record this rate counts over',
      'the rate is the share of recorded failures a `recovery/decided` record answered; nothing records whether'
      + ' the action it decided repaired the failure',
    ),
    peak === undefined
      ? unavailable(
        'context-pressure',
        'share',
        PRESSURE_INPUT,
        'no run in the tier reported both a context occupancy and the window it was measured against: '
        + '`assistant/message.usage` supplies the numerator and `request/context.contextWindow` the denominator',
      )
      : metric(
        'context-pressure',
        peak,
        'share',
        PRESSURE_INPUT,
        `the highest share of its context window any single run in the tier reached, over the ${measured.length}`
        + ' runs that reported both sides; a run that reported neither is excluded, and a compaction the run'
        + ' recorded is accounted for by the projection the occupancy is folded through',
      ),
    tokens === 0
      ? unavailable(
        'cost',
        'tokens',
        BUDGET_INPUT,
        'no run in the tier billed tokens: the outcome\'s token count is the token meter\'s measurement of the'
        + ' sessions the run harvested',
      )
      : metric(
        'cost',
        tokens / rows.length,
        'tokens',
        BUDGET_INPUT,
        'billed tokens per task: each outcome carries the median over its own attempts and the tier sums those'
        + ' medians, so one expensive task moves this reading without being an average of averages',
      ),
    wallTimeMs === 0
      ? unavailable(
        'latency',
        'milliseconds',
        BUDGET_INPUT,
        'no run in the tier recorded wall time: `EvolutionScorer` samples it per fresh-process attempt',
      )
      : metric(
        'latency',
        wallTimeMs / rows.length,
        'milliseconds',
        BUDGET_INPUT,
        'wall time per task, summed over the tier\'s outcomes; wall time measures the machine a task ran on,'
        + ' so it is a budget reading rather than a difficulty one',
      ),
  ]
}

/**
 * The §13.5 report over one window of recorded outcomes.
 * @param window - the outcomes the report covers, in any order.
 * @param gap - why the window is empty; repeated by every tier when it is.
 * @returns the window and one entry per shipped horizon tier, in ascending order.
 */
export function longHorizonReport(window: readonly BenchmarkOutcome[], gap: string): LongHorizonReport {
  const scored = window.filter(row => row.status === 'scored')
  const instants = window.map(row => row.at).sort()
  const tiers: LongHorizonTierReport[] = HORIZON_TIERS.map((tier) => {
    const rows = scored.filter(row => row.tier === tier)
    if (rows.length > 0) return { tier, tasks: rows.length, metrics: tierMetrics(rows) }
    const named = `${tier}${tier === HORIZON_TIERS.at(-1) ? '+' : ''}-step tier`
    const missing = window.length === 0
      ? gap
      : scored.length === 0
        ? `every outcome in the window is a failed run, so the ${named} holds no verdict to read`
        : `no recorded outcome reaches the ${named} in this window`
    return {
      tier,
      tasks: 0,
      metrics: AXES.map(([id, unit]) => unavailable(id, unit, [OUTCOME_INPUT], missing)),
    }
  })
  return {
    window: {
      tasks: window.length,
      scored: scored.length,
      failed: window.length - scored.length,
      from: instants[0] ?? null,
      to: instants.at(-1) ?? null,
    },
    tiers,
  }
}
