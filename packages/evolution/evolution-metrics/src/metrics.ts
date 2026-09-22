/**
 * Pure arithmetic of the metric layer: the half-window split that turns a run
 * series into a before-and-after comparison, the rates and ratios read off it,
 * and the two constructors that keep a measured value distinguishable from an
 * unmeasurable one. No service and no storage — the measured numbers are
 * tested without booting a context.
 * @module @deepseek-ai/dsh-evolution-metrics/src/metrics
 */

import type { MetricId, MetricUnit, MetricValue } from './types.ts'

/** Milliseconds in one hour, the denominator of a compute-hour. */
const MS_PER_HOUR = 3_600_000

/** Milliseconds in one day, the denominator of a learning-velocity day. */
const MS_PER_DAY = 86_400_000

/**
 * One measured value.
 * @param id - which metric this is.
 * @param value - the measurement.
 * @param unit - how to read the measurement.
 * @param inputs - the store, read path, and fields the value came from.
 * @param caveat - what the number does not tell you.
 * @returns the measured metric.
 */
export function metric(
  id: MetricId,
  value: number,
  unit: MetricUnit,
  inputs: readonly string[],
  caveat: string | null = null,
): MetricValue {
  return { id, value, unit, inputs, unavailableReason: null, caveat }
}

/**
 * One metric whose inputs are not recorded anywhere. Naming the missing
 * record is the whole result: a reader must be able to tell it apart from a
 * measured zero.
 * @param id - which metric this is.
 * @param unit - how the value would be read once recorded.
 * @param inputs - what was searched for it.
 * @param reason - the exact record, field, or write path that is missing.
 * @returns the unmeasurable metric.
 */
export function unavailable(
  id: MetricId,
  unit: MetricUnit,
  inputs: readonly string[],
  reason: string,
): MetricValue {
  return { id, value: null, unit, inputs, unavailableReason: reason, caveat: null }
}

/**
 * Split an oldest-first series into the older and newer halves the capability
 * gain compares. An odd count gives the newer half the extra run, so the
 * treatment side never sees less evidence than the baseline it is measured
 * against.
 * @param rows - the series, oldest first.
 * @returns the baseline half and the treatment half.
 */
export function splitHalves<T>(rows: readonly T[]): readonly [readonly T[], readonly T[]] {
  const baselineCount = Math.floor(rows.length / 2)
  return [rows.slice(0, baselineCount), rows.slice(baselineCount)]
}

/**
 * Share of a whole, or undefined when there is no whole to divide by.
 * @param part - the counted part.
 * @param whole - the population it belongs to.
 * @returns the share in 0..1, or undefined when `whole` is zero.
 */
export function share(part: number, whole: number): number | undefined {
  return whole === 0 ? undefined : part / whole
}

/**
 * Ratio of one measurement to another, or undefined when the denominator is
 * zero.
 * @param numerator - the measured quantity.
 * @param denominator - what it is measured against.
 * @returns the ratio, or undefined when the denominator is zero.
 */
export function ratio(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator
}

/**
 * Pass rate of a run series.
 * @param passes - runs whose winner passed.
 * @param runs - runs in the series.
 * @returns the share in 0..1, or undefined for an empty series.
 */
export function passRate(passes: number, runs: number): number | undefined {
  return share(passes, runs)
}

/**
 * Elapsed days between two ISO-8601 instants.
 * @param from - the earlier instant.
 * @param to - the later instant.
 * @returns the elapsed days, negative when `to` precedes `from`.
 */
export function elapsedDays(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / MS_PER_DAY
}

/**
 * Capability gain per million tokens spent.
 * @param gain - the pass-rate gain the window observed.
 * @param tokens - tokens the window spent.
 * @returns the gain per million tokens, or undefined when nothing was spent.
 */
export function gainPerMillionTokens(gain: number, tokens: number): number | undefined {
  const perToken = ratio(gain, tokens)
  return perToken === undefined ? undefined : perToken * 1_000_000
}

/**
 * Capability gain per hour of compute spent. Wall time is the recorded
 * scorer sum, so the hour is a compute hour, not an elapsed one.
 * @param gain - the pass-rate gain the window observed.
 * @param wallTimeMs - wall time the window spent, in milliseconds.
 * @returns the gain per compute hour, or undefined when nothing was spent.
 */
export function gainPerComputeHour(gain: number, wallTimeMs: number): number | undefined {
  const perMs = ratio(gain, wallTimeMs)
  return perMs === undefined ? undefined : perMs * MS_PER_HOUR
}

/**
 * Capability gain per elapsed day: how fast the improvement accumulated.
 * @param gain - the pass-rate gain the window observed.
 * @param elapsed - days the window spans.
 * @returns the gain per day, or undefined when the span is not positive.
 */
export function gainPerDay(gain: number, elapsed: number): number | undefined {
  return elapsed <= 0 ? undefined : gain / elapsed
}
