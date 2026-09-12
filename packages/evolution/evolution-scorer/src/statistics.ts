/**
 * Wall-clock reduction for scored runs: the median of the per-attempt samples,
 * so one slow cold start cannot move the reported number.
 * @module @deepseek-ai/dsh-evolution-scorer/statistics
 */

/**
 * Take the median of a non-empty sample list.
 * @param values - samples in observation order; one sample per fresh-process attempt.
 * @returns the middle sample for an odd count, otherwise the mean of the two middle samples.
 */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) throw new Error('evolution-scorer: a median needs at least one sample')
  const ordered = [...values].sort((left, right) => left - right)
  const upper = Math.floor(ordered.length / 2)
  // Both indexes are in range: the guard above rejects an empty list, and
  // `lower` is `upper` for an odd count.
  return ((ordered[ordered.length - 1 - upper] as number) + (ordered[upper] as number)) / 2
}
