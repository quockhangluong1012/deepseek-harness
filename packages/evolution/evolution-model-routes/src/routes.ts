/**
 * Pure helpers for the model-routing store: the role topology, evidence
 * aggregation, per-task-class effectiveness, and the ranking that recommends a
 * route. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-model-routes/src/routes
 */

import type {
  EvolutionRole,
  ModelRoute,
  RoleConflict,
  RouteEffectiveness,
  RouteEvidence,
  RouteMeasurement,
  RouteOrigin,
  RouteRankingEntry,
  RouteRow,
  RouteSummary,
  RouteTaskClass,
} from './types.ts'

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
 * The identity of one route: provider and model joined with a separator that
 * can never appear in either name. Every table keyed by route, and every
 * grouping of evidence, keys on this.
 * @param route - the route to key.
 * @returns the route key.
 */
export function routeKey(route: ModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * The storage key of one assignment: role and route joined.
 * @param role - the role the route serves.
 * @param route - the assigned route.
 * @returns the assignment key.
 */
export function assignmentKey(role: EvolutionRole, route: ModelRoute): string {
  return `${role}\0${routeKey(route)}`
}

/**
 * The grouping key of one route's effectiveness: the task class and role it was
 * measured for, joined with the route identity.
 * @param taskClass - the task class the route was measured on.
 * @param role - the role the route served.
 * @param route - the measured route.
 * @returns the grouping key.
 */
export function effectivenessKey(taskClass: RouteTaskClass, role: EvolutionRole, route: ModelRoute): string {
  return `${taskClass}\0${role}\0${routeKey(route)}`
}

/**
 * Merge one role's route rows with their evidence into per-route summaries
 * pooled over every task class the role measured: run counts, passes, pass rate,
 * mean tokens, mean wall time, and the newest evidence instant. Routes with no
 * recorded run carry zeroes and a null last instant.
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
  const runsByKey = new Map<string, { runs: number; passes: number; tokens: number; wallTimeMs: number; lastAt: string | null }>()
  for (const row of evidence) {
    if (row.role !== role) continue
    const key = routeKey(row)
    const current = runsByKey.get(key) ?? { runs: 0, passes: 0, tokens: 0, wallTimeMs: 0, lastAt: null }
    current.runs += 1
    if (row.pass) current.passes += 1
    current.tokens += row.tokens
    current.wallTimeMs += row.wallTimeMs
    if (current.lastAt === null || row.at > current.lastAt) current.lastAt = row.at
    runsByKey.set(key, current)
  }
  const summaries: RouteSummary[] = []
  for (const row of rows) {
    if (row.role !== role) continue
    const measured = runsByKey.get(routeKey(row))
    summaries.push(measured === undefined
      ? { role, provider: row.provider, model: row.model, origin: row.origin, runs: 0, passes: 0, passRate: 0, meanTokens: 0, meanWallTimeMs: 0, lastAt: null }
      : {
        role,
        provider: row.provider,
        model: row.model,
        origin: row.origin,
        runs: measured.runs,
        passes: measured.passes,
        passRate: measured.passes / measured.runs,
        meanTokens: measured.tokens / measured.runs,
        meanWallTimeMs: measured.wallTimeMs / measured.runs,
        lastAt: measured.lastAt,
      })
  }
  summaries.sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
  return summaries
}

/**
 * Advance one route's effectiveness with one measured outcome, keeping running
 * means of tokens and wall time.
 * @param current - the effectiveness to advance, or undefined for the first outcome.
 * @param outcome - the measured outcome to fold in.
 * @param taskClass - the task class the outcome was measured on.
 * @param origin - how the route entered the assignment set.
 * @returns the advanced effectiveness.
 */
export function updatedEffectiveness(
  current: RouteEffectiveness | undefined,
  outcome: RouteEvidence,
  taskClass: RouteTaskClass,
  origin: RouteOrigin,
): RouteEffectiveness {
  const runs = (current?.runs ?? 0) + 1
  const passes = (current?.passes ?? 0) + (outcome.pass ? 1 : 0)
  const meanTokens = current === undefined
    ? outcome.tokens
    : current.meanTokens + (outcome.tokens - current.meanTokens) / runs
  const meanWallTimeMs = current === undefined
    ? outcome.wallTimeMs
    : current.meanWallTimeMs + (outcome.wallTimeMs - current.meanWallTimeMs) / runs
  return {
    taskClass,
    role: outcome.role,
    provider: outcome.provider,
    model: outcome.model,
    origin,
    runs,
    passes,
    passRate: passes / runs,
    meanTokens,
    meanWallTimeMs,
    lastAt: outcome.at,
  }
}

/**
 * Derive every route's per-task-class effectiveness from the recorded
 * outcomes, in task-class then role-topology then provider/model order.
 * Outcomes recorded without a task class measured the role as a whole, so they
 * feed the per-role summary and no per-class row.
 * @param evidence - every recorded evidence row.
 * @param rows - every route assignment, read for each route's origin.
 * @param filters - the optional task-class and role filters.
 * @returns the effectiveness rows.
 */
export function effectivenessRows(
  evidence: readonly RouteEvidence[],
  rows: readonly RouteRow[],
  filters: { taskClass?: RouteTaskClass | undefined; role?: EvolutionRole | undefined },
): RouteEffectiveness[] {
  const origins = new Map(rows.map(row => [`${row.role}\0${routeKey(row)}`, row.origin]))
  const grouped = new Map<string, RouteEffectiveness>()
  for (const evidenceRow of evidence) {
    if (evidenceRow.taskClass === undefined) continue
    if (filters.taskClass !== undefined && evidenceRow.taskClass !== filters.taskClass) continue
    if (filters.role !== undefined && evidenceRow.role !== filters.role) continue
    const { taskClass } = evidenceRow
    const key = effectivenessKey(taskClass, evidenceRow.role, evidenceRow)
    const origin = origins.get(assignmentKey(evidenceRow.role, evidenceRow)) ?? 'observed'
    grouped.set(key, updatedEffectiveness(grouped.get(key), evidenceRow, taskClass, origin))
  }
  const derived = [...grouped.values()]
  derived.sort((left, right) =>
    left.taskClass.localeCompare(right.taskClass)
    || EVOLUTION_ROLES.indexOf(left.role) - EVOLUTION_ROLES.indexOf(right.role)
    || left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model))
  return derived
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
 * The sample-confidence-adjusted score of one route's pass rate: a beta-prior
 * smoothed pass rate scaled by how close the run count is to the minimum, so a
 * route with few runs cannot outrank a well-measured one.
 * @param passes - runs that passed.
 * @param runs - runs measured.
 * @param minimumRuns - run count at which confidence is full.
 * @returns the score.
 */
export function scoreOf(passes: number, runs: number, minimumRuns: number): number {
  const smoothed = (passes + 1) / (runs + 2)
  const confidence = Math.min(1, runs / minimumRuns)
  return smoothed * confidence
}

/**
 * Rank routes by the sample-confidence-adjusted score, score descending with
 * provider/model ascending tie-break. Both a per-role summary and a per-task-
 * class effectiveness row rank here, so a role-wide recommendation and a
 * class-scoped one compare on the same rule.
 * @param rows - the measured routes to rank.
 * @param minimumRuns - run count at which confidence is full.
 * @returns the ranked routes, best first.
 */
export function rankRoutes(rows: readonly RouteMeasurement[], minimumRuns: number): RouteRankingEntry[] {
  return rows
    .map((row) => {
      const score = scoreOf(row.passes, row.runs, minimumRuns)
      return {
        provider: row.provider,
        model: row.model,
        origin: row.origin,
        runs: row.runs,
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
 * Render why one route ranks as it does, naming the numbers.
 * @param row - the measurement to describe.
 * @param score - the score the route received.
 * @returns the reason sentence.
 */
function describeRanking(row: RouteMeasurement, score: number): string {
  const measured = `${row.passes}/${row.runs} passed (${row.passRate.toFixed(2)}), ${row.meanTokens.toFixed(0)} mean tokens, ${row.meanWallTimeMs.toFixed(0)} mean ms, score ${score.toFixed(3)}`
  return row.origin === 'pinned' ? `${measured}, pinned by an operator` : measured
}
