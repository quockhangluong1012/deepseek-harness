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
 * its own ratio instead. The billed-cost denominator is the window's own runs
 * again, read from the budget's spend record of the batch each run was
 * recorded under, so the dollar side covers the same runs as the numerator
 * and a window whose runs are not all priced reports unmeasurable rather than
 * a partial bill.
 *
 * The §13.2 coding set is the second read model: {@link EvolutionMetrics.coding}
 * folds recorded session logs — the same records the kernel counters and the
 * trace projection are built from — into the readings of agent behavior:
 * verified success, false completion, regression, recovery, planning,
 * verification coverage, human intervention, cost, and latency, beside the
 * §5.4 baseline readings over the same window (loop rate, tool failure rate,
 * subagent waste, context utilization, average tokens, and the verified-success
 * ratios per dollar, per million tokens, and per ten minutes).
 *
 * Two more sets read the record the work left behind. {@link EvolutionMetrics.research}
 * folds recorded research runs and the claim and observation records their
 * sessions logged into the seven §13.3 readings of research quality, and
 * {@link EvolutionMetrics.mentor} reads one learner's durable record and the
 * misconception cycles recorded for them into the six §13.4 readings of
 * mentoring. Neither writes: a research run, a claim, an observation, a
 * learner entry, and a pipeline row are all another package's records.
 *
 * The §13.5 long-horizon set is the last read model:
 * {@link EvolutionMetrics.longHorizon} reports success, process discipline,
 * recoveries, context pressure, and budget usage per horizon tier, from the
 * durable outcome `ctx.evolutionBenchmark.run()` records for every benchmark
 * task it executes. Those outcomes are also what makes `benchmark-robustness`
 * measurable: it is the share of executed tasks whose run passed.
 *
 * @module @deepseek-ai/dsh-evolution-metrics
 *
 * This layer owns the read-model surface and nothing else. The evaluator
 * health, uncertainty, and self-model read models are presented here:
 * `evaluator-reliability` in the supporting set, and
 * {@link EvolutionMetrics.uncertainty} and {@link EvolutionMetrics.selfModel}
 * beside the four set reports. `evolution-evaluator-health`,
 * `evolution-uncertainty`, and `evolution-self-model` each keep their own
 * versioned durable domain and their own writer, and a control loop that
 * drives behaviour still reads the store it depends on — presenting a metric
 * and driving a loop are different jobs.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SpendRecord } from '@deepseek-ai/dsh-evolution-budget'
import type { DeploymentSummary } from '@deepseek-ai/dsh-evolution-canary'
import type {} from '@deepseek-ai/dsh-evolution-benchmark'
import type { RegressionDebt } from '@deepseek-ai/dsh-evolution-curator'
import type { EvaluatorHealthSummary } from '@deepseek-ai/dsh-evolution-evaluator-health'
import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import type { ExperimentEnvelope } from '@deepseek-ai/dsh-evolution-lineage'
import type { EngineRun } from '@deepseek-ai/dsh-evolution-meta'
import type { FrontierGap } from '@deepseek-ai/dsh-evolution-self-model'
import type { EvaluationTask } from '@deepseek-ai/dsh-evolution-uncertainty'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { MemoryUtility } from '@deepseek-ai/dsh-evolution-memory'
import type { ResearchRunRecord } from '@deepseek-ai/dsh-research-controller'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from 'zod'
import { codingMetrics, readCodingSession, type CodingSessionFacts } from './coding.ts'
import { longHorizonReport } from './horizon.ts'
import { mentorMetrics } from './mentor.ts'
import { readResearchLedger, researchMetrics, runInstant, type ResearchWork } from './research.ts'
import {
  elapsedDays,
  gainPerComputeHour,
  gainPerDay,
  gainPerMillionTokens,
  metric,
  passRate,
  ratio,
  rate,
  share,
  splitHalves,
  unavailable,
} from './metrics.ts'
import type {
  CodingQuery,
  CodingReport,
  LongHorizonQuery,
  LongHorizonReport,
  MentorQuery,
  MentorReport,
  MetricValue,
  MetricsQuery,
  MetricsReport,
  MetricsWindow,
  ResearchQuery,
  ResearchReport,
  SelfModelReport,
  UncertaintyQuery,
  UncertaintyReport,
} from './types.ts'

