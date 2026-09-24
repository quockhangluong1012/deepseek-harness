/**
 * Pareto selection over the scorer's metric triple: pass dominates everything,
 * then fewer billed tokens, then the candidate furthest from the skill's
 * archive, then the most novel body, then less wall time. The two novelty
 * axes sit above wall time because they are the axes the run can act on:
 * among candidates that cost the same, the one whose descriptor sits furthest
 * from everything the skill has already staged is the one that explores
 * ground the frontier has not walked, and below it the one that states
 * instructions the starting body did not carry is the one that changes what
 * the skill does — while wall time over fresh replayed processes is machine
 * noise. Dominance stays primary: archive novelty orders the candidates that
 * already beat the baseline, it never promotes one that did not. Pure, so
 * specs drive the arithmetic without spawning anything.
 * @module @deepseek-ai/dsh-evolution-optimizer/pareto
 */

import type { EvaluatedVariant } from './types.ts'

/**
 * How much cheaper one variant must be before its cost counts as better.
 */
const TOKEN_EPSILON = 0.02

/**
 * Whether `a` dominates `b`: at least as good on every axis, strictly better on one.
 * @param a - comparison's left score triple.
 * @param b - comparison's right score triple.
 * @returns true when `a` is at least as good on every axis and better on one.
 */
export function dominates(
  a: { pass: boolean; tokens: number; wallTimeMs: number },
  b: { pass: boolean; tokens: number; wallTimeMs: number },
): boolean {
  if (a.pass !== b.pass) return a.pass
  // Wall time is deliberately absent: it measures the machine, not the
  // candidate (amendment S9). Two bodies within TOKEN_EPSILON of each other
  // bill the same in practice, so neither dominates on tokens alone.
  return a.tokens <= b.tokens * (1 + TOKEN_EPSILON) && a.tokens < b.tokens * (1 - TOKEN_EPSILON)
}

/**
 * Nondominated members of `candidates`, in input order.
 * @param candidates - variants to filter, each carrying its screen score.
 * @returns the candidates no other member dominates, in input order.
 */
export function paretoFrontier(candidates: readonly EvaluatedVariant[]): EvaluatedVariant[] {
  return candidates.filter(
    candidate => !candidates.some(other => other !== candidate && dominates(other.score, candidate.score)),
  )
}

/**
 * Promote the `keep` best-screened variants to a full evaluation: better pass
 * state first, then fewer billed tokens, then the candidate furthest from the
 * skill's archive, then the most novel body, then less wall time, ties broken
 * by mutation order. Screening compares candidates on the same short scenario
 * subset, so this ordering — not dominance — decides who survives.
 * @param screened - variants with the triple their screen scored.
 * @param keep - how many survive; the caller keeps at least one.
 * @returns survivors in mutation order.
 */
export function screenSurvivors(screened: readonly EvaluatedVariant[], keep: number): EvaluatedVariant[] {
  return [...screened]
    .sort((left, right) =>
      Number(right.score.pass) - Number(left.score.pass) ||
      left.score.tokens - right.score.tokens ||
      right.archiveNovelty - left.archiveNovelty ||
      right.novelty - left.novelty ||
      left.index - right.index,
    )
    .slice(0, keep)
    .sort((left, right) => left.index - right.index)
}

/**
 * Pick the winner: the frontier member that dominates the re-scored baseline,
 * breaking ties by fewer tokens, then furthest from the skill's archive, then
 * more novel body, then earlier mutation. Wall time is never an ordering key. Dominance is
 * the only gate, so a candidate that does not beat the baseline is never
 * chosen on novelty.
 * @param baseline - triple the baseline scored under the same harness.
 * @param candidates - evaluated variants in mutation order.
 * @returns the winning variant, or null when nothing beats the baseline.
 */
export function pickWinner(
  baseline: { pass: boolean; tokens: number; wallTimeMs: number },
  candidates: readonly EvaluatedVariant[],
): EvaluatedVariant | null {
  const beating = paretoFrontier(candidates).filter(variant => dominates(variant.score, baseline))
  beating.sort((left, right) =>
    left.score.tokens - right.score.tokens ||
    right.archiveNovelty - left.archiveNovelty ||
    right.novelty - left.novelty ||
    left.index - right.index,
  )
  return beating[0] ?? null
}
