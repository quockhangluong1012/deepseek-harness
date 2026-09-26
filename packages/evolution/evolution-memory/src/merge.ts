/**
 * Merge decision for a candidate that matched an existing lesson artifact:
 * which artifact the candidate belongs to, and what that artifact becomes.
 * Both functions are pure and take the similarity the caller measured, so the
 * decision is testable without an embeddings service.
 * @module @deepseek-ai/dsh-evolution-memory/merge
 */

import { resolveConflict } from './conflict.ts'
import { artifactKey, lessonArtifact } from './lesson-artifact.ts'
import type { LessonArtifact, LessonArtifactInput, LessonMergeStrategy } from './lesson-artifact.ts'

/**
 * Cosine similarity between two vectors from one embedding batch. Every vector
 * of a batch comes from one model, so the two are the same width; a mismatch
 * means vectors from two models reached one comparison, which is refused rather
 * than scored over the positions they happen to share.
 * @param left - one vector.
 * @param right - the other vector, from the same batch.
 * @returns similarity in `[-1, 1]`, or 0 when either vector has no magnitude.
 * @throws when the two vectors have different lengths, naming both widths.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error(
      `evolution-memory: cannot compare a ${left.length}-dimension vector with a ${right.length}-dimension vector`,
    )
  }
  let dot = 0
  let leftSquared = 0
  let rightSquared = 0
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0
    dot += value * other
    leftSquared += value * value
    rightSquared += other * other
  }
  const magnitude = Math.sqrt(leftSquared) * Math.sqrt(rightSquared)
  return magnitude === 0 ? 0 : dot / magnitude
}

/**
 * Apply a merge strategy to the artifact a candidate matched. The artifact's
 * identity is fixed by its statement, so the stored statement, its derived id,
 * the counters, and the creation instant never change here; `now` is the only
 * instant this stamps, apart from the conflict it records.
 *
 * Which side's content stands is decided by {@link resolveConflict}, never by
 * confidence alone, and the resolution is stored on the artifact. `overwrite`
 * is the caller naming the winner, so the candidate's content stands. `merge`
 * folds two wordings of one fact together: the conditions union, because both
 * wordings describe when the fact applies, and the rule's winner supplies the
 * evidence, scope, source, confidence, and ttl. `keep_both` never reaches here:
 * the caller counts the candidate as a validation of the artifact the
 * similarity lookup matched, and stores it as an artifact of its own when
 * nothing matched.
 * @param existing - the artifact the candidate matched.
 * @param candidate - validated caller-supplied artifact fields.
 * @param strategy - the merge policy to apply.
 * @param now - ISO-8601 instant to stamp on `updatedAt` and the resolution.
 * @returns the merged artifact.
 */
export function mergeArtifact(
  existing: LessonArtifact,
  candidate: LessonArtifactInput,
  strategy: LessonMergeStrategy,
  now: string,
): LessonArtifact {
  const conflict = resolveConflict(existing, candidate, strategy, now)
  const conditions = strategy === 'merge'
    ? [existing.conditions, candidate.conditions].filter(part => part.length > 0).join('; ')
    : candidate.conditions
  const content = conflict.winner === 'candidate' ? { ...existing, ...candidate } : existing
  return lessonArtifact.parse({
    ...content,
    conditions,
    id: existing.id,
    statement: existing.statement,
    validationCount: existing.validationCount,
    refutationCount: existing.refutationCount,
    createdAt: existing.createdAt,
    updatedAt: now,
    conflict,
  })
}

/**
 * Select the artifact a candidate belongs to: the one whose id its statement
 * already keys, otherwise the most similar artifact whose score clears the
 * floor.
 * @param candidate - validated caller-supplied artifact fields.
 * @param artifacts - the scope's existing artifacts.
 * @param similarity - similarity per artifact id, as the caller measured it.
 * @param floor - minimum similarity that justifies merging.
 * @returns the matched artifact, or undefined when nothing is close enough.
 */
export function pickMergeTarget(
  candidate: LessonArtifactInput,
  artifacts: readonly LessonArtifact[],
  similarity: ReadonlyMap<string, number>,
  floor: number,
): LessonArtifact | undefined {
  const key = artifactKey(candidate.statement)
  let best: LessonArtifact | undefined
  let bestScore = floor
  for (const artifact of artifacts) {
    if (artifact.id === key) return artifact
    const score = similarity.get(artifact.id)
    if (score === undefined || score < bestScore) continue
    best = artifact
    bestScore = score
  }
  return best
}
