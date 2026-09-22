/**
 * Pure helpers for meta-evolution: the engine components, the deterministic
 * configuration identity, the running summary update from one engine run, the
 * sample-confidence-adjusted score, and the recommendation of which engine
 * configuration to run next on a task class. No I/O, no domain — fully
 * unit-testable.
 * @module @deepseek-ai/dsh-evolution-meta/src/meta
 */

import type { ConfigRecommendation, ConfigSummary, EngineConfig, EngineRun, MetaTaskClass } from './types.ts'

/** The four engine components an engine configuration selects, in order. */
export const ENGINE_COMPONENTS: readonly string[] = ['operators', 'evaluator', 'budget', 'routing']

/**
 * The deterministic identity of one engine configuration: its four choices
 * joined, so equal configurations always share one identity. Field order is
 * fixed by construction, so the identity never depends on key order.
 * @param config - the configuration to identify.
 * @returns the identity.
 */
export function configIdOf(config: EngineConfig): string {
  return `${config.operators}\0${config.evaluator}\0${config.budget}\0${config.routing}`
}

/**
 * The sample-confidence-adjusted score of one configuration's pass rate: a
 * beta-prior smoothed pass rate scaled by how close the sample count is to
 * the minimum, so a configuration with few runs cannot outrank a well-measured
 * one.
 * @param passes - runs whose winner passed.
 * @param samples - runs recorded.
 * @param minimumSamples - sample count at which confidence is full.
 * @returns the score.
 */
export function scoreOf(passes: number, samples: number, minimumSamples: number): number {
  const smoothed = (passes + 1) / (samples + 2)
  const confidence = Math.min(1, samples / minimumSamples)
  return smoothed * confidence
}

/**
 * Advance one configuration summary with one engine run, keeping the running
 * pass rate and mean tokens.
 * @param current - the summary to advance, or undefined for the first run.
 * @param run - the run to fold in.
 * @returns the advanced summary.
 */
export function updatedSummary(
  current: ConfigSummary | undefined,
  run: EngineRun,
  minimumSamples: number,
): ConfigSummary {
  const samples = (current?.samples ?? 0) + 1
  const passes = (current?.passes ?? 0) + (run.pass ? 1 : 0)
  const meanTokens = current === undefined
    ? run.tokens
    : current.meanTokens + (run.tokens - current.meanTokens) / samples
  const score = scoreOf(passes, samples, minimumSamples)
  return {
    configId: configIdOf(run.config),
    config: run.config,
    taskClass: run.taskClass,
    samples,
    passes,
    passRate: passes / samples,
    meanTokens,
    score,
    lastAt: run.at,
  }
}

/**
 * Summarize engine runs into per-configuration summaries, grouped by task
 * class, each class scored and sorted score descending with configuration
 * identity ascending tie-break.
 * @param runs - the recorded engine runs.
 * @param minimumSamples - sample count at which confidence is full.
 * @returns the summaries, grouped by task class and best configuration first.
 */
export function summarize(
  runs: readonly EngineRun[],
  minimumSamples: number,
): ConfigSummary[] {
  const grouped = new Map<string, ConfigSummary>()
  for (const run of runs) {
    const key = `${run.taskClass}\0${configIdOf(run.config)}`
    grouped.set(key, updatedSummary(grouped.get(key), run, minimumSamples))
  }
  return [...grouped.values()].sort((left, right) =>
    left.taskClass.localeCompare(right.taskClass)
    || right.score - left.score
    || left.configId.localeCompare(right.configId))
}

/**
 * The engine configuration to run next on one task class: the best-scored
 * configuration with at least the minimum number of runs. Yields undefined
 * while no configuration has that much evidence.
 * @param summaries - the derived configuration summaries.
 * @param taskClass - the task class to recommend for.
 * @param minimumSamples - runs a configuration needs before it may be recommended.
 * @returns the recommended configuration, or undefined.
 */
export function recommendConfig(
  summaries: readonly ConfigSummary[],
  taskClass: MetaTaskClass,
  minimumSamples: number,
): ConfigRecommendation | undefined {
  const row = summaries
    .filter(summary => summary.taskClass === taskClass)
    .find(summary => summary.samples >= minimumSamples)
  if (row === undefined) return undefined
  return {
    config: row.config,
    configId: row.configId,
    taskClass: row.taskClass,
    score: row.score,
    samples: row.samples,
    passRate: row.passRate,
    reason: describeRecommendation(row),
  }
}

/**
 * Render why one configuration is recommended, naming the numbers.
 * @param summary - the summary to describe.
 * @returns the reason sentence.
 */
function describeRecommendation(summary: ConfigSummary): string {
  return `${summary.passes}/${summary.samples} passed (${summary.passRate.toFixed(2)}), ${summary.meanTokens.toFixed(0)} mean tokens, score ${summary.score.toFixed(3)}`
}