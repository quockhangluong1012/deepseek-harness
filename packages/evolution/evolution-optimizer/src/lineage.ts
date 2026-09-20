/**
 * Changed components of one promotion: how many lines the winning body added
 * and removed relative to the body the run started from. Order-sensitive —
 * a pure reorder counts as change — unlike novelty, which asks what is new
 * material rather than what moved. Bodies themselves stay out of the ledger;
 * these counts say how big the edit was, the digests say which texts.
 * @module @deepseek-ai/dsh-evolution-optimizer/lineage
 */

/** Line counts one promotion changed, both zero when nothing was promoted. */
export interface LineChangeCounts {
  /** Lines the winning body carries past their longest common subsequence. */
  addedLines: number
  /** Lines the starting body carries past their longest common subsequence. */
  removedLines: number
}

/**
 * Count the lines one promotion added and removed: both bodies minus their
 * longest common subsequence, so unchanged lines in place cost nothing and
 * every other line counts once on its own side. Memoized recursion keeps it
 * quadratic in the body sizes, which is fine for SKILL.md bodies of hundreds
 * of lines.
 * @param before - body the run started from.
 * @param after - winning body, or the starting body when nothing was promoted.
 * @returns added and removed line counts.
 */
export function diffLineCounts(before: string, after: string): LineChangeCounts {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  const memo = new Map<string, number>()
  const shared = (i: number, j: number): number => {
    if (i >= oldLines.length || j >= newLines.length) return 0
    const key = `${i},${j}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    const value = oldLines[i] === newLines[j]
      ? shared(i + 1, j + 1) + 1
      : Math.max(shared(i + 1, j), shared(i, j + 1))
    memo.set(key, value)
    return value
  }
  const common = shared(0, 0)
  return { addedLines: newLines.length - common, removedLines: oldLines.length - common }
}