export type * from './types.ts'
export { codingMetrics, readCodingSession, type CodingSessionFacts } from './coding.ts'
export { longHorizonReport } from './horizon.ts'
export { mentorMetrics, type MentorFacts } from './mentor.ts'
export { readResearchLedger, researchMetrics, runInstant, type ResearchLedger, type ResearchWork } from './research.ts'
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

/** Engine rows behind the run window: the pass, the cost, and the instant of one run. */
const RUN_INPUT = 'ctx.evolutionMeta.runs(): EngineRun.pass / tokens / wallTimeMs / at'

/** The §43 evaluation-task queue behind the uncertainty readings. */
const QUEUE_INPUT = 'ctx.evolutionUncertainty.queue(skill, limit): EvaluationTask.kinds / signals / priority'

/** The §42 capability frontier behind the self-model readings. */
const FRONTIER_INPUT = 'ctx.evolutionSelfModel.gaps(): FrontierGap.score'

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
  /** Newest sessions one coding report reads, and covers when its query sets no limit; default 200. */
  maxSessions?: number
  /** Newest benchmark outcomes a long-horizon report covers when its query sets no limit; default 200. */
  maxOutcomes?: number
  /**
   * Flat price of one million billed tokens in USD, or absent when the
   * deployment prices nothing — then every dollar reading over a coding window
   * is unmeasurable. The harness owns no per-route price data, so this is the
   * deployment's own rate, the same one its budget ceilings bill at.
   */
  usdPerMillionTokens?: number
}

/** Normalized configuration used by the metric layer. */
export interface ResolvedConfig {
  /** Newest engine runs one report covers when the query sets no limit. */
  windowRuns: number
  /** Runs each half of the split needs before a gain is reported. */
  minimumRunsPerHalf: number
  /** Failure signals one recurrence reading covers. */
  maxSignals: number
  /** Newest sessions one coding report reads, and covers when its query sets no limit. */
  maxSessions: number
  /** Newest benchmark outcomes a long-horizon report covers when its query sets no limit. */
  maxOutcomes: number
  /** Price of one million billed tokens in USD, or undefined when unpriced. */
  usdPerMillionTokens: number | undefined
}

