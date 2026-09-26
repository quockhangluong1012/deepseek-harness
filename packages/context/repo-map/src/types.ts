/**
 * The repository map vocabulary: one ranked node of the compact graph the
 * model reads, and the selection bounds a caller applies.
 * @module @deepseek-ai/dsh-repo-map/types
 */

import type { RepoSymbol } from '@deepseek-ai/dsh-repo-index'

/** One ranked symbol and the symbols the map shows beneath it. */
export interface RepoMapNode {
  /** The ranked symbol. */
  readonly symbol: RepoSymbol
  /** The deterministic rank that placed it; higher comes first. */
  readonly score: number
  /** Outgoing references to indexed symbols, best-ranked first. */
  readonly related: readonly RepoSymbol[]
}

/** The selection bounds one ranking call applies. */
export interface RepoMapSelection {
  /** Maximum nodes the map shows. */
  readonly maxNodes: number
  /** Maximum references the map shows beneath one node. */
  readonly maxEdgesPerNode: number
}

/** What the rendered map counted while ranking. */
export interface RepoMapCounts {
  /** Symbols the index holds. */
  readonly symbols: number
  /** Files whose text the index read. */
  readonly indexed: number
}
