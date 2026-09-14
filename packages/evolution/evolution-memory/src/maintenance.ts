/**
 * Artifact maintenance: the pure decay predicate a per-scope sweep applies,
 * and the shape of what one sweep changed.
 *
 * A sweep only drops whole artifacts; it never adds or edits one, so the
 * identity invariants the write path maintains — pairwise-distinct ids, each
 * id equal to `artifactKey(statement)` — hold across it. Refinement of the
 * coarse artifact `wrapLegacyLessons` admits from a legacy lessons document
 * belongs to Phase 2: the sweep does not call an extractor, and the coarse
 * artifact is a correct permanent fallback until that phase lands.
 * @module @deepseek-ai/dsh-evolution-memory/maintenance
 */

import type { LessonArtifact } from './lesson-artifact.ts'

/** What one sweep changed for one scope. */
export interface SweepResult {
  /** Artifacts dropped by decay. */
  pruned: number
  /** Coarse migrated artifacts replaced by refined ones; always 0 in Phase 1. */
  refined: number
}

/**
 * Whether decay should drop one artifact: condemned by refutations, or past
 * its ttl measured from the last validation, refutation, or edit. An artifact
 * with no ttl never expires by age, so only the refutation floor can drop it.
 * @param artifact - the artifact to judge.
 * @param now - epoch milliseconds to judge at.
 * @param refutationFloor - refutations at or above which age is irrelevant.
 * @returns true when the artifact is stale by ttl or condemned by refutations.
 */
export function prunable(artifact: LessonArtifact, now: number, refutationFloor: number): boolean {
  if (artifact.refutationCount >= refutationFloor) return true
  if (artifact.ttlDays === undefined) return false
  return now - Date.parse(artifact.updatedAt) > artifact.ttlDays * 86_400_000
}
