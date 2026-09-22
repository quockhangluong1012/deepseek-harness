/**
 * Nudge section registrations for evolution memory, plus the cadence ceiling
 * they share. A section carries the lines of the recorded conditions that
 * fired (`conditions.ts`), never fixed advice: with no condition holding, the
 * section renders nothing. `memoryNudgeInterval` and `skillNudgeInterval` are
 * ceilings, not triggers — a condition that fired stays quiet for that many
 * further turns, which is what bounds a standing condition's token cost. As
 * before, a condition line carries counts and store identities rather than
 * memory text, so the tier stays small and predictable.
 * @module @deepseek-ai/dsh-evolution-memory-context/sections
 */

/** Tool whose visibility gates the skill-condition nudge. */
export const SKILL_MANAGE_TOOL = 'skill_manage'

/** Registration for the memory-condition nudge. */
export const MEMORY_SCOPE_SECTION = {
  name: 'evolution-memory-scope',
  order: 10051,
} as const

/** Registration for the skill-condition nudge. */
export const LESSONS_SKILLS_SECTION = {
  name: 'evolution-lessons-skills',
  order: 10050,
} as const

/** Nudge registration for the session-search hint, which is a standing hint rather than a condition. */
export const SESSION_SEARCH_SECTION = {
  name: 'evolution-session-search',
  order: 10052,
  text: 'To recall earlier work in this scope, search past sessions before asking the user to repeat context.',
} as const

/**
 * Decide whether a condition may fire on the turn now being assembled. A
 * condition that has never fired is due; one that fired stays quiet until
 * `interval` further turns have been observed, so the configured interval is
 * the ceiling on how often a standing condition can be repeated. Assemblies
 * within the turn a condition fired on all see it, so one turn's prompt never
 * depends on how often it was assembled.
 * @param lastFiredTurn - observed turn the condition last fired on, or undefined when it never has.
 * @param turn - observed `turn/start` count for the session; 0 before the first.
 * @param interval - turns a condition stays quiet after firing, from the validated config (at least 1).
 * @returns true when the condition may fire on this turn.
 */
export function nudgeDue(lastFiredTurn: number | undefined, turn: number, interval: number): boolean {
  return lastFiredTurn === undefined || turn === lastFiredTurn || turn - lastFiredTurn >= interval
}
