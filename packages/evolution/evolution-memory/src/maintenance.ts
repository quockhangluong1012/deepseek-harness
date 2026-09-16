/**
 * Artifact maintenance: the pure decay predicate a per-scope sweep applies,
 * and the shape of what one sweep changed.
 *
 * A sweep only drops whole artifacts; it never adds or edits one, so the
 * identity invariants the write path maintains — pairwise-distinct ids, each
 * id equal to `artifactKey(statement)` — hold across it. Refinement of the
 * coarse artifact `wrapLegacyLessons` admits from a legacy lessons document
 * is not implemented: the extraction protocol folds decisions into the
 * artifacts it reads rather than refining them, so the sweep does not call
 * an extractor and the coarse artifact is a correct permanent fallback.
 * @module @deepseek-ai/dsh-evolution-memory/maintenance
 */

import type { LessonArtifact } from './lesson-artifact.ts'
import type { EpisodicEntry } from './types.ts'

/**
 * Drop the episodic notes a retention window has outlived, then the oldest
 * notes past the count cap. Entries arrive in append order and stay in it,
 * so the cap keeps the newest slice.
 * @param entries - the scope's episodic notes, oldest first.
 * @param now - epoch milliseconds to judge at.
 * @param retentionDays - days a note stays readable after it landed.
 * @param maxEntries - notes retained past the age cut, newest kept.
 * @returns the surviving notes, oldest first.
 */
export function pruneEpisodic(
  entries: readonly EpisodicEntry[],
  now: number,
  retentionDays: number,
  maxEntries: number,
): EpisodicEntry[] {
  const cutoff = now - retentionDays * 86_400_000
  const fresh = entries.filter(entry => Date.parse(entry.addedAt) >= cutoff)
  return fresh.slice(Math.max(0, fresh.length - maxEntries))
}

/** What one sweep changed for one scope. */
export interface SweepResult {
  /** Artifacts dropped by decay. */
  pruned: number
  /** Coarse migrated artifacts replaced by refined ones; always 0 (no refinement pass exists yet). */
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
