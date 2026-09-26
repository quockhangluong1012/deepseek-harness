/**
 * Lesson-artifact lifecycle: the status one durable fact moves through and the
 * edges that are legal between statuses. One table owns legality, so every
 * write path that moves a status consults the same rule and an illegal move is
 * refused loudly instead of landing as a status nothing can leave.
 *
 * A fact enters as a `candidate` — the status a record written before the
 * lifecycle existed reads as — or, when a migrated document admits it, as an
 * `observation`. Every extraction that confirms it climbs one rung
 * (`observation → candidate → validated → promoted → stable`), a stale fact
 * that is confirmed again climbs back onto the ladder, and the two exits
 * (`stale`, `invalidated`) are terminal for `invalidated`.
 * @module @deepseek-ai/dsh-evolution-memory/lifecycle
 */

import type { LessonArtifact } from './lesson-artifact.ts'

/** The statuses a durable fact moves through: the ladder, then the two exits. */
export const LIFECYCLE_STATES = [
  'observation',
  'candidate',
  'validated',
  'promoted',
  'stable',
  'stale',
  'invalidated',
] as const

/** One status in a fact's lifecycle. */
export type LessonLifecycle = (typeof LIFECYCLE_STATES)[number]

/**
 * The confirmation ladder: one rung per extraction that confirms the fact. A
 * stale fact that is confirmed again re-enters at `validated` — the wording
 * never stopped standing.
 */
const LADDER: Readonly<Record<LessonLifecycle, LessonLifecycle | undefined>> = {
  observation: 'candidate',
  candidate: 'validated',
  validated: 'promoted',
  promoted: 'stable',
  stable: undefined,
  stale: 'validated',
  invalidated: undefined,
}

/** Legal edges: the ladder's rungs plus ageing to `stale` and the terminal `invalidated`. */
const TRANSITIONS: Readonly<Record<LessonLifecycle, readonly LessonLifecycle[]>> = {
  observation: ['candidate', 'invalidated'],
  candidate: ['validated', 'invalidated'],
  validated: ['promoted', 'stale', 'invalidated'],
  promoted: ['stable', 'stale', 'invalidated'],
  stable: ['stale', 'invalidated'],
  stale: ['validated', 'invalidated'],
  invalidated: [],
}

/** Statuses a fact reaches only at or above the policy confidence floor. */
const CONFIDENT_STATES: readonly LessonLifecycle[] = ['promoted', 'stable']

/** Statuses a landed validation reaches; these stamp `lastValidatedAt`. */
const VALIDATED_STATES: readonly LessonLifecycle[] = ['validated', 'promoted', 'stable']

/**
 * The status one fact carries: its stored status, or `candidate` while it has
 * none. Records written before the lifecycle existed carry no status, and
 * treating such a fact as anything but a plain candidate would invent evidence.
 * @param artifact - the fact to read.
 * @returns the stored status, or `candidate`.
 */
export function lifecycleOf(artifact: Pick<LessonArtifact, 'lifecycle'>): LessonLifecycle {
  return artifact.lifecycle ?? 'candidate'
}

/**
 * Whether one status may move to another.
 * @param from - current status.
 * @param to - requested status.
 * @returns whether the transition is legal.
 */
export function transitionAllowed(from: LessonLifecycle, to: LessonLifecycle): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * The status a confirmation moves a fact to, or undefined when the ladder has
 * no further rung (a `stable` or `invalidated` fact).
 * @param state - current status.
 * @returns the next ladder status, or undefined.
 */
export function nextLadderState(state: LessonLifecycle): LessonLifecycle | undefined {
  return LADDER[state]
}

/**
 * Move one fact's status along a legal edge, or refuse loudly. A move into
 * `promoted` or `stable` also requires the policy confidence floor: a fact the
 * policy does not trust is never promoted, whatever a caller asks for.
 *
 * A move into `validated`, `promoted`, or `stable` stamps `lastValidatedAt`,
 * because reaching those statuses is what a landed validation means.
 * @param artifact - the fact to move.
 * @param to - requested status.
 * @param now - ISO-8601 instant of the move.
 * @param confidenceFloor - policy confidence floor for the confident statuses.
 * @returns the fact carrying its new status.
 * @throws When the edge is not legal, or the fact is below the floor a
 * `promoted` or `stable` status requires.
 */
export function transitionLifecycle(
  artifact: LessonArtifact,
  to: LessonLifecycle,
  now: string,
  confidenceFloor: number,
): LessonArtifact {
  const from = lifecycleOf(artifact)
  if (!transitionAllowed(from, to)) {
    throw new Error(
      `evolution-memory: artifact '${artifact.id}' cannot move from lifecycle '${from}' to '${to}'`,
    )
  }
  if (CONFIDENT_STATES.includes(to) && artifact.confidence < confidenceFloor) {
    throw new Error(
      `evolution-memory: artifact '${artifact.id}' carries confidence ${artifact.confidence} below the `
      + `${confidenceFloor} floor and cannot move from '${from}' to '${to}'`,
    )
  }
  return {
    ...artifact,
    lifecycle: to,
    ...VALIDATED_STATES.includes(to) ? { lastValidatedAt: now } : {},
    updatedAt: now,
  }
}

/**
 * The status a landed confirmation earns one fact: its next ladder rung, or
 * undefined when the fact is already at the top, is invalidated, or cannot yet
 * hold the confidence a promotion requires. An extraction that confirms a fact
 * the policy distrusts still counts as a validation; it just does not promote.
 * @param artifact - the fact the confirmation landed on.
 * @param confidenceFloor - policy confidence floor for the confident statuses.
 * @returns the status to store, or undefined to leave the current status.
 */
export function confirmedLifecycle(
  artifact: Pick<LessonArtifact, 'lifecycle' | 'confidence'>,
  confidenceFloor: number,
): LessonLifecycle | undefined {
  const target = nextLadderState(lifecycleOf(artifact))
  if (target === undefined) return undefined
  if (CONFIDENT_STATES.includes(target) && artifact.confidence < confidenceFloor) return undefined
  return target
}
