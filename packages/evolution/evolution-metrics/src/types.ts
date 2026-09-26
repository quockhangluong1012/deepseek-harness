/**
 * Public vocabulary of the metric layer: one measured value with the inputs it
 * came from, the run window it summarized, and the query that selects it.
 * Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-metrics/src/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { LearnerId } from '@deepseek-ai/dsh-learner-model'

/**
 * The §13.5 long-horizon axes: how a benchmark run's recorded outcome reads on
 * each thing the spec asks a long-horizon benchmark to measure — success,
 * process discipline, recoveries, context pressure, and budget usage. Three of
 * these ids are shared with the §13.2 coding set (`recovery-efficiency`,
 * `cost`, and `latency`), because a tier's reading is the same reading over a
 * horizon-scoped window; `benchmark-robustness` is the §55 supporting metric
 * read per tier. These ids are read by {@link LongHorizonReport}.
 */
export type LongHorizonMetricId =
  | 'benchmark-robustness'
  | 'process-discipline'
  | 'recovery-efficiency'
  | 'context-pressure'
  | 'cost'
  | 'latency'

/**
 * The §13.2 coding metric set: what one window of recorded coding sessions
 * shows about agent behavior and its outcome, as opposed to what the harness's
 * evolution bought, followed by the §5.4 baseline readings the same window
 * supports. These ids are read by {@link CodingReport}.
 */
export type CodingMetricId =
  | 'verified-success'
  | 'false-completion'
  | 'regression-rate'
  | 'recovery-efficiency'
  | 'planning-fidelity'
  | 'verification-coverage'
  | 'human-intervention'
  | 'cost'
  | 'latency'
  // The §5.4 behaviour readings, folded from the same window.
  | 'loop-rate'
  | 'tool-failure-rate'
  | 'subagent-waste'
  | 'context-utilization'
  | 'average-tokens'
  | 'verified-success-per-usd'
  | 'verified-success-per-million-tokens'
  | 'verified-success-per-10-minutes'
  // The §18.3 kernel counters the §13.2 and §5.4 sets do not already express.
  | 'task-success-rate'
  | 'verification-pass-rate'
  | 'steps'
  | 'tool-calls'
  | 'policy-denials'
  | 'approval-rejections'
  | 'checkpoint-resume-rate'

/** One reported metric: the spec's north star, its supporting set, and the substrate facts. */
export type MetricId =
  | 'capability-gain-per-cost-unit'
  | 'capability-gain-per-million-tokens'
  | 'capability-gain-per-compute-hour'
  | 'learning-velocity'
  | 'compute-overhead-ratio'
  | 'failure-recurrence'
  | 'skill-incremental-utility'
  | 'memory-utility'
  | 'benchmark-robustness'
  | 'regression-debt'
  | 'promotion-quality'
  | 'rollback-rate'
  | 'evaluator-reliability'
  | LongHorizonMetricId
  | CodingMetricId
  | ResearchMetricId
  | MentorMetricId
  | UncertaintyMetricId
  | SelfModelMetricId

/**
 * The §13.3 research metric set: what one window of recorded research runs
 * shows about the claims it asserted, the observations those claims cite, and
 * the answer its own review accepted. These ids are read by
 * {@link ResearchReport}.
 */
export type ResearchMetricId =
  | 'claim-accuracy'
  | 'source-quality'
  | 'evidence-coverage'
  | 'contradiction-recall'
  | 'uncertainty-calibration'
  | 'citation-correctness'
  | 'unsupported-claim-rate'

/**
 * The §13.4 mentor metric set: what one learner's record and the misconception
 * cycles recorded for them show about detection, teaching, and whether the
 * learning held. These ids are read by {@link MentorReport}.
 */
export type MentorMetricId =
  | 'misconception-detection'
  | 'explanation-quality'
  | 'exercise-relevance'
  | 'learning-improvement'
  | 'retention'
  | 'repeated-mistake-reduction'

/**
 * The §43 uncertainty read model: what the store's grouped signals say about
 * how much work the evaluation queue holds and how much of it more than one
 * kind of evidence agrees on. These ids are read by {@link UncertaintyReport}.
 */
export type UncertaintyMetricId =
  | 'uncertainty-queue-depth'
  | 'uncertainty-corroboration'

/**
 * The §42 self-model read model: how weak the capability frontier the store
 * ranks stands overall, and how weak its weakest entry is. These ids are read
 * by {@link SelfModelReport}.
 */
