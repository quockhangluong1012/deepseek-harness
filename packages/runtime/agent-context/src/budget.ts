/**
 * Token pricing and the budget cut.
 *
 * Prices come from the token meter's fixed-heuristic estimator — the same
 * function that prices a request's content blocks — so a placement's reported
 * size and the meter's measurement of the identical text agree by construction
 * rather than by coincidence.
 *
 * @module @deepseek-ai/dsh-agent-context/budget
 */

import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import type { CompiledSource, ContextOmission, ContextSource } from './types.ts'

/** One scored source, before it is priced. */
export interface ScoredSource {
  /** The envelope. */
  readonly source: ContextSource
  /** Lexical overlap with the task objective in [0,1]. */
  readonly relevance: number
}

/** The placement a budget produced. */
export interface BudgetPlacement {
  /** The sources that fit, in placement order. */
  readonly included: readonly CompiledSource[]
  /** The sources the ceiling cut, in placement order. */
  readonly omitted: readonly ContextOmission[]
  /** Sum of the placed sources' token prices. */
  readonly tokenEstimate: number
}

/**
 * Price one source's content under the token meter's fixed heuristic.
 * @param source - the envelope to price.
 * @returns the content's token price as a model-visible text block.
 */
export function priceOf(source: ContextSource): number {
  return estimateContent([{ type: 'text', text: source.content }])
}

/**
 * Attach each scored source's token price.
 * @param scored - the scored envelopes.
 * @returns one priced entry per input, in the input order.
 */
export function priceSources(scored: readonly ScoredSource[]): CompiledSource[] {
  return scored.map(entry => ({ ...entry, tokens: priceOf(entry.source) }))
}

/**
 * Cut the placement at a token ceiling. The ceiling cuts a prefix of the
 * placement order: once a droppable source does not fit, every later droppable
 * source is omitted too, so the placement stays a stable prefix. A required
 * source is placed even when it alone exceeds the ceiling, so a bounded
 * placement can still price above its ceiling — the task's own authority is
 * never the thing that gets dropped.
 * @param priced - the priced sources, in placement order.
 * @param maxTokens - the ceiling, or null for no ceiling.
 * @returns the placed sources, the omitted ones, and the placement's price.
 */
export function fitBudget(priced: readonly CompiledSource[], maxTokens: number | null): BudgetPlacement {
  const included: CompiledSource[] = []
  const omitted: ContextOmission[] = []
  let tokens = 0
  let cut = false
  for (const entry of priced) {
    if (entry.source.retention === 'required') {
      included.push(entry)
      tokens += entry.tokens
      continue
    }
    if (!cut && (maxTokens === null || tokens + entry.tokens <= maxTokens)) {
      included.push(entry)
      tokens += entry.tokens
      continue
    }
    cut = true
    omitted.push({ id: entry.source.id, reason: 'budget' })
  }
  return { included, omitted, tokenEstimate: tokens }
}
