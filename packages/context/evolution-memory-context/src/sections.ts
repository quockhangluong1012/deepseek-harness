/**
 * System-prompt nudges for evolution memory: skill-routing guidance shown
 * only beside the skill tool, and scope-narrowing guidance. Pure text and
 * visibility helpers; the plugin wires them. Static text only — no
 * per-scope value is interpolated here, because a value that varies with
 * memory content would break prefix reuse for every request sharing this
 * section (the brief, not the system prompt, is where varying content
 * belongs; see `render.ts`'s `Memory usage` header).
 * @module @deepseek-ai/dsh-evolution-memory-context/sections
 */

/** Tool whose visibility gates the lessons-to-skills nudge. */
export const SKILL_MANAGE_TOOL = 'skill_manage'

/** Nudge registration for the lessons-to-skills guidance. */
export const LESSONS_SKILLS_SECTION = {
  name: 'evolution-lessons-skills',
  order: 10050,
  text: 'When this turn produces durable lessons for future turns, record them with the skill_manage tool so they persist beyond this session.',
} as const

/** Nudge registration for the scope-narrowing guidance. */
export const MEMORY_SCOPE_SECTION = {
  name: 'evolution-memory-scope',
  order: 10051,
  text: 'Evolution memory in this conversation covers one directory scope. Ignore it for work outside its directory; inside it, prefer its instructions over general knowledge.',
} as const

/** Nudge registration for the session-search hint. */
export const SESSION_SEARCH_SECTION = {
  name: 'evolution-session-search',
  order: 10052,
  text: 'To recall earlier work in this scope, search past sessions before asking the user to repeat context.',
} as const

/**
 * Resolve the lessons-to-skills nudge for one assembly.
 * @param tool - the looked-up skill tool, or undefined when invisible.
 * @returns the nudge text, or empty string when the tool is hidden.
 */
export function lessonsSkillsText(tool: unknown): string {
  return tool === undefined ? '' : LESSONS_SKILLS_SECTION.text
}

/**
 * Decide whether a nudge repeated every `interval` turns is due on `turn`.
 * A session with no observed `turn/start` yet counts as turn 0 and reads as
 * its first turn, so interval-1 nudges render before the first turn while
 * wider intervals wait for their multiple.
 * @param turn - observed `turn/start` count for the session; 0 before the first.
 * @param interval - turns between repeats, from the validated config (at least 1).
 * @returns true when this turn falls on the interval.
 */
export function isNudgeTurn(turn: number, interval: number): boolean {
  return Math.max(turn, 1) % interval === 0
}
