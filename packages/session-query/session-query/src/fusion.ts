/**
 * Reciprocal-rank fusion of two session rankings over the same corpus.
 * @module @deepseek-ai/dsh-session-query/fusion
 */

import type { SessionSearchHit } from './types.ts'

/**
 * Rank constant of the reciprocal-rank sum. The standard 60 keeps the first
 * handful of positions worth roughly the same, so a session both channels
 * place highly outranks one either channel places first alone.
 */
export const RECIPROCAL_RANK_K = 60

/** Running sum for one session, with the first hit seen for it. */
interface FusedEntry {
  score: number
  hit: SessionSearchHit
}

/**
 * Fuse two rankings of the same corpus by reciprocal rank. A session in both
 * rankings sums both contributions, which is the whole point: agreement
 * between the channels outranks a strong showing in either alone. Ties break
 * by session id so the order is stable across calls.
 * @param rankings - one or more rankings, most significant first.
 * @returns every session any ranking returned, best fused rank first.
 */
export function fuseSessionRankings(...rankings: readonly (readonly SessionSearchHit[])[]): SessionSearchHit[] {
  const fused = new Map<string, FusedEntry>()
  for (const ranking of rankings) {
    ranking.forEach((hit, index) => {
      const entry = fused.get(hit.header.id) ?? { score: 0, hit }
      entry.score += 1 / (RECIPROCAL_RANK_K + index + 1)
      fused.set(hit.header.id, entry)
    })
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || (left.hit.header.id < right.hit.header.id ? -1 : 1))
    .map(entry => entry.hit)
}
