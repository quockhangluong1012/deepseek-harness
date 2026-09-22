/**
 * Declared skill-pair relations: one implementation of the rules that decide
 * whether a set of skills may sit beside each other. The registry carries the
 * relations, the loader enforces them on a load set, and the `skill_manage`
 * derivation enforces composability on a synthesis source set — all through
 * these functions, so no second composition convention exists.
 *
 * Every relation here is symmetric by declaration: one side naming the other
 * is enough to settle the pair. Nothing in this module reads a file, a store,
 * or a model; it decides over the declarations a catalog already carries.
 * @module @deepseek-ai/dsh-skill/src/composition
 */

/**
 * The declared relations of one skill, as summaries and definitions carry
 * them. A caller passes whatever it has: an absent relation is an undeclared
 * one, never an empty set of names.
 */
export interface CompositionMember {
  /** Skill name the relations belong to. */
  readonly name: string
  /** Skill names this skill must not be selected alongside; absent means none. */
  readonly conflictsWith?: readonly string[]
  /**
   * Skill names this skill may load beside. Declaring the list makes it an
   * allowlist: any other member of the same load set is refused, because the
   * author named the compatible partners and nothing else.
   */
  readonly compatibleWith?: readonly string[]
  /**
   * Skill names this skill may be synthesized with. Declaring the list makes
   * it an allowlist for the `skill_manage` derivation: a source set containing
   * an unnamed skill is refused.
   */
  readonly composableWith?: readonly string[]
}

/**
 * The first pair a declared allowlist excludes: a member naming partners, and
 * another member not among them. An absent or empty list constrains nobody —
 * an empty allowlist is not a skill that refuses every sibling.
 * @param members - the set being checked, in catalog order.
 * @param allowlist - the declaration read for one member.
 * @returns the excluded pair, or undefined when every declaration admits the set.
 */
function firstExcludedPair(
  members: readonly CompositionMember[],
  allowlist: (member: CompositionMember) => readonly string[] | undefined,
): { readonly owner: string; readonly peer: string } | undefined {
  for (const owner of members) {
    const allowed = allowlist(owner)
    if (allowed === undefined || allowed.length === 0) continue
    for (const peer of members) {
      if (peer.name === owner.name || allowed.includes(peer.name)) continue
      return { owner: owner.name, peer: peer.name }
    }
  }
  return undefined
}

/**
 * Whether a load set is consistent by declaration: no conflict inside the set,
 * and no member excluded by another's `compatibleWith` allowlist. The check is
 * symmetric — one side declaring the relation settles the pair — and a
 * declaration naming a skill outside the set is ignored, because the loader
 * only owns the set in front of it.
 * @param requested - the skill the caller asked to load.
 * @param members - the skills loading beside it.
 * @returns the refusal naming the pair, or undefined when the set is consistent.
 */
export function compositionRefusal(
  requested: CompositionMember,
  members: readonly CompositionMember[],
): string | undefined {
  const loaded = [requested, ...members]
  const present = new Set(loaded.map(member => member.name))
  for (const owner of loaded) {
    for (const rival of owner.conflictsWith ?? []) {
      if (rival === owner.name || !present.has(rival)) continue
      return `skill "${requested.name}" cannot load: "${owner.name}" and "${rival}" declare a conflict`
    }
  }
  const incompatible = firstExcludedPair(loaded, member => member.compatibleWith)
  if (incompatible !== undefined) {
    return `skill "${requested.name}" cannot load: "${incompatible.owner}" is not compatible with "${incompatible.peer}"`
  }
  return undefined
}

/**
 * Whether a synthesis source set may be composed: no member excludes another
 * through `composableWith`. The same allowlist rule as {@link compositionRefusal},
 * applied to the primitives a derived skill is built from.
 * @param sources - the source skills of the derivation, at least two.
 * @returns the refusal naming the pair, or undefined when the set composes.
 */
export function composabilityRefusal(sources: readonly CompositionMember[]): string | undefined {
  const excluded = firstExcludedPair(sources, member => member.composableWith)
  return excluded === undefined ? undefined : `"${excluded.owner}" is not composable with "${excluded.peer}"`
}
