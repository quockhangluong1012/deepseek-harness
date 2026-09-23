/**
 * Public vocabulary of the metric layer: one measured value with the inputs it
 * came from, the run window it summarized, and the query that selects it.
 * Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-metrics/src/types
 */

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

/** How to read a metric's number. */
export type MetricUnit =
  | 'gain-per-cost-unit'
  | 'gain-per-million-tokens'
  | 'gain-per-compute-hour'
  | 'gain-per-day'
  | 'share'
  | 'ratio'
  | 'count'

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
