/**
 * Pure helpers for the adaptive model-routing store: role topology, evidence
 * aggregation, and recommendation. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-model-routes/src/routes
 */

import type { EvolutionRole, ModelRoute, RouteEvidence, RouteOrigin, RouteRow, RouteSummary } from './types.ts'

/** The evolutionary role topology, in spec §28 order. */
export const EVOLUTION_ROLES = [
  'task-execution',
  'reflection',
  'candidate-generation',
  'evaluation',
  'promotion-review',
] as const satisfies readonly EvolutionRole[]

/** The ways a route can enter the assignment set. */
export const ROUTE_ORIGINS = ['observed', 'pinned'] as const satisfies readonly RouteOrigin[]

/**
 * The storage key of one route: provider and model joined with a separator
 * that can never appear in either name.
 * @param route - the route to key.
 * @returns the route key.
 */
export function routeKey(route: ModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Merge one role's route rows with their evidence into per-route summaries:
 * run counts, pass rate, mean tokens, and the newest evidence instant. Routes
 * with no recorded runs carry a zero pass rate and null last instant.
 * @param rows - the role's route rows.
 * @param evidence - every recorded evidence row, filtered to the role.
 * @param role - the role to summarize.
 * @returns the summaries, ordered by provider then model.
 */
export function mergeEvidence(
  rows: readonly RouteRow[],
  evidence: readonly RouteEvidence[],
  role: EvolutionRole,
): RouteSummary[] {
  const runsByKey = new Map<string, { runs: number; passes: number; tokens: number; lastAt: string | null }>()
  for (const row of evidence) {
    if (row.role !== role) continue
    const key = routeKey(row)
    const current = runsByKey.get(key) ?? { runs: 0, passes: 0, tokens: 0, lastAt: null }
    current.runs += 1
    if (row.pass) current.passes += 1
    current.tokens += row.tokens
    if (current.lastAt === null || row.at > current.lastAt) current.lastAt = row.at
    runsByKey.set(key, current)
  }
  const summaries: RouteSummary[] = []
  for (const row of rows) {
    if (row.role !== role) continue
    const measured = runsByKey.get(routeKey(row))
    if (measured === undefined) {
      summaries.push({
        role,
        provider: row.provider,
        model: row.model,
        origin: row.origin,
        runs: 0,
        passRate: 0,
        meanTokens: 0,
        lastAt: null,
      })
      continue
    }
    summaries.push({
      role,
      provider: row.provider,
      model: row.model,
      origin: row.origin,
      runs: measured.runs,
      passRate: measured.passes / measured.runs,
      meanTokens: measured.tokens / measured.runs,
      lastAt: measured.lastAt,
    })
  }
  summaries.sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
  return summaries
}

/**
 * Recommend the route for one role: the pinned assignment when one exists,
 * otherwise the route with the strongest recorded evidence (pass rate, then
 * fewer mean tokens), and only among routes with at least one recorded run.
 * Yields undefined when the role has no pinned assignment and no measured
 * route.
 * @param rows - the role's route rows.
 * @param summaries - the role's merged summaries.
 * @param role - the role to recommend for.
 * @returns the recommended route, or undefined when none qualifies.
 */
export function bestRoute(
  rows: readonly RouteRow[],
  summaries: readonly RouteSummary[],
  role: EvolutionRole,
): ModelRoute | undefined {
  const assigned = rows.filter(row => row.role === role)
  const pinned = assigned.filter(row => row.origin === 'pinned')
    .sort((left, right) => right.at.localeCompare(left.at))[0]
  if (pinned !== undefined) return { provider: pinned.provider, model: pinned.model }
  const evidenceByKey = new Map(summaries
    .filter(summary => summary.role === role && summary.runs > 0)
    .map(summary => [routeKey(summary), summary]))
  const measured = assigned
    .map(row => evidenceByKey.get(routeKey(row)))
    .filter((summary): summary is RouteSummary => summary !== undefined)
    .sort((left, right) =>
      right.passRate - left.passRate
      || left.meanTokens - right.meanTokens)[0]
  if (measured !== undefined) return { provider: measured.provider, model: measured.model }
  return undefined
}
