/**
 * Pure helpers for meta-evolution: the engine components, the deterministic
 * configuration identity over a configuration and its workflow (§26 level 2),
 * the readable form of the sequence, the running summary update from one
 * engine run, the sample-confidence-adjusted score, and the recommendation of
 * which engine configuration and workflow to run next on a task class. No I/O,
 * no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-meta/src/meta
 */

import type {
  ConfigRecommendation,
  ConfigSummary,
  EngineConfig,
  EngineRun,
  MetaTaskClass,
  WorkflowStep,
} from './types.ts'

/** The four engine components an engine configuration selects, in order. */
export const ENGINE_COMPONENTS: readonly string[] = ['operators', 'evaluator', 'budget', 'routing']

/**
 * The readable identity of one workflow: its stages in the order the run
 * performed them, each naming the component and the choice it used. A sequence
 * is what the identity carries, so two runs of the same components in
 * different orders never share an identity.
 * @param workflow - the recorded sequence.
 * @returns the identity, e.g. `operators=portfolio-v1>evaluator=scorer-v1`.
 */
export function workflowIdOf(workflow: readonly WorkflowStep[]): string {
  return workflow.map(step => `${step.component}=${step.choice}`).join('>')
}

/**
 * The deterministic identity of one engine configuration and workflow
 * together: its four choices joined, closed by the sequence. Equal
 * configurations run in the same order always share one identity, and a
 * different order is a different identity. Both field orders are fixed by
 * construction, so the identity never depends on key order.
 * @param config - the configuration to identify.
 * @param workflow - the sequence the run performed.
 * @returns the identity.
 */
export function configIdOf(config: EngineConfig, workflow: readonly WorkflowStep[]): string {
  return `${config.operators}\0${config.evaluator}\0${config.budget}\0${config.routing}\0${workflowIdOf(workflow)}`
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
 * @param minimumSamples - runs needed before a summary reads as fully confident.
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
    configId: configIdOf(run.config, run.workflow),
    config: run.config,
    workflow: [...run.workflow],
    workflowId: workflowIdOf(run.workflow),
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
 * Summarize engine runs into per-configuration-and-workflow summaries, grouped
 * by task class, each class scored and sorted score descending with identity
 * ascending tie-break.
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
    const key = `${run.taskClass}\0${configIdOf(run.config, run.workflow)}`
    grouped.set(key, updatedSummary(grouped.get(key), run, minimumSamples))
  }
  return [...grouped.values()].sort((left, right) =>
    left.taskClass.localeCompare(right.taskClass)
    || right.score - left.score
    || left.configId.localeCompare(right.configId))
}

/**
 * The engine configuration and workflow to run next on one task class: the
 * best-scored configuration with at least the minimum number of runs. Yields
 * undefined while no configuration has that much evidence.
 * @param summaries - the derived configuration summaries.
 * @param taskClass - the task class to recommend for.
 * @param minimumSamples - runs a configuration needs before it may be recommended.
 * @returns the recommended configuration and workflow, or undefined.
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
    workflow: [...row.workflow],
    workflowId: row.workflowId,
    configId: row.configId,
    taskClass: row.taskClass,
    score: row.score,
    samples: row.samples,
    passRate: row.passRate,
    reason: describeRecommendation(row),
  }
}

/**
 * Render why one configuration and workflow is recommended, naming the
 * numbers and the sequence. A summary whose runs recorded no sequence says so,
 * rather than presenting a scalar choice as a workflow.
 * @param summary - the summary to describe.
 * @returns the reason sentence.
 */
function describeRecommendation(summary: ConfigSummary): string {
  const numbers = `${summary.passes}/${summary.samples} passed (${summary.passRate.toFixed(2)}), ${summary.meanTokens.toFixed(0)} mean tokens, score ${summary.score.toFixed(3)}`
  return summary.workflow.length === 0
    ? `${numbers}, workflow unrecorded`
    : `${numbers}, workflow ${summary.workflowId}`
}
