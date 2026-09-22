/**
 * Pure helpers for routing self-optimization: the evolutionary role topology,
 * the running effectiveness accumulation from one route outcome, the
 * sample-confidence-adjusted score, and the ranking that says which route a
 * task class and role should use. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-router/src/router
 */

import type { RouteEffectiveness, RouteOutcome, RouteRankingEntry, RouterTaskClass, RoutingRole } from './types.ts'

/** The five §28 evolutionary roles, in canonical order. */
export const ROUTING_ROLES: readonly RoutingRole[] = [
  'task-execution',
  'reflection',
  'candidate-generation',
  'evaluation',
  'promotion-review',
]

/**
 * The grouping key of one route: task class, role, and route joined.
 * @param taskClass - the task class the route was measured on.
 * @param role - the evolutionary role the route filled.
 * @param provider - the route provider.
 * @param model - the route model.
 * @returns the grouping key.
 */
export function routeKey(taskClass: RouterTaskClass, role: RoutingRole, provider: string, model: string): string {
  return `${taskClass}\0${role}\0${provider}\0${model}`
}

/**
 * The sample-confidence-adjusted score of one route's pass rate: a beta-prior
 * smoothed pass rate scaled by how close the sample count is to the minimum,
 * so a route with few outcomes cannot outrank a well-measured one.
 * @param passes - outcomes that passed.
 * @param samples - outcomes measured.
 * @param minimumSamples - sample count at which confidence is full.
 * @returns the score.
 */
export function scoreOf(passes: number, samples: number, minimumSamples: number): number {
  const smoothed = (passes + 1) / (samples + 2)
  const confidence = Math.min(1, samples / minimumSamples)
  return smoothed * confidence
}

/**
 * Advance one route's effectiveness with one measured outcome, keeping running
 * means of tokens and wall time.
 * @param current - the effectiveness to advance, or undefined for the first outcome.
 * @param outcome - the measured outcome to fold in.
 * @returns the advanced effectiveness.
 */
export function updatedEffectiveness(
  current: RouteEffectiveness | undefined,
  outcome: RouteOutcome,
): RouteEffectiveness {
  const samples = (current?.samples ?? 0) + 1
  const passes = (current?.passes ?? 0) + (outcome.pass ? 1 : 0)
  const meanTokens = current === undefined
    ? outcome.tokens
    : current.meanTokens + (outcome.tokens - current.meanTokens) / samples
  const meanWallTimeMs = current === undefined
    ? outcome.wallTimeMs
    : current.meanWallTimeMs + (outcome.wallTimeMs - current.meanWallTimeMs) / samples
  return {
    taskClass: outcome.taskClass,
    role: outcome.role,
    provider: outcome.provider,
    model: outcome.model,
    samples,
    passes,
    passRate: passes / samples,
    meanTokens,
    meanWallTimeMs,
    lastAt: outcome.at,
  }
}

/**
 * Rank one task class's and role's routes by the sample-confidence-adjusted
 * score, score descending with provider/model ascending tie-break.
 * @param rows - every recorded effectiveness row for the task class and role.
 * @param taskClass - the task class to rank routes for.
 * @param role - the role to rank routes for.
 * @param minimumSamples - sample count at which confidence is full.
 * @returns the ranked routes, best first.
 */
export function rankRoutes(
  rows: readonly RouteEffectiveness[],
  taskClass: RouterTaskClass,
  role: RoutingRole,
  minimumSamples: number,
): RouteRankingEntry[] {
  return rows
    .filter(row => row.taskClass === taskClass && row.role === role)
    .map((row) => {
      const score = scoreOf(row.passes, row.samples, minimumSamples)
      return {
        provider: row.provider,
        model: row.model,
        samples: row.samples,
        passRate: row.passRate,
        meanTokens: row.meanTokens,
        meanWallTimeMs: row.meanWallTimeMs,
        score,
        reason: describeRanking(row, score),
      }
    })
    .sort((left, right) =>
      right.score - left.score
      || left.provider.localeCompare(right.provider)
      || left.model.localeCompare(right.model))
}

/**
 * The route to use for one task class and role: the best-ranked route with at
 * least the minimum number of measured outcomes. Yields undefined while no
 * route has that much evidence.
 * @param rankings - the ranked routes, best first.
 * @param minimumSamples - outcomes a route must have before it may be recommended.
 * @returns the recommended route, or undefined.
 */
export function recommendRoute(
  rankings: readonly RouteRankingEntry[],
  minimumSamples: number,
): RouteRankingEntry | undefined {
  return rankings.find(entry => entry.samples >= minimumSamples)
}

/**
 * Render why one route ranks as it does, naming the numbers.
 * @param row - the effectiveness to describe.
 * @param score - the score the route received.
 * @returns the reason sentence.
 */
function describeRanking(row: RouteEffectiveness, score: number): string {
  return `${row.passes}/${row.samples} passed (${row.passRate.toFixed(2)}), ${row.meanTokens.toFixed(0)} mean tokens, ${row.meanWallTimeMs.toFixed(0)} mean ms, score ${score.toFixed(3)}`
}
