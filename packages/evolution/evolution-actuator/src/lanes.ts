/**
 * The pure lane rotation behind the scheduled island migration: which lane a
 * due island hands its candidate to. No I/O.
 * @module @deepseek-ai/dsh-evolution-actuator/src/lanes
 */

import { ISLAND_OBJECTIVES } from '@deepseek-ai/dsh-evolution-islands'
import type { Island } from '@deepseek-ai/dsh-evolution-islands'

/**
 * The lane a due island's candidate migrates to: the skill's next lane in §7's
 * objective order, wrapping to the first. Lanes are ordered by objective and
 * then by identity, so the rotation is stable across passes and independent of
 * registration order; a skill with one lane has nowhere to migrate, and an
 * island that is not among `lanes` has no place in the rotation.
 * @param dueIslandId - the island whose scheduled migration is due.
 * @param lanes - every island of that skill.
 * @returns the target island, or undefined without a second lane.
 */
export function migrationTarget(dueIslandId: string, lanes: readonly Island[]): Island | undefined {
  if (lanes.length < 2) return undefined
  const ordered = [...lanes].sort((left, right) =>
    ISLAND_OBJECTIVES.indexOf(left.objective) - ISLAND_OBJECTIVES.indexOf(right.objective)
    || left.islandId.localeCompare(right.islandId))
  const index = ordered.findIndex(lane => lane.islandId === dueIslandId)
  if (index === -1) return undefined
  return ordered[(index + 1) % ordered.length]
}
