/**
 * The metric layer (`ctx.evolutionMetrics`): the north-star metric of the
 * evolutionary harness — capability gain divided by the compute that bought
 * it — and the supporting metrics that say whether the gain is real (§55).
 * Every value is read from a store another package already writes, and a
 * metric whose records do not exist is reported as unmeasurable with the
 * missing record named, never as a zero. Nothing here writes, and nothing
 * calls a model: `/metrics` renders one report.
 *
 * Capability is the recorded pass rate of engine runs, compute is the tokens
 * and wall time those same runs spent, and the gain is the newer half of a
 * window measured against its older half. The window comes from
 * `ctx.evolutionMeta.runs()`, the one store that carries the pass, the cost,
 * and the instant of the same run; the router's outcomes hold the same triple
 * for the same write and the budget's spends hold a superset of it, so a
 * report never adds two of the three — the search's extra cost is reported as
 * its own ratio instead.
 * @module @deepseek-ai/dsh-evolution-metrics
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from 'zod'
import {
  elapsedDays,
  gainPerComputeHour,
  gainPerDay,
  gainPerMillionTokens,
  metric,
  passRate,
  ratio,
  share,
  splitHalves,
  unavailable,
} from './metrics.ts'
import type { MetricValue, MetricsQuery, MetricsReport, MetricsWindow } from './types.ts'

export type * from './types.ts'
export {
  elapsedDays,
  gainPerComputeHour,
  gainPerDay,
  gainPerMillionTokens,
  metric,
  passRate,
  ratio,
  share,
  splitHalves,
  unavailable,
} from './metrics.ts'

/** Provenance of the run window: the pass, the cost, and the instant of one run. */
const RUN_INPUT = 'ctx.evolutionMeta.runs(): EngineRun.pass / tokens / wallTimeMs / at'

/**
 * Deployment choices of the metric layer; an omitted field takes its default.
 */
export interface Config {
  /** Newest engine runs one report covers when the query sets no limit; default 200. */
  windowRuns?: number
  /** Runs each half of the split needs before a gain is reported; default 2. */
  minimumRunsPerHalf?: number
  /** Failure signals one recurrence reading covers; default 50. */
  maxSignals?: number
}

/** Normalized configuration used by the metric layer. */
export interface ResolvedConfig {
  /** Newest engine runs one report covers when the query sets no limit. */
  windowRuns: number
  /** Runs each half of the split needs before a gain is reported. */
  minimumRunsPerHalf: number
  /** Failure signals one recurrence reading covers. */
  maxSignals: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { windowRuns = 200, minimumRunsPerHalf = 2, maxSignals = 50 } = config
  return { windowRuns, minimumRunsPerHalf, maxSignals }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The north-star metric and its supporting set, read from the evolution stores. */
    evolutionMetrics: EvolutionMetrics
  }
}

/**
 * Metric layer over the evolution stores. It opens no domain and holds no
 * state, so every reading is the current state of the stores it reads; a
 * store that is not mounted makes its metrics unmeasurable rather than
 * absent, so one report always carries the whole §55 set.
 */
