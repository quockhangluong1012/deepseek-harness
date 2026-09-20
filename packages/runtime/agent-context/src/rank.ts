/**
 * Deterministic placement order.
 *
 * The order is total: no two sources compare equal unless they are the same
 * source, so a replay of the same sources reproduces the same placement even
 * when the contributions arrive in a different order. Trust decides the tier,
 * kind decides the group inside it, lexical overlap with the task objective
 * decides the position inside the group, and the source id breaks every
 * remaining tie.
 *
 * @module @deepseek-ai/dsh-agent-context/rank
 */

import type { TrustLabel } from '@deepseek-ai/dsh-agent-kernel'
import type { CompiledSource, ContextSource, ContextSourceKind } from './types.ts'

/** Tier of a trust label. Untrusted content is placed after everything else. */
const TRUST_ORDER: Record<TrustLabel, number> = { trusted: 0, unknown: 1, untrusted: 2 }

/** Group of a source kind inside one trust tier. The task's own authority leads. */
const KIND_ORDER: Record<ContextSourceKind, number> = {
  policy: 0,
  task: 1,
  plan: 2,
  evidence: 3,
  memory: 4,
  artifact: 5,
  history: 6,
  tool: 7,
}

/** Words long enough to carry meaning; shorter runs are structural noise. */
const TERM = /[a-z0-9]{3,}/g

/**
 * The distinct terms one text is about.
 * @param text - the text to tokenize.
 * @returns the lower-cased terms of three or more characters.
 */
export function termsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(TERM) ?? [])
}

/**
 * The lexical overlap between one source and the task objective.
 * @param source - the source to score.
 * @param objectiveTerms - the terms of the task objective.
 * @returns the fraction of the objective's terms the source mentions, in
 *   [0,1]; 0 when the objective has no terms.
 */
export function relevanceOf(source: ContextSource, objectiveTerms: ReadonlySet<string>): number {
  if (objectiveTerms.size === 0) return 0
  let shared = 0
  for (const term of termsOf(source.content)) {
    if (objectiveTerms.has(term)) shared += 1
  }
  return shared / objectiveTerms.size
}

/**
 * Compare two keys by code unit — locale-independent, so the order is
 * identical on every machine.
 * @param left - left key.
 * @param right - right key.
 * @returns a negative number when `left` orders first.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Order two priced sources for placement.
 * @param a - left source.
 * @param b - right source.
 * @returns a negative number when `a` places first.
 */
export function compareCompiled(a: CompiledSource, b: CompiledSource): number {
  const trust = TRUST_ORDER[a.source.trust] - TRUST_ORDER[b.source.trust]
  if (trust !== 0) return trust
  const kind = KIND_ORDER[a.source.kind] - KIND_ORDER[b.source.kind]
  if (kind !== 0) return kind
  if (a.relevance !== b.relevance) return b.relevance - a.relevance
  return compareText(a.source.id, b.source.id)
}

/**
 * Attach each source's relevance to the task objective.
 * @param sources - the envelopes to score.
 * @param objective - the task objective a placement is compiled for.
 * @returns one entry per source, in the input order.
 */
export function scoreSources(sources: readonly ContextSource[], objective: string): { source: ContextSource; relevance: number }[] {
  const objectiveTerms = termsOf(objective)
  return sources.map(source => ({ source, relevance: relevanceOf(source, objectiveTerms) }))
}