/**
 * Resolve defaults for the optional fields. A price is optional — the dollar
 * readings report unmeasurable without one — but a stated price no comparison
 * could use fails plugin load instead of silently pricing every reading as
 * unmeasurable.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 * @throws When `usdPerMillionTokens` is not a positive finite number.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const {
    windowRuns = 200,
    minimumRunsPerHalf = 2,
    maxSignals = 50,
    maxSessions = 200,
    maxOutcomes = 200,
    usdPerMillionTokens,
  } = config
  if (usdPerMillionTokens !== undefined && (!Number.isFinite(usdPerMillionTokens) || usdPerMillionTokens <= 0)) {
    throw new Error(
      `evolution-metrics: usdPerMillionTokens must be a positive finite number, got ${String(usdPerMillionTokens)}`,
    )
  }
  return { windowRuns, minimumRunsPerHalf, maxSignals, maxSessions, maxOutcomes, usdPerMillionTokens }
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
    maxSessions: z.number().int().min(1).default(200),
    maxOutcomes: z.number().int().min(1).default(200),
    usdPerMillionTokens: z.number().optional(),
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
   * north star is reported per compute denominator — billed cost, tokens, and
   * compute hours — and every supporting metric is either measured from the
   * store that owns it or reported unmeasurable with the missing record named.
   * Reads only.
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
    const tokens = series.reduce((sum, run) => sum + run.tokens, 0)
    const wallTimeMs = series.reduce((sum, run) => sum + run.wallTimeMs, 0)
    // One read of the budget's spend table serves both the billed-cost
    // denominator and the search-overhead ratio.
    const spends: readonly SpendRecord[] | undefined = this.ctx.get('evolutionBudget')?.spends()
    return {
      window,
      northStar: this.northStar(gain, gap, series, tokens, wallTimeMs, spends),
      supporting: this.supporting(window, gain, gap, tokens, spends),
    }
  }

  /**
   * Measure the §13.2 coding metric set over one window of recorded session
   * logs. Every value is computed on demand from the events the kernel, the
   * trace, and the feedback stores already wrote: nothing is appended, nothing
   * is re-recorded, and a metric whose records the window does not hold names
   * the missing record instead of reporting a zero.
   *
   * The window covers the sessions storage lists, narrowed by the query bounds
   * on each session's newest event and by the query's newest-first limit, and
   * `maxSessions` bounds how many of the newest-created sessions are read at
   * all. Each log is folded through the kernel's own metric fold, so a counter
   * the kernel owns is read, never recomputed.
   * @param query - which sessions the window covers; omitted fields take defaults.
   * @returns the session window and the readings in spec order.
   */
  async coding(query: CodingQuery = {}): Promise<CodingReport> {
    const persistence = this.ctx.get('sessionPersistence')
    const gap = persistence === undefined
      ? 'the session persistence store is not mounted, so no recorded session is read'
      : 'the session store lists no session with a recorded event'
    const folded = persistence === undefined ? [] : await this.foldSessions(persistence)
    // An empty log contributes no reading, so it is not a session of the window.
    const window = folded
      .filter((facts): facts is CodingSessionFacts & { updatedAt: string } => facts.updatedAt !== null)
      .filter(facts => this.inWindow(facts.updatedAt, query.since, query.until))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, query.limit ?? this.resolved.maxSessions)
    return {
      window: {
        sessions: window.length,
        from: window.at(-1)?.updatedAt ?? null,
        to: window[0]?.updatedAt ?? null,
      },
      metrics: codingMetrics(window, gap),
    }
  }

  /**
   * Measure the §13.5 long-horizon set over one window of recorded benchmark
   * outcomes: for each horizon tier, success, process discipline, recoveries,
   * context pressure, and budget usage.
   *
   * The window covers the outcomes `ctx.evolutionBenchmark.run()` recorded,
   * newest first, narrowed by the query and bounded by `maxOutcomes`. Every
   * reading aggregates the outcome rows alone: each row was folded from its
   * run's own harvested sessions when the run was recorded, so nothing is
   * re-read here and a store that is not mounted makes the whole set
   * unmeasurable with the missing store named.
   * @param query - which outcomes the window covers; omitted fields take defaults.
   * @returns the outcome window and one entry per shipped horizon tier.
   */
  longHorizon(query: LongHorizonQuery = {}): LongHorizonReport {
    const store = this.ctx.get('evolutionBenchmark')
    const gap = store === undefined
      ? 'the benchmark store is not mounted, so no task outcome is recorded'
      : 'no benchmark task outcome is recorded: `ctx.evolutionBenchmark.run()` executes a task and records'
        + ' whether it passed'
    const window = store === undefined
      ? []
      : store.outcomes()
        .filter(outcome => this.inWindow(outcome.at, query.since, query.until))
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, query.limit ?? this.resolved.maxOutcomes)
    return longHorizonReport(window, gap)
  }

  /**
   * Fold the newest listed sessions' committed logs, newest-created first.
   * `list()` promises no order, so the `createdAt` of each header orders the
   * read and a session's own id breaks a tie.
   * @param persistence - the session storage seam to read.
   * @returns one fold per read session, newest-created first.
   */
  private async foldSessions(persistence: SessionPersistence): Promise<CodingSessionFacts[]> {
    const listed = [...await persistence.list()]
      .sort((left, right) => right.header.createdAt - left.header.createdAt
        || left.header.id.localeCompare(right.header.id))
      .slice(0, this.resolved.maxSessions)
    const folded: CodingSessionFacts[] = []
    for (const snapshot of listed) {
      const handle = await persistence.open(snapshot.header.id, 'read')
      try {
        folded.push(readCodingSession(
          String(snapshot.header.id),
          (await handle.read(0)).events,
          this.resolved.usdPerMillionTokens,
        ))
      } finally {
        await handle.close()
      }
    }
    return folded
  }

  /**
   * Measure the §13.3 research metric set over one window of recorded research
   * runs and the claim and observation records their sessions logged. The
   * window covers the runs `ctx.research` holds, newest first, narrowed by the
   * query; each of their sessions is opened once and folded into the ledger
   * the runs' references resolve through, so nothing is copied and nothing is
   * written.
   *
   * Research work is what the run records scope: a session's claims and
   * observations enter the metric set through the stages of its runs, never
   * through the session log alone. A store that is not mounted makes the whole
   * set unmeasurable with the missing store named.
   * @param query - which runs the window covers; omitted fields take defaults.
   * @returns the run window and the seven research metrics in spec order.
   */
  async research(query: ResearchQuery = {}): Promise<ResearchReport> {
    const controller = this.ctx.get('research')
    const persistence = this.ctx.get('sessionPersistence')
    const covered = controller === undefined ? undefined : this.coveredRuns(controller.runs(), query)
    const runs = covered?.length ?? 0
    const work = covered === undefined || persistence === undefined
      ? []
      : await this.readResearchWork(covered, persistence)
    const gap = this.researchGap(controller !== undefined, persistence !== undefined, runs)
    return {
      window: {
        sessions: work.length,
        runs,
        from: this.runEdge(covered?.[covered.length - 1]),
        to: this.runEdge(covered?.[0]),
      },
      metrics: researchMetrics(work, gap),
    }
  }

  /**
   * Measure the §13.4 mentor metric set over one learner's durable record and
   * the misconception cycles recorded for them. Both stores are read, never
   * written; a store that is not mounted leaves the metrics that read it
   * unmeasurable with that store named, and a learner with nothing recorded
   * names the record each metric is missing.
   * @param query - the learner whose recorded work the report covers.
   * @returns the learner and the six mentor metrics in spec order.
   */
  mentor(query: MentorQuery): MentorReport {
    return {
      learnerId: String(query.learnerId),
      metrics: mentorMetrics({
        learner: this.ctx.get('learnerModel')?.read(query.learnerId),
        pipelines: this.ctx.get('misconception')?.pipelines(query.learnerId),
      }),
    }
  }

  /**
   * Measure the §43 uncertainty read model over the evaluation-task queue
   * `ctx.evolutionUncertainty` derives from its durable signals: how deep that
   * queue is, and how much of it more than one kind of evidence agrees on.
   *
   * The store groups the signals and ranks the queue; nothing here re-derives
   * either, so this report only presents the read model the store already
   * owns. A store that is not mounted leaves both readings unmeasurable with
   * the store named, while a mounted store holding no signal is an empty
   * queue: a measured zero tasks, not a missing record.
   * @param query - which skill's signals the queue covers, and how many tasks it may hold.
   * @returns the queue and the two uncertainty readings in spec order.
   */
  uncertainty(query: UncertaintyQuery = {}): UncertaintyReport {
    const store = this.ctx.get('evolutionUncertainty')
    const unmounted = 'the evolution uncertainty store is not mounted, so no evaluation task is queued'
    const tasks: readonly EvaluationTask[] = store?.queue(query.skill, query.limit) ?? []
    return {
      window: {
        skill: query.skill ?? null,
        tasks: tasks.length,
        signals: tasks.reduce((total, task) => total + task.signals, 0),
        topPriority: tasks[0]?.priority ?? null,
      },
      metrics: [
        store === undefined
          ? unavailable('uncertainty-queue-depth', 'count', [QUEUE_INPUT], unmounted)
          : metric(
            'uncertainty-queue-depth',
            tasks.length,
            'count',
            [QUEUE_INPUT],
            'the store\'s own queue limit caps the rows, so a deployment that caps it low reads the cap rather'
            + ' than every signal it holds; a task leaves the queue when its signals are resolved, and a task'
            + ' that is still queued is one nobody re-evaluated yet',
          ),
        rate(
          'uncertainty-corroboration',
          'share',
          tasks.filter(task => task.kinds.length > 1).length,
          tasks.length,
          [QUEUE_INPUT],
          store === undefined
            ? unmounted
            : 'no evaluation task is queued: a signal is recorded through `ctx.evolutionUncertainty.record()`,'
              + ' and every task leaves the queue once its signals are resolved',
          'a task counts as corroborated when more than one of the five §43 kinds flagged it, whatever signal'
            + ' count each kind contributed, so the share measures independent agreement rather than volume',
        ),
      ],
    }
  }

  /**
   * Measure the §42 self-model read model over the capability frontier
   * `ctx.evolutionSelfModel` ranks from its durable per-capability entries: how
   * weak the frontier stands overall, and how weak its weakest entry is.
   *
   * The store merges the assessments and ranks the frontier; nothing here
   * re-derives either, so this report only presents the read model the store
   * already owns. A store that is not mounted leaves both readings
   * unmeasurable with the store named, and a mounted store holding no entry
   * names the observation that would have ranked one.
   * @returns the frontier and the two self-model readings in spec order.
   */
  selfModel(): SelfModelReport {
    const store = this.ctx.get('evolutionSelfModel')
    const unmounted = 'the evolution self-model store is not mounted, so no capability is ranked'
    const gaps: readonly FrontierGap[] = store?.gaps() ?? []
    const weakest = gaps[0]
    return {
      window: {
        skills: store?.assessments().length ?? 0,
        capabilities: gaps.length,
      },
      metrics: [
        rate(
          'self-model-frontier-pass-rate',
          'share',
          gaps.reduce((total, gap) => total + gap.score, 0),
          gaps.length,
          [FRONTIER_INPUT],
          store === undefined
            ? unmounted
            : 'no capability entry is recorded: a capability is entered when an attempt of it is observed'
              + ' through `ctx.evolutionSelfModel.observe()`',
          'the unweighted mean of the frontier\'s running pass rates, so a capability backed by two observations'
            + ' counts as much as one backed by twenty; the recorded confidence beside each score is what says'
            + ' how much evidence the score rests on',
        ),
        weakest === undefined
          ? unavailable(
            'self-model-weakest-pass-rate',
            'share',
            [FRONTIER_INPUT],
            store === undefined
              ? unmounted
              : 'no capability entry is recorded, so the frontier has no weakest capability',
          )
          : metric(
            'self-model-weakest-pass-rate',
            weakest.score,
            'share',
            [FRONTIER_INPUT],
            `the running pass rate of the capability the frontier ranks first, '${weakest.capability}', which`
              + ` is what \`nextToLearn()\` returns; the rank breaks ties on ${String(weakest.confidence)}`
              + ' confidence and then on covering skills, so a thin-evidence capability can lead a stronger one',
          ),
      ],
    }
  }

  /** The recorded runs one research query covers, newest first. */
  private coveredRuns(
    runs: readonly ResearchRunRecord[],
    query: ResearchQuery,
  ): readonly ResearchRunRecord[] {
    return runs
      .filter(run => query.sessionId === undefined || run.sessionId === query.sessionId)
      .filter(run => this.inWindow(runInstant(run), query.since, query.until))
      .slice(0, query.limit ?? runs.length)
  }

  /**
   * Fold the ledger of every session the window's runs belong to. A session is
   * opened once however many of its runs the window covers.
   * @param runs - the window's runs.
   * @param persistence - the session storage seam to read.
   * @returns one work item per session the runs belong to.
   */
  private async readResearchWork(
    runs: readonly ResearchRunRecord[],
    persistence: SessionPersistence,
  ): Promise<ResearchWork[]> {
    const work: ResearchWork[] = []
    for (const sessionId of [...new Set(runs.map(run => run.sessionId))]) {
      const handle = await persistence.open(SessionId(sessionId), 'read')
      try {
        work.push({
          sessionId,
          runs: runs.filter(run => run.sessionId === sessionId),
          ledger: readResearchLedger((await handle.read(0)).events),
        })
      } finally {
        await handle.close()
      }
    }
    return work
  }

  /** Why the research metric set has no population, naming the missing store or the empty window. */
  private researchGap(controller: boolean, persistence: boolean, runs: number): string {
    if (!controller) return 'the research controller is not mounted, so no research run is recorded'
    if (!persistence) return 'the session persistence store is not mounted, so no claim or observation is read'
    return `the query covers ${runs} recorded research run${runs === 1 ? '' : 's'}`
  }

  /** The instant a run stands at in the window, or null when the window is empty. */
  private runEdge(run: ResearchRunRecord | undefined): string | null {
    return run === undefined ? null : runInstant(run)
  }

  /**
   * The recorded runs of one window, oldest first so the halves split by time.
   * Absent when the meta store is not mounted.
   */
  private runsIn(query: MetricsQuery): readonly EngineRun[] | undefined {
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

  /**
   * Capability gain per unit of compute, one entry per recorded denominator.
   * @param gain - the window's pass-rate gain, or undefined when it is not evidenced.
   * @param gap - why the gain is missing, repeated by the token and hour entries.
   * @param runs - the window's runs, oldest first.
   * @param tokens - tokens the window's runs recorded.
   * @param wallTimeMs - wall time the window's runs recorded, in milliseconds.
   * @param spends - the budget's spend records, or undefined when the store is not mounted.
   * @returns the per-cost-unit reading first, then the token and compute-hour ones.
   */
  private northStar(
    gain: number | undefined,
    gap: string,
    runs: readonly EngineRun[],
    tokens: number,
    wallTimeMs: number,
    spends: readonly SpendRecord[] | undefined,
  ): readonly MetricValue[] {
    const tokensUnit = 'gain-per-million-tokens' as const
    const timeUnit = 'gain-per-compute-hour' as const
    const perCost = this.gainPerCostUnit(gain, gap, runs, spends)
    if (gain === undefined) {
      return [
        perCost,
        unavailable('capability-gain-per-million-tokens', tokensUnit, [RUN_INPUT], gap),
        unavailable('capability-gain-per-compute-hour', timeUnit, [RUN_INPUT], gap),
      ]
    }
    const perTokens = gainPerMillionTokens(gain, tokens)
    const perHour = gainPerComputeHour(gain, wallTimeMs)
    return [
      perCost,
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

  /**
   * The north star's billed-cost denominator: the same window's runs divided
   * by the cost their own batches recorded. A run is recorded under the batch
   * identity its producer spends against, so the cost of a run is the spend of
   * that batch. Partial billing is not a measurement, so the reading is
   * unmeasurable unless every run of the window recorded a spend and every
   * spend of it carries a cost, naming the run or spend that left the bill
   * open rather than reporting a denominator that is smaller than the compute
   * it stands for.
   * @param gain - the window's pass-rate gain, or undefined when it is not evidenced.
   * @param gap - why the gain is missing.
   * @param runs - the window's runs, whose batch identity each spend is matched against.
   * @param spends - the budget's spend records, or undefined when the store is not mounted.
   * @returns the gain per cost unit, or the reading naming the bill it cannot read.
   */
  private gainPerCostUnit(
    gain: number | undefined,
    gap: string,
    runs: readonly EngineRun[],
    spends: readonly SpendRecord[] | undefined,
  ): MetricValue {
    const id = 'capability-gain-per-cost-unit' as const
    const unit = 'gain-per-cost-unit' as const
    const inputs = [
      'ctx.evolutionMeta.runs(): EngineRun.runId',
      'ctx.evolutionBudget.spends(): SpendRecord.batchId / cost',
    ]
    if (gain === undefined) return unavailable(id, unit, inputs, gap)
    if (spends === undefined) {
      return unavailable(id, unit, inputs, 'the evolution budget store that bills a run is not mounted')
    }
    const byBatch = new Map<string, SpendRecord[]>()
    for (const spend of spends) {
      const rows = byBatch.get(spend.batchId)
      if (rows === undefined) byBatch.set(spend.batchId, [spend])
      else rows.push(spend)
    }
    let billed = 0
    for (const run of runs) {
      const rows = byBatch.get(run.runId)
      if (rows === undefined) {
        return unavailable(
          id,
          unit,
          inputs,
          `the run '${run.runId}' recorded no spend on its own batch, so the cost of the compute that produced`
          + ' the window\'s gain is not recorded; the engine-run producer records the run, and the batch spend'
          + ' that bills it is a separate write',
        )
      }
      for (const row of rows) {
        if (row.cost === undefined) {
          return unavailable(
            id,
            unit,
            inputs,
            `the spend of the run '${run.runId}' carries no billed cost: \`evolutionBudget.spend\` takes an optional`
            + ' `cost` and no caller sets one, so the deployment\'s cost dimension is unrecorded for every run',
          )
        }
        billed += row.cost
      }
    }
    const perCost = ratio(gain, billed)
    return perCost === undefined
      ? unavailable(id, unit, inputs, 'the window\'s runs recorded no billed cost')
      : metric(
        id,
        perCost,
        unit,
        inputs,
        'the unit is the deployment\'s own cost unit, not dollars unless it bills in dollars; the numerator is the'
        + ' run window\'s pass-rate delta, so it carries the promoted-path caveat of the other denominators',
      )
  }

  /** The supporting metrics, each measured from its own store or naming the gap. */
  private supporting(
    window: MetricsWindow,
    gain: number | undefined,
    gap: string,
    tokens: number,
    spends: readonly SpendRecord[] | undefined,
  ): readonly MetricValue[] {
    return [
      this.learningVelocity(window, gain, gap),
      this.computeOverhead(window, tokens, spends),
      this.failureRecurrence(),
      unavailable(
        'skill-incremental-utility',
        'share',
        [
          'ctx.evolutionSkillTelemetry.entries()',
          'ctx.evolutionCanary.deployments()',
          'ctx.evolutionLineage.experiments()',
          'ctx.evolutionScorer.evaluateBehavior({ baseline, candidate }): SkillScore.scores per scenario',
        ],
        'no store pairs a skill-using run with a run that used no skill: telemetry counts loads per skill,'
        + ' a canary triple measures the winner against nothing, and the scorer\'s baseline-versus-candidate replay'
        + ' is an ablation of the same skill, not a no-skill control — both arms run the scenario with the skill'
        + ' loaded, so the incremental reading needs a producer that scores one scenario with the skill absent from'
        + ' the composition and records it beside the skill-using run of that scenario',
      ),
      this.memoryUtility(),
      this.benchmarkRobustness(),
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
   * @param window - the run window the spend is aligned to.
   * @param tokens - tokens the window's runs recorded.
   * @param spends - the budget's spend records, or undefined when the store is not mounted.
   */
  private computeOverhead(
    window: MetricsWindow,
    tokens: number,
    spends: readonly SpendRecord[] | undefined,
  ): MetricValue {
    const id = 'compute-overhead-ratio' as const
    const unit = 'ratio' as const
    const inputs = ['ctx.evolutionBudget.spends(): SpendRecord.tokens', RUN_INPUT]
    if (spends === undefined) {
      return unavailable(id, unit, inputs, 'the evolution budget store is not mounted')
    }
    const { from, to } = window
    if (from === null || to === null) {
      return unavailable(id, unit, inputs, 'the window holds no run to compare a spend against')
    }
    const spent = spends
      .filter(row => this.inWindow(row.at, from, to))
      .reduce((sum, row) => sum + row.tokens, 0)
    const overhead = ratio(spent, tokens)
    return overhead === undefined
      ? unavailable(id, unit, inputs, 'the runs in the window recorded no tokens to compare the spend against')
      : metric(
        id,
        overhead,
        unit,
        inputs,
        'the two stores describe different scopes and must never be added: a spend row sums every variant the'
        + ' batch evaluated, while a run row carries the winning candidate\'s own evaluation, so this multiple is'
        + ' how much compute the search spent to find the winner the runs recorded',
      )
  }

  /**
   * The §24 utility of recalled memory: the mean estimated utility of the
   * memories the recall ledger holds, each the product of the factors the
   * profile records — retrieval relevance, decision impact, and outcome gain.
   * No record accounts for §24's source-quality factor for a recalled memory,
   * and nothing records whether a recalled item was used or cited, so the
   * reading is that three-factor product and its caveat says exactly which
   * links are missing rather than reporting them as zero.
   */
  private memoryUtility(): MetricValue {
    const id = 'memory-utility' as const
    const unit = 'share' as const
    const inputs = ['ctx.evolutionMemory.recallUtility(): MemoryUtility.utility']
    const memory = this.ctx.get('evolutionMemory')
    if (memory === undefined) return unavailable(id, unit, inputs, 'the evolution memory store is not mounted')
    const readings: readonly MemoryUtility[] = memory.recallUtility()
    if (readings.length === 0) {
      return unavailable(
        id,
        unit,
        inputs,
        'no recall row is recorded: a recall is counted when the reviewer attaches it through'
        + ' `addContextItem` with the `Recall: ` label, and no scope has served one yet',
      )
    }
    const mean = readings.reduce((sum, reading) => sum + reading.utility, 0) / readings.length
    return metric(
      id,
      mean,
      unit,
      inputs,
      `the mean of ${readings.length} recalled memories, each relevance x decision impact x outcome gain, where`
      + ' relevance is n/(n+1) over its recorded recalls, decision impact is the share of them a recorded decision'
      + ' batch followed, and outcome gain is the share of them graded clean. Two §23 links are not recorded and'
      + ' contribute nothing: whether an injected item was used at all, and whether it was cited. §24\'s fourth'
      + ' factor, source quality, likewise has no recorded source for a recalled memory',
    )
  }

  /** Share of executed benchmark tasks whose recorded run passed. */
  private benchmarkRobustness(): MetricValue {
    const id = 'benchmark-robustness' as const
    const unit = 'share' as const
    const inputs = ['ctx.evolutionBenchmark.outcomes(): BenchmarkOutcome.pass / status']
    const store = this.ctx.get('evolutionBenchmark')
    if (store === undefined) {
      return unavailable(id, unit, inputs, 'the benchmark store is not mounted, so no executed task records'
        + ' whether it passed')
    }
    const rows = store.outcomes()
    const scored = rows.filter(row => row.status === 'scored')
    if (scored.length === 0) {
      return unavailable(id, unit, inputs, rows.length === 0
        ? 'no benchmark task outcome is recorded: `ctx.evolutionBenchmark.run()` executes a task and records'
          + ' whether it passed'
        : `every one of the ${rows.length} recorded outcomes is a failed run, so no executed task reached a verdict`)
    }
    return metric(
      id,
      scored.filter(row => row.pass).length / scored.length,
      unit,
      inputs,
      'the share covers the outcomes recorded for executed tasks, not every task the store holds: a task nobody'
      + ' ran has no outcome and is not counted, and a failed run is named in the long-horizon window rather'
      + ' than counted as a task that did not pass',
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
    const entries: readonly { name: string; usage: SkillUsageRecord }[] = telemetry.entries()
    const sessionIds = [...new Set(entries.flatMap(entry => entry.usage.sessionIds))]
    if (sessionIds.length === 0) {
      return unavailable(id, unit, inputs, 'no skill load recorded a session, so there is no session to aggregate over')
    }
    const signals: readonly FeedbackSignal[] = feedback.signals(sessionIds, this.resolved.maxSignals)
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
    const debt: readonly RegressionDebt[] = curator.debt()
    return metric(
      id,
      debt.length,
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
    const experiments: readonly ExperimentEnvelope[] = lineage.experiments()
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
    const summary: DeploymentSummary = canary.summary()
    const { byState } = summary
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
    const summary: EvaluatorHealthSummary = health.summary()
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
