/**
 * The deterministic ranking behind the repository map: the task objective
 * supplies the search terms, and a fixed weighted score — objective term
 * overlap on the symbol name and path, reference degree, and declaration kind —
 * orders every symbol. Ties break on identifier, path, and line by code unit,
 * so the same index and objective always produce the same map.
 * @module @deepseek-ai/dsh-repo-map/rank
 */

import type { RepoIndexSnapshot, RepoSymbol, RepoSymbolKind } from '@deepseek-ai/dsh-repo-index'
import type { RepoMapNode, RepoMapSelection } from './types.ts'

/** Shortest objective word that counts as a search term. */
const OBJECTIVE_TERM_MIN_LENGTH = 3

/** Most objective words one ranking call reads. */
const OBJECTIVE_TERM_LIMIT = 64

/** Score weight of an objective term that equals the whole symbol name. */
const EXACT_NAME_WEIGHT = 8

/** Score weight of one objective term matched to a word of the symbol name. */
const NAME_WORD_WEIGHT = 4

/** Score weight of one objective term matched to a word of the declaring path. */
const PATH_WORD_WEIGHT = 2

/** Highest reference degree the score counts, so a hub cannot bury the objective's own terms. */
const DEGREE_CEILING = 8

/** Score weight of one reference, in or out. */
const DEGREE_WEIGHT = 1

/** Score contribution of the declaration kind, before objective terms. */
const KIND_WEIGHTS: Record<RepoSymbolKind, number> = {
  class: 3,
  interface: 3,
  function: 2,
  type: 2,
  enum: 2,
  const: 1,
}

/** One symbol with the score that ranks it. */
interface ScoredSymbol {
  readonly symbol: RepoSymbol
  score: number
}

/**
 * The distinct words of a task objective, lowercased and order-preserving.
 * @param objective - the task's objective text, of any length.
 * @returns at most {@link OBJECTIVE_TERM_LIMIT} distinct words of at least {@link OBJECTIVE_TERM_MIN_LENGTH} characters.
 */
export function objectiveTerms(objective: string): string[] {
  const terms = new Set<string>()
  for (const term of objective.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (term.length < OBJECTIVE_TERM_MIN_LENGTH || terms.has(term)) continue
    terms.add(term)
    if (terms.size === OBJECTIVE_TERM_LIMIT) break
  }
  return [...terms]
}

/** The lowercase words of an identifier or path, split on case boundaries and separators. */
function wordSet(text: string): ReadonlySet<string> {
  const words = new Set<string>()
  for (const word of text.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().split(/[^a-z0-9]+/u)) {
    if (word.length > 0) words.add(word)
  }
  return words
}

/** The weighted objective overlap, reference degree, and declaration kind of one symbol. */
function scoreOf(symbol: RepoSymbol, terms: readonly string[], degree: number): number {
  const nameWords = wordSet(symbol.name)
  const pathWords = wordSet(symbol.path)
  let score = KIND_WEIGHTS[symbol.kind] + DEGREE_WEIGHT * Math.min(degree, DEGREE_CEILING)
  for (const term of terms) {
    if (nameWords.has(term)) score += NAME_WORD_WEIGHT
    if (pathWords.has(term)) score += PATH_WORD_WEIGHT
    if (symbol.name.toLowerCase() === term) score += EXACT_NAME_WEIGHT
  }
  return score
}

/**
 * Resolve one reference endpoint to the symbol carrying its id.
 * @param byId - every indexed symbol keyed by id.
 * @param id - the endpoint id the index emitted.
 * @returns the endpoint entry.
 */
function endpointOf(byId: ReadonlyMap<string, ScoredSymbol>, id: string): ScoredSymbol {
  const found = byId.get(id)
  /* v8 ignore next -- the index emits every reference endpoint from its own symbol ids */
  if (found === undefined) throw new Error(`repo-map: reference endpoint ${id} is not an indexed symbol`)
  return found
}

/** Rank order: score descending, then identifier, path, and line, all by code unit. */
function byRank(left: ScoredSymbol, right: ScoredSymbol): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.symbol.name !== right.symbol.name) return left.symbol.name < right.symbol.name ? -1 : 1
  if (left.symbol.path !== right.symbol.path) return left.symbol.path < right.symbol.path ? -1 : 1
  /* v8 ignore next -- one declaration line yields at most one symbol */
  return left.symbol.line - right.symbol.line
}

/**
 * Rank an index against one objective.
 * @param snapshot - the index to rank.
 * @param objective - the task objective supplying the search terms.
 * @param selection - the node and reference bounds.
 * @returns the highest-ranked nodes, best first, each with its best-ranked related symbols.
 */
export function rankRepositoryMap(
  snapshot: RepoIndexSnapshot,
  objective: string,
  selection: RepoMapSelection,
): readonly RepoMapNode[] {
  const terms = objectiveTerms(objective)
  const scored: ScoredSymbol[] = snapshot.symbols.map(symbol => ({ symbol, score: 0 }))
  const byId = new Map(scored.map(entry => [entry.symbol.id, entry]))
  const outgoing = new Map<string, ScoredSymbol[]>()
  const degrees = new Map<string, number>()
  for (const edge of snapshot.references) {
    const from = endpointOf(byId, edge.from)
    const target = endpointOf(byId, edge.to)
    const known = outgoing.get(from.symbol.id)
    if (known === undefined) outgoing.set(from.symbol.id, [target])
    else known.push(target)
    degrees.set(from.symbol.id, (degrees.get(from.symbol.id) ?? 0) + 1)
    degrees.set(target.symbol.id, (degrees.get(target.symbol.id) ?? 0) + 1)
  }
  for (const entry of scored) entry.score = scoreOf(entry.symbol, terms, degrees.get(entry.symbol.id) ?? 0)
  return scored
    .sort(byRank)
    .slice(0, selection.maxNodes)
    .map(entry => ({
      symbol: entry.symbol,
      score: entry.score,
      related: [...(outgoing.get(entry.symbol.id) ?? [])]
        .sort((left, right) => right.score - left.score || (left.symbol.id < right.symbol.id ? -1 : 1))
        .map(target => target.symbol)
        .slice(0, selection.maxEdgesPerNode),
    }))
}