export type SelfModelMetricId =
  | 'self-model-frontier-pass-rate'
  | 'self-model-weakest-pass-rate'

/** How to read a metric's number. */
export type MetricUnit =
  | 'gain-per-cost-unit'
  | 'gain-per-million-tokens'
  | 'gain-per-compute-hour'
  | 'gain-per-day'
  | 'share'
  | 'ratio'
  | 'count'
  | 'tokens'
  | 'milliseconds'
  | 'usd'
  | 'count-per-usd'
  | 'count-per-million-tokens'
  | 'count-per-10-minutes'

/**
 * One measured value. `value` is null exactly when the records a metric needs
 * are not recorded anywhere; `unavailableReason` then names what is missing,
 * so a reader can tell "nothing improved" from "nothing was measured".
 */
export interface MetricValue {
  /** Which metric this is. */
  id: MetricId
  /** The measurement, or null when it is not computable. */
  value: number | null
  /** How to read `value`. */
  unit: MetricUnit
  /** The exact store, read path, and fields the value was computed from. */
  inputs: readonly string[]
  /** Why the metric is not computable; null when `value` is measured. */
  unavailableReason: string | null
  /** What the number does not tell you; null when the measurement is complete. */
  caveat: string | null
}

/** Which recorded runs a report covers. */
export interface MetricsQuery {
  /** Restrict the run window to one task class; all classes when absent. */
  taskClass?: string
  /** Drop runs recorded before this ISO-8601 instant. */
  since?: string
  /** Drop runs recorded after this ISO-8601 instant. */
  until?: string
  /** Keep at most this many of the newest runs in the window. */
  limit?: number
}

/** The run window a report summarized, and the two half-rates it compared. */
export interface MetricsWindow {
  /** The task class the window covers, or null for every class. */
  taskClass: string | null
  /** Runs in the window, after filtering and the newest-first limit. */
  runs: number
  /** ISO-8601 instant of the oldest run in the window, or null when empty. */
  from: string | null
  /** ISO-8601 instant of the newest run in the window, or null when empty. */
  to: string | null
  /** Runs in the older half the gain is measured against. */
  baselineRuns: number
  /** Runs in the newer half the gain is measured over. */
  treatmentRuns: number
  /** Pass rate of the older half, or null while it holds too few runs. */
  baselinePassRate: number | null
  /** Pass rate of the newer half, or null while it holds too few runs. */
  treatmentPassRate: number | null
}

/** One metric report: the north star per compute denominator, plus the supporting set. */
export interface MetricsReport {
  /** The run window every run-derived metric was computed over. */
  window: MetricsWindow
  /** Capability gain divided by the compute spent, one entry per denominator. */
  northStar: readonly MetricValue[]
  /** The spec's supporting metrics, each measured or naming why it is not. */
  supporting: readonly MetricValue[]
}

/** Which recorded sessions a coding report covers. */
export interface CodingQuery {
  /** Drop sessions whose newest recorded event is before this ISO-8601 instant. */
  since?: string
  /** Drop sessions whose newest recorded event is after this ISO-8601 instant. */
  until?: string
  /** Keep at most this many of the newest sessions in the window. */
  limit?: number
}

/** The session window a coding report summarized. */
export interface CodingWindow {
  /** Sessions folded into the report, after filtering and the newest-first limit. */
  sessions: number
  /** ISO-8601 instant of the oldest folded session, or null when empty. */
  from: string | null
  /** ISO-8601 instant of the newest folded session, or null when empty. */
  to: string | null
}

/** The §13.2 coding set, the §5.4 baseline readings, and the §18.3 kernel counters over one window of recorded sessions. */
export interface CodingReport {
  /** The session window every reading was computed over. */
  window: CodingWindow
  /** The readings, in spec order, each measured or naming why it is not. */
  metrics: readonly MetricValue[]
}

/** Which recorded research runs a report covers. */
export interface ResearchQuery {
  /** Restrict the window to one session's runs; every session when absent. */
  sessionId?: SessionId
  /** Drop runs recorded before this ISO-8601 instant. */
  since?: string
  /** Drop runs recorded after this ISO-8601 instant. */
  until?: string
  /** Keep at most this many of the newest runs in the window; every recorded run when absent. */
  limit?: number
}

