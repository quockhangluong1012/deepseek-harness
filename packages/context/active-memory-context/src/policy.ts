/**
 * Pure task-aware retrieval policy: given the §39 configuration
 * `dsh-evolution-retrieval` recommends for a turn's task class, decide which
 * dimensions this injector's own knobs can run and report the rest unapplied.
 * Pure: no service access, no I/O.
 * @module @deepseek-ai/dsh-active-memory-context/policy
 */

import type { EscalationMode } from './index.ts'

/** One §39 retrieval dimension this policy classifies, in configuration order. */
export type RetrievalDimension =
  | 'source'
  | 'queryExpansion'
  | 'weights'
  | 'reranker'
  | 'mmr'
  | 'memoryScope'
  | 'graphDepth'
  | 'threshold'

/** One dimension the injector runs at the recommended value. */
export interface AppliedRetrievalDimension {
  /** The dimension's name. */
  dimension: RetrievalDimension
  /** The recommended value, rendered for the record. */
  value: string
}

/** One dimension the injector cannot run at the recommended value, and why. */
export interface UnappliedRetrievalDimension extends AppliedRetrievalDimension {
  /** Why this injector cannot vary the dimension. */
  reason: string
}

/**
 * The §39 configuration one recommendation names, as the retrieval store
 * records it. Declared structurally rather than imported so active memory keeps
 * no hard dependency on the retrieval package, the same discipline the graph
 * seam follows.
 */
export interface RecommendedRetrievalConfiguration {
  /** Retrieval-lane dimension: the graph leg alone, both legs, or the vector leg alone. */
  source: 'vector' | 'graph' | 'hybrid'
  /** Query-expansion dimension the configuration applies. */
  queryExpansion: 'none' | 'graph-entities' | 'synonyms'
  /** Lane-weight dimension the configuration fuses with. */
  weights: { readonly vector: number; readonly graph: number }
  /** Reranker dimension the configuration applies to fused candidates. */
  reranker: 'none' | 'cross-encoder'
  /** Maximum-marginal-relevance dimension the configuration diversifies with. */
  mmr: { readonly enabled: boolean; readonly lambda: number }
  /** Memory-scope dimension the configuration searches. */
  memoryScope: 'session' | 'workspace' | 'global'
  /** Graph-depth dimension: hops the graph leg expands, at least 1. */
  graphDepth: number
  /** Active-memory threshold dimension: minimum similarity a hit must clear, in 0..1. */
  threshold: number
}

/**
 * One task class's recommendation, as `ctx.evolutionRetrieval.recommend`
 * returns it: the configuration and the canonical key it is recorded under.
 */
export interface RetrievalRecommendation {
  /** Canonical key of the recommended configuration. */
  configKey: string
  /** The configuration itself. */
  configuration: RecommendedRetrievalConfiguration
}

/** What one turn's recommendation decision applied, and what it could not. */
export interface RetrievalPolicyApplication {
  /** Task class the recommendation was consulted for. */
  taskClass: string
  /** Canonical key of the recommended configuration. */
  configKey: string
  /** The §39 dimensions the turn now runs at the recommended value. */
  applied: readonly AppliedRetrievalDimension[]
  /** The §39 dimensions the injector cannot vary, with the reason each is left alone. */
  unapplied: readonly UnappliedRetrievalDimension[]
  /** The knobs the turn actually runs with. */
  effective: {
    /** Lane strategy, the recommended source mapped onto the injector's own modes. */
    escalation: EscalationMode
    /** Hops the graph leg expands from the entity it matched. */
    graphDepth: number
    /** Minimum similarity a hit must clear to be injected. */
    threshold: number
  }
}

/**
 * Decide one turn's retrieval policy from the recommendation for its task
 * class. The dimensions the injector owns — the lane map, the memory scope, the
 * graph depth, the active-memory threshold — are applied at the recommended
 * value; the rest are reported unapplied with the reason, so a recommendation
 * this injector cannot fully serve is never silently half-run. A dimension is
 * applied when the injector can honor the recommended value: the source maps
 * `graph` onto `graph-first` and `hybrid` onto `both`, and `memoryScope`
 * applies only for `workspace`, which is the one scope the injector searches.
 * @param taskClass - the task class the recommendation was consulted for.
 * @param recommendation - the recommended configuration and its canonical key.
 * @param escalation - the mount's own lane strategy, kept when the source cannot map.
 * @returns the applied dimensions, the unapplied ones, and the turn's knobs.
 */
export function applyRetrievalPolicy(
  taskClass: string,
  recommendation: RetrievalRecommendation,
  escalation: EscalationMode,
): RetrievalPolicyApplication {
  const { source, queryExpansion, weights, reranker, mmr, memoryScope, graphDepth, threshold } =
    recommendation.configuration
  const applied: AppliedRetrievalDimension[] = []
  const unapplied: UnappliedRetrievalDimension[] = []
  let effective = escalation
  if (source === 'vector') {
    unapplied.push({
      dimension: 'source',
      value: source,
      reason: 'the injector has no vector-only lane: `both` runs the graph leg as well',
    })
  } else {
    effective = source === 'graph' ? 'graph-first' : 'both'
    applied.push({ dimension: 'source', value: source })
  }
  unapplied.push({
    dimension: 'queryExpansion',
    value: queryExpansion,
    reason: "the graph leg always expands the turn's own words into entity labels",
  })
  unapplied.push({
    dimension: 'weights',
    value: JSON.stringify(weights),
    reason: 'fusion is a reciprocal-rank sum over both legs, which weighs them equally',
  })
  unapplied.push({
    dimension: 'reranker',
    value: reranker,
    reason: 'no reranker is mounted: fused rank is the final order',
  })
  unapplied.push({
    dimension: 'mmr',
    value: JSON.stringify(mmr),
    reason: 'the brief keeps fusion order, undiversified',
  })
  if (memoryScope === 'workspace') {
    applied.push({ dimension: 'memoryScope', value: memoryScope })
  } else {
    unapplied.push({
      dimension: 'memoryScope',
      value: memoryScope,
      reason: "the injector searches the session's own workspace only",
    })
  }
  applied.push({ dimension: 'graphDepth', value: String(graphDepth) })
  applied.push({ dimension: 'threshold', value: String(threshold) })
  return {
    taskClass,
    configKey: recommendation.configKey,
    applied,
    unapplied,
    effective: { escalation: effective, graphDepth, threshold },
  }
}
