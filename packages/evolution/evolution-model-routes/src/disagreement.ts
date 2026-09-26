/**
 * Route disagreement (§44): two routes measured on the same task class and role
 * whose recorded pass rates diverge by more than a threshold. Disagreement
 * between independent reasoning paths is a search signal — it says the
 * evaluation, not the candidate, is what needs another look — so a strong gap
 * becomes an uncertainty signal through the existing seam. No I/O, no domain:
 * the caller supplies the recorded effectiveness rows.
 * @module @deepseek-ai/dsh-evolution-model-routes/src/disagreement
 */

import type { EvolutionRole, RouteDisagreement, RouteEffectiveness, RouteTaskClass } from './types.ts'

/**
 * The two most divergent routes for one task class and role: the highest and
 * lowest pass rates among the routes with at least `minimumRuns` recorded runs.
 * Yields undefined — no disagreement — while fewer than two routes are
 * measured that well, or while the extreme pass rates sit within `threshold`
 * of each other.
 * @param rows - the recorded effectiveness rows.
 * @param taskClass - the task class to compare routes on.
 * @param role - the role to compare routes on.
 * @param minimumRuns - runs a route needs before it is compared.
 * @param threshold - pass-rate gap at which two routes count as disagreeing.
 * @returns the disagreement, or undefined when the routes agree.
 */
export function routeDisagreement(
  rows: readonly RouteEffectiveness[],
  taskClass: RouteTaskClass,
  role: EvolutionRole,
  minimumRuns: number,
  threshold: number,
): RouteDisagreement | undefined {
  const measured = rows
    .filter(row => row.taskClass === taskClass && row.role === role && row.runs >= minimumRuns)
    .sort((left, right) =>
      right.passRate - left.passRate
      || right.runs - left.runs
      || left.provider.localeCompare(right.provider)
      || left.model.localeCompare(right.model))
  const leader = measured[0]
  const trailer = measured[measured.length - 1]
  if (leader === undefined || trailer === undefined || leader === trailer) return undefined
  const gap = leader.passRate - trailer.passRate
  if (gap < threshold) return undefined
  return {
    taskClass,
    role,
    leader: { provider: leader.provider, model: leader.model },
    trailer: { provider: trailer.provider, model: trailer.model },
    leaderPassRate: leader.passRate,
    trailerPassRate: trailer.passRate,
    gap,
    runs: [leader.runs, trailer.runs],
    detail: `routes '${leader.provider}/${leader.model}' (${leader.passRate.toFixed(2)} over ${leader.runs} runs) and `
      + `'${trailer.provider}/${trailer.model}' (${trailer.passRate.toFixed(2)} over ${trailer.runs} runs) disagree `
      + `by ${gap.toFixed(2)} on '${taskClass}' in role ${role}`,
  }
}

/**
 * Every task class and role whose two best-measured routes disagree, strongest
 * gap first.
 * @param rows - the recorded effectiveness rows.
 * @param minimumRuns - runs a route needs before it is compared.
 * @param threshold - pass-rate gap at which two routes count as disagreeing.
 * @returns the disagreements, strongest first.
 */
export function routeDisagreements(
  rows: readonly RouteEffectiveness[],
  minimumRuns: number,
  threshold: number,
): RouteDisagreement[] {
  const groups = new Map<string, { taskClass: RouteTaskClass; role: EvolutionRole }>()
  for (const row of rows) {
    if (row.runs < minimumRuns) continue
    groups.set(`${row.taskClass}\0${row.role}`, { taskClass: row.taskClass, role: row.role })
  }
  return [...groups.values()]
    .flatMap((group) => {
      const found = routeDisagreement(rows, group.taskClass, group.role, minimumRuns, threshold)
      return found === undefined ? [] : [found]
    })
    // One group per task class and role, so the gap and the task class decide
    // every comparison.
    .sort((left, right) =>
      right.gap - left.gap
      || left.taskClass.localeCompare(right.taskClass))
}
