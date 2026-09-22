/**
 * Pure helpers for the novelty-search archive: Jaccard similarity between
 * descriptors, the archive-novelty measure a descriptor records, and archive
 * statistics. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-novelty-search/src/novelty
 */

import type { NoveltyArchiveEntry } from './types.ts'

/**
 * Jaccard similarity between two feature sets, in 0..1. Two empty sets share
 * nothing to compare, so they report zero rather than a vacuous one.
 * @param left - first feature set.
 * @param right - second feature set.
 * @returns the Jaccard similarity, in 0..1.
 */
export function similarity(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 && b.size === 0) return 0
  let common = 0
  for (const feature of a) {
    if (b.has(feature)) common += 1
  }
  return common / (a.size + b.size - common)
}

/**
 * Novelty of one descriptor against an archive: one minus its maximum
 * similarity to any entry, in 0..1. A descriptor with no features reports
 * zero — it states nothing to be novel about — and an empty archive reports
 * one, the seed entry of a skill's frontier.
 * @param features - the descriptor to measure.
 * @param entries - the skill's recorded archive.
 * @returns the archive novelty, in 0..1.
 */
export function archiveNovelty(
  features: readonly string[],
  entries: readonly NoveltyArchiveEntry[],
): number {
  if (features.length === 0) return 0
  if (entries.length === 0) return 1
  let best = 0
  for (const entry of entries) {
    best = Math.max(best, similarity(features, entry.features))
  }
  return 1 - best
}

/**
 * Mean novelty of the recorded entries, in 0..1, or zero for an empty
 * archive. A falling mean is the frontier-stagnation signal §31 calls out:
 * recent candidates share more and more of what the skill has already seen.
 * @param entries - the recorded archive entries.
 * @returns the mean recorded novelty, in 0..1.
 */
export function noveltyMean(entries: readonly NoveltyArchiveEntry[]): number {
  if (entries.length === 0) return 0
  let total = 0
  for (const entry of entries) {
    total += entry.novelty
  }
  return total / entries.length
}
