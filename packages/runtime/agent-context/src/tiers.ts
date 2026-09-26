/**
 * The context tiers of the evolutionary runtime specification, and the gate
 * that keeps a configured tier out of a placement until a compile asks for it.
 *
 * A tier is a function of the source's kind, so a producer registers one
 * placement (`ContextPlacement`) and never a tier: this module groups the kinds
 * the ranking already uses and adds no second classification to the registry.
 *
 * @module @deepseek-ai/dsh-agent-context/tiers
 */

import type {
  ContextDeferredSource,
  ContextSource,
  ContextSourceKind,
  ContextTier,
  ContextTierDemand,
} from './types.ts'

/** Every tier, from the standing instructions to content held outside the placement. */
export const CONTEXT_TIERS: readonly ContextTier[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']

/**
 * The tier each source kind sits in.
 *
 * - `L0` policies and system: the standing instructions that apply to every step.
 * - `L1` task state: the task contract and its acceptance criteria.
 * - `L2` working memory: the plan and the evidence the current step turns on.
 * - `L3` relevant memory: validated memory retrieved for the task.
 * - `L4` recent history: recent turns and tool results.
 * - `L5` artifact references: pointers to content stored outside the context.
 * - `L6` cold storage: content the placement never carries; an `L5` reference
 *   names it and a retrieval reads it.
 */
export const TIER_OF_KIND: Record<ContextSourceKind, ContextTier> = {
  policy: 'L0',
  task: 'L1',
  plan: 'L2',
  evidence: 'L2',
  memory: 'L3',
  history: 'L4',
  tool: 'L4',
  artifact: 'L5',
}

/**
 * The tier one source kind sits in.
 * @param kind - the source kind.
 * @returns the tier, from {@link TIER_OF_KIND}.
 */
export function tierOf(kind: ContextSourceKind): ContextTier {
  return TIER_OF_KIND[kind]
}

/** The sources one tier gate admitted, and the ones it withheld. */
export interface TierAdmission {
  /** The sources the compile may place, in candidate order. */
  readonly admitted: readonly ContextSource[]
  /** The withheld sources, in candidate order; empty when the policy withholds no tier present. */
  readonly deferred: readonly ContextDeferredSource[]
}

/**
 * Split one compile's candidate sources into the ones its policy admits and the
 * ones it withholds. A source is withheld exactly when it is compressible, its
 * tier is named in `onDemand`, and neither the compile's demand nor its own id
 * admits it; a withheld source is never priced, ranked, omitted, or digested, so
 * the placement stays the same size whether or not the withheld candidate
 * exists. A `required` source is admitted whatever its tier, so the ceiling's
 * own rule — required authority is placed before any cut is consulted — holds
 * for the tier policy too, and a deployment that names a tier of required kinds
 * withholds nothing.
 * @param sources - the candidates, in the order the compile collected them.
 * @param onDemand - tiers the policy withholds from the placement.
 * @param demand - what this compile asks for: whole tiers, ids, or both.
 * @returns the admitted sources and the withheld ones, each in candidate order.
 */
export function admitSources(
  sources: readonly ContextSource[],
  onDemand: readonly ContextTier[],
  demand?: ContextTierDemand,
): TierAdmission {
  if (onDemand.length === 0) return { admitted: sources, deferred: [] }
  const withheld = new Set(onDemand)
  const demandedTiers = new Set(demand?.tiers ?? [])
  const demandedIds = new Set(demand?.sourceIds ?? [])
  const admitted: ContextSource[] = []
  const deferred: ContextDeferredSource[] = []
  for (const source of sources) {
    const tier = tierOf(source.kind)
    if (source.retention === 'required' || !withheld.has(tier) || demandedTiers.has(tier) || demandedIds.has(source.id)) {
      admitted.push(source)
      continue
    }
    deferred.push({ id: source.id, kind: source.kind, tier })
  }
  return { admitted, deferred }
}
