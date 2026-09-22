/**
 * Pure helpers for the population store: generation numbering, lineage
 * reconstruction, and elite ranking. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-population/src/population
 */

import type { PopulationCandidate } from './types.ts'

/**
 * The generation a new candidate of `skill` belongs to: one more than the
 * highest generation already present for that skill, or 1 when the skill has
 * no candidates yet. Complete rows only; incomplete rows are ignored so
 * partial writes never advance a skill's generation.
 */
export function nextGeneration(
  candidates: readonly PopulationCandidate[],
  skill: string,
): number {
  const highest = candidates.reduce((max, candidate) => {
    if (candidate.skill !== skill || candidate.generation <= max) {
      return max
    }
    return candidate.generation
  }, 0)
  return highest + 1
}

/**
 * The lineage of one candidate: walk `parentCandidateId` from the oldest
 * ancestor to the candidate itself, oldest-first. Cycles and dangling parents
 * are tolerated — the walk stops when a parent is unknown or already seen —
 * so a malformed chain never loops forever.
 */
export function lineageChain(
  candidates: readonly PopulationCandidate[],
  candidateId: string,
): PopulationCandidate[] {
  const byId = new Map(candidates.map(candidate => [candidate.candidateId, candidate]))
  const chain: PopulationCandidate[] = []
  const seen = new Set<string>()
  let cursor: PopulationCandidate | undefined = byId.get(candidateId)
  while (cursor && !seen.has(cursor.candidateId)) {
    seen.add(cursor.candidateId)
    chain.unshift(cursor)
    cursor = cursor.parentCandidateId === null
      ? undefined
      : byId.get(cursor.parentCandidateId)
  }
  return chain
}

/**
 * The head of a skill: the candidate with the highest generation, newest `at`
 * tie first. Yields `undefined` when the skill has no candidates. The head is
 * the parent of the next recorded candidate, so equal-generation rows resolve
 * deterministically by `at`.
 */
export function headOf(
  candidates: readonly PopulationCandidate[],
  skill: string,
): PopulationCandidate | undefined {
  return candidates
    .filter(candidate => candidate.skill === skill)
    .sort((left, right) =>
      right.generation - left.generation
      || right.at.localeCompare(left.at))[0]
}

function eliteRank(a: PopulationCandidate, b: PopulationCandidate): number {
  if (a.triple === null || b.triple === null) {
    return Number(b.triple !== null) - Number(a.triple !== null)
  }
  if (a.triple.pass !== b.triple.pass) {
    return Number(b.triple.pass) - Number(a.triple.pass)
  }
  if (a.triple.tokens !== b.triple.tokens) {
    return a.triple.tokens - b.triple.tokens
  }
  return a.triple.wallTimeMs - b.triple.wallTimeMs
}

/**
 * Rank the approved candidates of a skill as the current elite: pass first,
 * then fewer tokens, then faster wall time. Candidates without a measure rank
 * below every measured one, preserving a stable, deterministic order.
 */
export function rankElite(
  candidates: readonly PopulationCandidate[],
  skill: string,
): PopulationCandidate[] {
  return candidates
    .filter(candidate => candidate.skill === skill && candidate.status === 'approved')
    .slice()
    .sort(eliteRank)
}
