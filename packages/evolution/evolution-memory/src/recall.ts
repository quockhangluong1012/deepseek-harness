/**
 * The §23 relevance feedback loop and §24 memory utility: the recall ledger
 * the store keeps beside its context items, the links from one recall to the
 * evidence that landed afterwards, and the utility a recalled memory's
 * recorded evidence yields.
 *
 * The loop is recorded one link at a time. `retrieved` is the recall the
 * shipped recall path attached, counted here as the recall lands; `affected
 * decision` is the decision batch that landed on the scope after it, whose
 * session the store records; `helped outcome` is the graded outcome of that
 * session, recorded by the grader that reads the feedback store. `used` and
 * `cited` have no record at all in this profile — nothing observes whether an
 * injected item was read, and nothing marks one as cited — so no function
 * here invents them.
 *
 * A memory's utility is the product of the factors the profile does record:
 * retrieval relevance, decision impact, and outcome gain. §24's fourth
 * factor, source quality, has no recorded source for a recalled memory —
 * nothing rates the session a recall came from — so the reading carries three
 * factors rather than a made-up fourth.
 * @module @deepseek-ai/dsh-evolution-memory/recall
 */

import type { MemoryRecall } from './types.ts'

/**
 * Label prefix marking context the reviewer recalled from session history
 * rather than the user attaching it. Writers label recalled items with it and
 * consumers order them last, so a recalled item is the first context material
 * a brief drops under its byte budget. The store also keeps the recall ledger
 * from it: an item whose label carries this prefix is one recall of the
 * memory the label names.
 */
export const RECALL_LABEL_PREFIX = 'Recall: '

/**
 * Read the recalled memory's identity out of one context label.
 * @param label - the context item's label.
 * @returns the identity the `Recall: ` prefix carries, or undefined when the
 * label is not a recall or names nothing.
 */
export function recallTarget(label: string): string | undefined {
  if (!label.startsWith(RECALL_LABEL_PREFIX)) return undefined
  const id = label.slice(RECALL_LABEL_PREFIX.length).trim()
  return id.length === 0 ? undefined : id
}

/**
 * Append one recall to the ledger, newest first, dropping the oldest past the
 * configured cap. A memory recalled more often than the cap therefore keeps
 * its newest recalls and loses the oldest evidence, so its recall count is a
 * count of retained recalls, never an all-time total.
 * @param recalls - the scope's recorded recalls, newest first.
 * @param recall - the recall that just landed.
 * @param maxRecalls - recalls retained per scope.
 * @returns the ledger with the recall prepended.
 */
export function appendRecall(
  recalls: readonly MemoryRecall[],
  recall: MemoryRecall,
  maxRecalls: number,
): MemoryRecall[] {
  return [recall, ...recalls].slice(0, maxRecalls)
}

/**
 * Bind every recall still awaiting a decision to the batch landing now. A
 * recall is bound once — the first decision batch that lands on its scope
 * after it — so a later batch never rewrites what an earlier one recorded.
 * @param recalls - the scope's recorded recalls, newest first.
 * @param sessionId - session the landing batch was extracted from.
 * @param at - ISO-8601 instant the batch landed.
 * @returns the ledger with its awaiting recalls bound, or the input when none
 * was awaiting one.
 */
export function bindRecalls(
  recalls: readonly MemoryRecall[],
  sessionId: string,
  at: string,
): readonly MemoryRecall[] {
  if (!recalls.some(recall => recall.decidedInSessionId === null)) return recalls
  return recalls.map(recall => recall.decidedInSessionId === null
    ? { ...recall, decidedInSessionId: sessionId, decidedAt: at }
    : recall)
}

/**
 * Stamp the graded outcome of one recall. The newest recall of that memory
 * still awaiting an outcome is the one graded, so a memory recalled again
 * after an outcome was recorded is graded again on its newer recall.
 * @param recalls - the scope's recorded recalls, newest first.
 * @param id - recalled memory's identity.
 * @param outcome - the graded outcome.
 * @param at - ISO-8601 instant the outcome was recorded.
 * @returns the ledger with the recall graded, or the input when no recall of
 * that memory awaits an outcome.
 */
export function gradeRecall(
  recalls: readonly MemoryRecall[],
  id: string,
  outcome: 'ok' | 'failed',
  at: string,
): readonly MemoryRecall[] {
  const awaiting = recalls.findIndex(recall => recall.id === id && recall.outcome === null)
  if (awaiting === -1) return recalls
  return recalls.map((recall, index) => index === awaiting ? { ...recall, outcome, outcomeAt: at } : recall)
}

/** One recalled memory's recorded evidence, aggregated over its recalls. */
export interface MemoryUtility {
  /** Recalled memory's identity, as its recall labels carried it. */
  readonly id: string
  /** Recalls of this memory the shipped recall path recorded. */
  readonly recalls: number
  /** Recalls a decision batch landed after, recording that batch's session. */
  readonly decidedRecalls: number
  /** Recalls carrying a graded outcome. */
  readonly gradedRecalls: number
  /** Graded recalls whose outcome was clean. */
  readonly okRecalls: number
  /**
   * §24's estimated utility: relevance × decision impact × outcome gain, each
   * in [0, 1]. Relevance is `n / (n + 1)` over the recorded recalls, the
   * saturation the knowledge graph's belief already uses for repeated
   * evidence, so no memory reaches the ceiling on retrieval alone. Decision
   * impact and outcome gain are shares of this memory's own recalls: a recall
   * no decision followed contributes no impact, and a recall whose outcome
   * was never recorded contributes no gain, so a memory with recorded help
   * outranks one without. The product never includes §24's fourth factor,
   * source quality, which no record rates for a recalled memory.
   */
  readonly utility: number
}

/**
 * Derive the utility of every recorded memory from the recall ledger.
 * @param recalls - every recorded recall of the population, one row per scope.
 * @returns one reading per recalled memory, in first-recall order.
 */
export function memoryUtility(recalls: readonly MemoryRecall[]): MemoryUtility[] {
  const byMemory = new Map<string, MemoryRecall[]>()
  for (const recall of recalls) {
    const found = byMemory.get(recall.id)
    if (found === undefined) byMemory.set(recall.id, [recall])
    else found.push(recall)
  }
  return [...byMemory].map(([id, rows]) => {
    const decidedRecalls = rows.filter(row => row.decidedInSessionId !== null).length
    const gradedRecalls = rows.filter(row => row.outcome !== null).length
    const okRecalls = rows.filter(row => row.outcome === 'ok').length
    const count = rows.length
    return {
      id,
      recalls: count,
      decidedRecalls,
      gradedRecalls,
      okRecalls,
      utility: count / (count + 1) * (decidedRecalls / count) * (okRecalls / count),
    }
  })
}
