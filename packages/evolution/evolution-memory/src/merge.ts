/**
 * Merge decision for a candidate that matched an existing lesson artifact:
 * which artifact the candidate belongs to, and what that artifact becomes.
 * Both functions are pure and take the similarity the caller measured, so the
 * decision is testable without an embeddings service.
 * @module @deepseek-ai/dsh-evolution-memory/merge
 */

import { artifactKey, lessonArtifact } from './lesson-artifact.ts'
import type { LessonArtifact, LessonArtifactInput, LessonMergeStrategy } from './lesson-artifact.ts'

/**
 * Cosine similarity between two vectors from one embedding batch.
 * @param left - one vector.
 * @param right - the other vector; positions it does not have count as zero,
 * so a truncated vector scores over the span it covers instead of returning
 * `NaN`.
 * @returns similarity in `[-1, 1]`, or 0 when either vector has no magnitude.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
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
 * instant this stamps, on `updatedAt`. `merge` unions the conditions and keeps
 * the higher confidence while the artifact keeps the remaining content it
 * already had; `overwrite` replaces the artifact's content with the
 * candidate's (source, conditions, evidence, confidence, scope, and ttl days).
 * `keep_both` never reaches here: the caller stores the candidate beside the
 * match instead of folding it in.
 * @param existing - the artifact the candidate matched.
 * @param candidate - validated caller-supplied artifact fields.
 * @param strategy - the merge policy to apply.
 * @param now - ISO-8601 instant to stamp on `updatedAt`.
 * @returns the merged artifact.
 */
export function mergeArtifact(
  existing: LessonArtifact,
  candidate: LessonArtifactInput,
  strategy: LessonMergeStrategy,
  now: string,
): LessonArtifact {
  const combined = strategy === 'merge'
    ? {
      ...existing,
      conditions: [existing.conditions, candidate.conditions].filter(part => part.length > 0).join('; '),
      confidence: Math.max(existing.confidence, candidate.confidence),
    }
    : { ...existing, ...candidate }
  return lessonArtifact.parse({
    ...combined,
    id: existing.id,
    statement: existing.statement,
    validationCount: existing.validationCount,
    refutationCount: existing.refutationCount,
    createdAt: existing.createdAt,
    updatedAt: now,
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