export class EvolutionMetrics extends Service {
  /** Deployment choices of the window and its evidence floor. */
  static Config = z.object({
    windowRuns: z.number().int().min(1).default(200),
    minimumRunsPerHalf: z.number().int().min(1).default(2),
    maxSignals: z.number().int().min(1).default(50),
  })

  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the evolution stores being read.
   * @param config - window and evidence choices; omitted fields take defaults.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionMetrics')
    this.resolved = resolveConfig(config)
  }

  /**
   * Measure the §55 metric set over one window of recorded engine runs. The
   * north star is reported per compute denominator; every supporting metric
   * is either measured from the store that owns it or reported unmeasurable
   * with the missing record named. Reads only.
   * @param query - which runs the window covers; omitted fields take defaults.
   * @returns the window, the north star per denominator, and the supporting set.
   */
  report(query: MetricsQuery = {}): MetricsReport {
    const runs = this.runsIn(query)
    const series = runs ?? []
    const [baseline, treatment] = splitHalves(series)
    const enough = baseline.length >= this.resolved.minimumRunsPerHalf
      && treatment.length >= this.resolved.minimumRunsPerHalf
    const baselineRate = enough ? passRate(baseline.filter(run => run.pass).length, baseline.length) : undefined
    const treatmentRate = enough ? passRate(treatment.filter(run => run.pass).length, treatment.length) : undefined
    const gain = baselineRate === undefined || treatmentRate === undefined
      ? undefined
      : treatmentRate - baselineRate
    const window: MetricsWindow = {
      taskClass: query.taskClass ?? null,
      runs: series.length,
      from: series[0]?.at ?? null,
      to: series[series.length - 1]?.at ?? null,
      baselineRuns: baseline.length,
      treatmentRuns: treatment.length,
      baselinePassRate: baselineRate ?? null,
      treatmentPassRate: treatmentRate ?? null,
    }
    const gap = runs === undefined
      ? 'the evolution meta store is not mounted, so no engine run records a pass, a cost, and an instant'
      : `the window holds ${baseline.length} older and ${treatment.length} newer runs;`
        + ` ${this.resolved.minimumRunsPerHalf} runs are needed on each side of the split`
    return {
      window,
      northStar: this.northStar(series, gain, gap),
      supporting: this.supporting(window, gain, gap),
    }
  }

  /**
   * The recorded runs of one window, oldest first so the halves split by time.
   * Absent when the meta store is not mounted.
   */
  private runsIn(query: MetricsQuery) {
    const meta = this.ctx.get('evolutionMeta')
    if (meta === undefined) return undefined
    const limit = query.limit ?? this.resolved.windowRuns
    return meta.runs(query.taskClass)
      .filter(run => this.inWindow(run.at, query.since, query.until))
      .slice(0, limit)
      .reverse()
  }

  /** Whether one recorded instant falls inside the query's bounds, inclusive. */
  private inWindow(at: string, since: string | undefined, until: string | undefined): boolean {
    // Recorded instants are `toISOString()` output, so lexicographic order is
    // chronological order and the bounds compare as strings.
    return (since === undefined || at >= since) && (until === undefined || at <= until)
  }

  /** Capability gain per unit of compute, one entry per recorded denominator. */
  private northStar(
    series: readonly { readonly tokens: number; readonly wallTimeMs: number }[],
    gain: number | undefined,
    gap: string,
  ): readonly MetricValue[] {
    const tokens = series.reduce((sum, run) => sum + run.tokens, 0)
    const wallTimeMs = series.reduce((sum, run) => sum + run.wallTimeMs, 0)
    const tokensUnit = 'gain-per-million-tokens' as const
    const timeUnit = 'gain-per-compute-hour' as const
    if (gain === undefined) {
      return [
        unavailable('capability-gain-per-million-tokens', tokensUnit, [RUN_INPUT], gap),
        unavailable('capability-gain-per-compute-hour', timeUnit, [RUN_INPUT], gap),
      ]
    }
    const perTokens = gainPerMillionTokens(gain, tokens)
    const perHour = gainPerComputeHour(gain, wallTimeMs)
    return [
      perTokens === undefined
        ? unavailable('capability-gain-per-million-tokens', tokensUnit, [RUN_INPUT], 'the window spent no tokens')
        : metric(
          'capability-gain-per-million-tokens',
          perTokens,
          tokensUnit,
          [RUN_INPUT],
          'the numerator is a pass-rate delta between two halves of one window, so it measures the promoted path only:'
          + ' the optimizer records a run when a candidate staged, and never records a rejection',
        ),
      perHour === undefined
        ? unavailable('capability-gain-per-compute-hour', timeUnit, [RUN_INPUT], 'the window recorded no wall time')
        : metric(
          'capability-gain-per-compute-hour',
          perHour,
          timeUnit,
          [RUN_INPUT],
          'the denominator is the scorer-summed wall time of the recorded runs, not elapsed clock time;'
          + ' the numerator carries the same promoted-path caveat as the token denominator',
        ),
    ]
  }

  /** The supporting metrics, each measured from its own store or naming the gap. */
  private supporting(window: MetricsWindow, gain: number | undefined, gap: string): readonly MetricValue[] {
    return [
      this.learningVelocity(window, gain, gap),
      this.computeOverhead(window),
      this.failureRecurrence(),
      unavailable(
        'skill-incremental-utility',
        'share',
        ['ctx.evolutionSkillTelemetry.entries()', 'ctx.evolutionCanary.deployments()', 'ctx.evolutionLineage.experiments()'],
        'no store pairs a skill-using run with a run that used no skill: telemetry counts loads per skill,'
        + ' a canary triple measures the winner against nothing, and the optimizer\'s baseline-versus-winner pair'
        + ' is an ablation of the same skill, not a no-skill control',
      ),
      unavailable(
        'memory-utility',
        'share',
        ['ctx.evolutionMemory.read()'],
        'no recall-hit counter and no outcome linkage exist: a recall is recorded as a labelled context item,'
        + ' so nothing ties a recalled memory to what happened afterwards',
      ),
      unavailable(
        'benchmark-robustness',
        'share',
        ['ctx.evolutionBenchmark.tasks()'],
        'no record scores a benchmark task: BenchmarkTask carries a ladder state but no outcome field, and nothing'
        + ' durable separates a holdout pass from a search pass',
      ),
      this.regressionDebt(),
      this.promotionQuality(),
      this.rollbackRate(),
      this.evaluatorReliability(),
    ]
  }

  /** Capability gain divided by the elapsed days of the window. */
  private learningVelocity(window: MetricsWindow, gain: number | undefined, gap: string): MetricValue {
    const id = 'learning-velocity' as const
    const unit = 'gain-per-day' as const
    if (gain === undefined || window.from === null || window.to === null) {
      return unavailable(id, unit, [RUN_INPUT], gap)
    }
    const value = gainPerDay(gain, elapsedDays(window.from, window.to))
    return value === undefined
      ? unavailable(id, unit, [RUN_INPUT], 'every run in the window shares one recorded instant, so no span elapsed')
      : metric(
        id,
        value,
        unit,
        [RUN_INPUT],
        'velocity inside one window is not a long-run trend, and the window holds only runs that staged a candidate',
      )
  }

  /**
   * Compute the search spent over the compute the winning runs measured. The
   * two stores count different scopes, so this is the one place the layer
   * touches both and it never adds them.
   */
  private computeOverhead(window: MetricsWindow): MetricValue {
    const id = 'compute-overhead-ratio' as const
    const unit = 'ratio' as const
    const inputs = ['ctx.evolutionBudget.spends(): SpendRecord.tokens', RUN_INPUT]
    const budget = this.ctx.get('evolutionBudget')
    if (budget === undefined) {
      return unavailable(id, unit, inputs, 'the evolution budget store is not mounted')
    }
    if (window.from === null || window.to === null) {
      return unavailable(id, unit, inputs, 'the window holds no run to compare a spend against')
    }
    const spent = budget.spends()
      .filter(row => this.inWindow(row.at, window.from ?? undefined, window.to ?? undefined))
      .reduce((sum, row) => sum + row.tokens, 0)
    return metric(
      id,
      spent,
      unit,
      inputs,
      'the numerator is a multiple of the winner tokens the runs recorded:'
      + ' a spend row sums every variant the batch evaluated, so the two stores describe different scopes'
      + ' and must never be added',
    )
  }

  /** Share of observed failures that recurred in more than one session. */
  private failureRecurrence(): MetricValue {
    const id = 'failure-recurrence' as const
    const unit = 'share' as const
    const inputs = ['ctx.evolutionFeedback.signals(sessionIds, limit): FeedbackSignal.sessions',
      'ctx.evolutionSkillTelemetry.entries(): SkillUsageRecord.sessionIds']
    const feedback = this.ctx.get('evolutionFeedback')
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    if (feedback === undefined) return unavailable(id, unit, inputs, 'the evolution feedback store is not mounted')
    if (telemetry === undefined) {
      return unavailable(id, unit, inputs, 'the skill telemetry store that names the sessions is not mounted')
    }
    const sessionIds = [...new Set(telemetry.entries().flatMap(entry => entry.usage.sessionIds))]
    if (sessionIds.length === 0) {
      return unavailable(id, unit, inputs, 'no skill load recorded a session, so there is no session to aggregate over')
    }
    const signals = feedback.signals(sessionIds, this.resolved.maxSignals)
    const recurring = share(signals.filter(signal => signal.sessions > 1).length, signals.length)
    return recurring === undefined
      ? unavailable(id, unit, inputs, 'every recorded session loads with no failing tool result')
      : metric(
        id,
        recurring,
        unit,
        inputs,
        'sessions come from skill telemetry, which keeps the newest configured count per skill,'
        + ' so a failure recurring only in older sessions is not visible',
      )
  }

  /** Open regression debt: failures the curator has not seen answered. */
  private regressionDebt(): MetricValue {
    const id = 'regression-debt' as const
    const unit = 'count' as const
    const inputs = ['ctx.evolutionCurator.debt(): RegressionDebt.passes / sessions / firstSeenAt']
    const curator = this.ctx.get('evolutionCurator')
    if (curator === undefined) return unavailable(id, unit, inputs, 'the evolution curator is not mounted')
    return metric(
      id,
      curator.debt().length,
      unit,
      inputs,
      'each entry counts consecutive curator passes over a failure signal that is still open,'
      + ' not a test that passed and later failed',
    )
  }

  /** Share of recorded experiments whose candidate improved on its baseline. */
  private promotionQuality(): MetricValue {
    const id = 'promotion-quality' as const
    const unit = 'share' as const
    const inputs = ['ctx.evolutionLineage.experiments(): ExperimentEnvelope.outcome']
    const lineage = this.ctx.get('evolutionLineage')
    if (lineage === undefined) return unavailable(id, unit, inputs, 'the evolution lineage store is not mounted')
    const experiments = lineage.experiments()
    const improved = share(experiments.filter(row => row.outcome === 'improved').length, experiments.length)
    return improved === undefined
      ? unavailable(id, unit, inputs, 'no experiment is recorded')
      : metric(
        id,
        improved,
        unit,
        inputs,
        'the outcome is the judgement of the run that produced the candidate; nothing re-measures a promotion'
        + ' after it lands, so a change that looked better and later regressed counts as an improvement',
      )
  }

  /** Share of deployments that went live and were then rolled back. */
  private rollbackRate(): MetricValue {
    const id = 'rollback-rate' as const
    const unit = 'share' as const
    const inputs = ['ctx.evolutionCanary.summary().byState']
    const canary = this.ctx.get('evolutionCanary')
    if (canary === undefined) return unavailable(id, unit, inputs, 'the evolution canary store is not mounted')
    const { byState } = canary.summary()
    const live = byState.promoted + byState['rolled-back']
    const rate = share(byState['rolled-back'], live)
    return rate === undefined
      ? unavailable(id, unit, inputs, 'no deployment reached a terminal decision yet')
      : metric(
        id,
        rate,
        unit,
        inputs,
        'a rejected deployment never went live and is excluded, and every transition is recorded by an operator'
        + ' command, so a rollout nobody decided on is not counted',
      )
  }

  /** How often the evaluator ensemble's verdicts held up. */
  private evaluatorReliability(): MetricValue {
    const id = 'evaluator-reliability' as const
    const unit = 'share' as const
    const inputs = ['ctx.evolutionEvaluatorHealth.summary(): approvalRate / unanimousRate / drift / runs',
      'ctx.evolutionEvaluatorHealth.summary().falsePositiveRate']
    const health = this.ctx.get('evolutionEvaluatorHealth')
    if (health === undefined) return unavailable(id, unit, inputs, 'the evolution evaluator health store is not mounted')
    const summary = health.summary()
    return summary.runs === 0
      ? unavailable(id, unit, inputs, 'no evaluator verdict is recorded')
      : metric(
        id,
        1 - summary.falsePositiveRate,
        unit,
        inputs,
        'the false-positive rate is an inter-verdict proxy: it compares one verdict against a later one,'
        + ' not against a human outcome',
      )
  }
}

export default EvolutionMetrics
