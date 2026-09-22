/**
 * Pure helpers for the adaptive model-routing store: role topology, evidence
 * aggregation, and recommendation. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-model-routes/src/routes
 */

import type { EvolutionRole, ModelRoute, RoleConflict, RouteEvidence, RouteOrigin, RouteRow, RouteSummary } from './types.ts'

/** The evolutionary role topology, in spec §28 order. */
export const EVOLUTION_ROLES = [
  'task-execution',
  'reflection',
  'candidate-generation',
  'evaluation',
  'promotion-review',
] as const satisfies readonly EvolutionRole[]

/** The §28 roles that produce work, whose routes must not also judge it. */
export const PRODUCING_ROLES = [
  'task-execution',
  'reflection',
  'candidate-generation',
] as const satisfies readonly EvolutionRole[]

/** The §28 roles that judge work, which must not run on a producing route. */
export const JUDGING_ROLES = [
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
 * The §28 topology conflicts in one assignment set: routes that serve both a
 * producing role (task execution, reflection, candidate generation) and a
 * judging role (evaluation, promotion review), so the judge and the judged run
 * on the same model. Route rows are keyed uniquely per role and route, so each
 * route contributes each role once. `pinned` records whether an operator chose
 * the conflicting assignment explicitly.
 * @param rows - every route assignment.
 * @returns the conflicts, ordered by provider then model.
 */
export function roleConflicts(rows: readonly RouteRow[]): RoleConflict[] {
  const byRoute = new Map<string, { route: ModelRoute; producing: EvolutionRole[]; judging: EvolutionRole[]; pinned: boolean }>()
  for (const row of rows) {
    const key = routeKey(row)
    const entry = byRoute.get(key)
      ?? { route: { provider: row.provider, model: row.model }, producing: [], judging: [], pinned: false }
    if ((PRODUCING_ROLES as readonly EvolutionRole[]).includes(row.role)) entry.producing.push(row.role)
    else entry.judging.push(row.role)
    if (row.origin === 'pinned') entry.pinned = true
    byRoute.set(key, entry)
  }
  return [...byRoute.values()]
    .filter(entry => entry.producing.length > 0 && entry.judging.length > 0)
    .map((entry) => {
      const producing = EVOLUTION_ROLES.filter(role => entry.producing.includes(role))
      const judging = EVOLUTION_ROLES.filter(role => entry.judging.includes(role))
      return {
        route: entry.route,
        producing,
        judging,
        pinned: entry.pinned,
        detail: `route '${entry.route.provider}/${entry.route.model}' serves ${producing.join(', ')} and also judges ${judging.join(', ')}`,
      }
    })
    .sort((left, right) =>
      left.route.provider.localeCompare(right.route.provider)
      || left.route.model.localeCompare(right.route.model))
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