/** The run window a research report summarized. */
export interface ResearchWindow {
  /** Sessions whose runs the window covers. */
  sessions: number
  /** Runs in the window, after filtering and the newest-first limit. */
  runs: number
  /** ISO-8601 instant of the oldest run in the window, or null when empty. */
  from: string | null
  /** ISO-8601 instant of the newest run in the window, or null when empty. */
  to: string | null
}

/** The §13.3 research metric set over one window of recorded runs. */
export interface ResearchReport {
  /** The run window every research metric was computed over. */
  window: ResearchWindow
  /** The seven research metrics, in spec order, each measured or naming why it is not. */
  metrics: readonly MetricValue[]
}

/** Which learner a mentor report covers. */
export interface MentorQuery {
  /** The learner whose record and recorded cycles are read. */
  learnerId: LearnerId
}

/** The §13.4 mentor metric set over one learner's recorded work. */
export interface MentorReport {
  /** The learner the report covers. */
  learnerId: string
  /** The six mentor metrics, in spec order, each measured or naming why it is not. */
  metrics: readonly MetricValue[]
}

/** Which recorded benchmark outcomes a §13.5 long-horizon report covers. */
export interface LongHorizonQuery {
  /** Drop outcomes recorded before this ISO-8601 instant. */
  since?: string
  /** Drop outcomes recorded after this ISO-8601 instant. */
  until?: string
  /** Keep at most this many of the newest outcomes in the window. */
  limit?: number
}

/** The outcome window a §13.5 report summarized. */
export interface LongHorizonWindow {
  /** Outcomes in the window, after filtering and the newest-first limit. */
  tasks: number
  /** Outcomes that produced a verdict. */
  scored: number
  /** Outcomes whose run failed before a verdict; they are reported, never counted as passes. */
  failed: number
  /** ISO-8601 instant of the oldest outcome in the window, or null when empty. */
  from: string | null
  /** ISO-8601 instant of the newest outcome in the window, or null when empty. */
  to: string | null
}

/** One §13.5 horizon tier's readings. */
export interface LongHorizonTierReport {
  /** Steps the tier requires a task to span: 10, 20, 50, or the open-ended 100+. */
  tier: number
  /** Verdict-producing outcomes the tier holds. */
  tasks: number
  /** Success, process discipline, recoveries, context pressure, and budget usage, in spec order. */
  metrics: readonly MetricValue[]
}

/**
 * The §13.5 long-horizon report: one entry per shipped horizon tier, each
 * carrying the five axes the spec requires. A tier whose outcomes are not
 * recorded reports every axis unmeasurable with the missing record named,
 * rather than reporting a zero.
 */
export interface LongHorizonReport {
  /** The outcome window every tier's readings were computed over. */
  window: LongHorizonWindow
  /** The tiers, in ascending horizon order. */
  tiers: readonly LongHorizonTierReport[]
}

/** Which recorded uncertainty signals an uncertainty report covers. */
export interface UncertaintyQuery {
  /** Restrict the queue to one skill's signals; every skill when absent. */
  skill?: string
  /** Tasks the queue may hold; the store's own queue limit when absent. */
  limit?: number
}

/** The evaluation-task queue one uncertainty report summarized. */
export interface UncertaintyWindow {
  /** The skill the queue was narrowed to, or null for every skill. */
  skill: string | null
  /** Evaluation tasks the queue holds. */
  tasks: number
  /** Signals grouped into those tasks. */
  signals: number
  /** Priority of the queue's first task, or null when the queue is empty. */
  topPriority: number | null
}

/**
 * The §43 uncertainty read model over one evaluation-task queue. The store
 * groups and ranks the queue; this report only presents it, so a store that
 * is not mounted makes both readings unmeasurable with the store named.
 */
export interface UncertaintyReport {
  /** The queue every reading was computed over. */
  window: UncertaintyWindow
  /** The readings, in spec order, each measured or naming why it is not. */
  metrics: readonly MetricValue[]
}

/** The capability frontier one self-model report summarized. */
export interface SelfModelWindow {
  /** Skills the store holds an assessment for. */
  skills: number
  /** Capability entries the frontier ranks. */
  capabilities: number
}

/**
 * The §42 self-model read model over one capability frontier. The store ranks
 * the frontier; this report only presents it, so a store that is not mounted
 * makes both readings unmeasurable with the store named.
 */
export interface SelfModelReport {
  /** The frontier every reading was computed over. */
  window: SelfModelWindow
  /** The readings, in spec order, each measured or naming why it is not. */
  metrics: readonly MetricValue[]
}
