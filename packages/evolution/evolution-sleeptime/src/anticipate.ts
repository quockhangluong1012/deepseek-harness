/**
 * Pure helpers for evidence-driven idle anticipation (§25): which task classes
 * recurred inside a window, what anticipation each recurrence justifies, the
 * digest a precompute caches for one, and which later recorded occurrences
 * consumed an artifact already cached. No I/O, no domain — fully
 * unit-testable.
 * @module @deepseek-ai/dsh-evolution-sleeptime/src/anticipate
 */

import type {
  AnticipationInput,
  PrecomputeArtifact,
  RecurrenceEvidence,
  RecurrenceSource,
  TaskOccurrence,
} from './types.ts'

/** Milliseconds in one hour, the unit of the recurrence window. */
const HOUR_MS = 3_600_000

/** Occurrence counts accumulating while one class's window is summarized. */
interface Accumulated {
  /** The store the occurrences came from. */
  source: RecurrenceSource
  /** The class the occurrences belong to. */
  taskClass: string
  /** Occurrences seen so far. */
  occurrences: number
  /** Summed tokens of those occurrences. */
  tokens: number
  /** Oldest instant seen so far. */
  firstAt: string
  /** Newest instant seen so far. */
  lastAt: string
}

/**
 * The identity of one recurring task class, namespaced by its source so a
 * skill that reads like a route's task class stays a different class.
 * @param source - the store the class recurred in.
 * @param taskClass - the class itself.
 * @returns the identity, e.g. `skill:pdf-extract`.
 */
export function classKeyOf(source: RecurrenceSource, taskClass: string): string {
  return `${source}:${taskClass}`
}

/**
 * The instant before which a recorded occurrence no longer counts as
 * recurrence: the pass instant minus the window.
 * @param nowIso - ISO-8601 instant the pass runs at.
 * @param windowHours - hours back recurrence counts.
 * @returns the ISO-8601 window start.
 */
export function windowStartOf(nowIso: string, windowHours: number): string {
  return new Date(Date.parse(nowIso) - windowHours * HOUR_MS).toISOString()
}

/**
 * Summarize the recorded occurrences of every task class, counting only those
 * inside the window, with each class's mean tokens and its first and last
 * instant. Classes are keyed by source and name and returned in key order, so
 * one pass over one body of evidence always derives the same rows.
 * @param occurrences - every occurrence the source stores recorded.
 * @param windowStart - ISO-8601 instant before which an occurrence is ignored.
 * @returns one row per class that occurred inside the window, key order.
 */
export function recurrenceOf(occurrences: readonly TaskOccurrence[], windowStart: string): RecurrenceEvidence[] {
  const grouped = new Map<string, Accumulated>()
  for (const occurrence of occurrences) {
    if (occurrence.at < windowStart) continue
    const key = classKeyOf(occurrence.source, occurrence.taskClass)
    const held = grouped.get(key)
    if (held === undefined) {
      grouped.set(key, {
        source: occurrence.source,
        taskClass: occurrence.taskClass,
        occurrences: 1,
        tokens: occurrence.tokens,
        firstAt: occurrence.at,
        lastAt: occurrence.at,
      })
      continue
    }
    held.occurrences += 1
    held.tokens += occurrence.tokens
    if (occurrence.at < held.firstAt) held.firstAt = occurrence.at
    if (occurrence.at > held.lastAt) held.lastAt = occurrence.at
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, held]) => ({
      source: held.source,
      taskClass: held.taskClass,
      occurrences: held.occurrences,
      meanTokens: held.tokens / held.occurrences,
      firstAt: held.firstAt,
      lastAt: held.lastAt,
    }))
}

/**
 * The anticipation each recurring class justifies. A class needs at least
 * `minRecurrences` recorded occurrences to count as recurring — one sighting
 * is not a pattern; its likelihood is its share of the recurring occurrences,
 * its expected queries are its own recurrence, and a precompute is credited
 * with the tokens one recorded occurrence spent. Sorted by likelihood
 * descending with identity ascending tie-break.
 * @param recurrence - the summarized recurrence of every class.
 * @param minRecurrences - occurrences a class needs to count as recurring.
 * @returns one anticipation input per recurring class, likeliest first.
 */
export function anticipationOf(
  recurrence: readonly RecurrenceEvidence[],
  minRecurrences: number,
): AnticipationInput[] {
  const recurring = recurrence.filter(row => row.occurrences >= minRecurrences)
  const total = recurring.reduce((sum, row) => sum + row.occurrences, 0)
  return recurring
    .map((row): AnticipationInput => ({
      taskId: classKeyOf(row.source, row.taskClass),
      domain: row.source,
      scope: row.taskClass,
      likelihood: row.occurrences / total,
      expectedQueries: row.occurrences,
      expectedSavingTokens: row.meanTokens,
    }))
    .sort((left, right) => right.likelihood - left.likelihood || left.taskId.localeCompare(right.taskId))
}

/**
 * The digest one precompute caches for a recurring class: what the source
 * stores recorded of it, so an artifact always names the evidence it was
 * built from rather than anything a model composed.
 * @param row - the class's summarized recurrence.
 * @returns the digest text.
 */
export function artifactSummaryOf(row: RecurrenceEvidence): string {
  return `${classKeyOf(row.source, row.taskClass)} recurred ${row.occurrences} times between `
    + `${row.firstAt} and ${row.lastAt}, ${row.meanTokens.toFixed(0)} mean tokens per occurrence`
}

/**
 * The recorded occurrences that consumed one cached artifact: the artifact's
 * own class only, strictly newer than the instant its hits are accounted
 * through, oldest first. An artifact written before that instant was recorded
 * is accounted from its own precompute instant, so it is never credited with
 * turns that ran before it existed.
 * @param artifact - the artifact the occurrences may have consumed.
 * @param occurrences - every occurrence the source stores recorded.
 * @returns the occurrences that consumed the artifact, oldest first.
 */
export function newlyConsumed(
  artifact: PrecomputeArtifact,
  occurrences: readonly TaskOccurrence[],
): TaskOccurrence[] {
  const cursor = artifact.servedThroughAt ?? artifact.at
  return occurrences
    .filter(occurrence =>
      occurrence.at > cursor
      && classKeyOf(occurrence.source, occurrence.taskClass) === artifact.taskId)
    .sort((left, right) => left.at.localeCompare(right.at))
}
