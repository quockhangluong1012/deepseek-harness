/**
 * Pareto selection over the scorer's metric triple: pass dominates everything,
 * then fewer billed tokens, then less wall time. Pure, so specs drive the
 * arithmetic without spawning anything.
 * @module @deepseek-ai/dsh-evolution-optimizer/pareto
 */

import type { EvaluatedVariant } from './types.ts'

/** Whether `a` dominates `b`: at least as good on every axis, strictly better on one. */
export function dominates(
  a: { pass: boolean; tokens: number; wallTimeMs: number },
  b: { pass: boolean; tokens: number; wallTimeMs: number },
): boolean {
  if (a.pass !== b.pass) return a.pass
  return (
    (a.tokens <= b.tokens && a.wallTimeMs <= b.wallTimeMs) &&
    (a.tokens < b.tokens || a.wallTimeMs < b.wallTimeMs)
  )
}

/** Nondominated members of `candidates`, in input order. */
export function paretoFrontier(candidates: readonly EvaluatedVariant[]): EvaluatedVariant[] {
  return candidates.filter(
    candidate => !candidates.some(other => other !== candidate && dominates(other.score, candidate.score)),
  )
}

/**
 * Promote the `keep` best-screened variants to a full evaluation: better pass
 * state first, then fewer billed tokens, then less wall time, ties broken by
 * mutation order. Screening compares candidates on the same short scenario
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
      left.score.wallTimeMs - right.score.wallTimeMs ||
      left.index - right.index,
    )
    .slice(0, keep)
    .sort((left, right) => left.index - right.index)
}

/**
 * Pick the winner: the frontier member that dominates the re-scored baseline,
 * breaking ties by fewer tokens, then less wall time, then earlier mutation.
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
    left.score.wallTimeMs - right.score.wallTimeMs ||
    left.index - right.index,
  )
  return beating[0] ?? null
}
