/**
 * Pure helpers for dependency-aware lineage: dependency-change detection,
 * comparability checks, and ablation attribution. No I/O, no domain —
 * fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-lineage/src/lineage
 */

import type { AblationResults, Attribution, DependencyKey, DependencyVersions } from './types.ts'

/**
 * Every dependency an envelope can version, in canonical order: prompt,
 * skill, retriever, evaluator, model, tool, env.
 */
export const DEPENDENCY_KEYS = ['prompt', 'skill', 'retriever', 'evaluator', 'model', 'tool', 'env'] as const

/**
 * The given keys whose versions differ between two dependency records, in
 * the given key order. An undefined version against a recorded one counts
 * as changed: an experiment measured under an unknown dependency is never
 * silently apples-to-apples with one measured under a known version.
 * @param a - the first dependency record.
 * @param b - the second dependency record.
 * @param keys - the keys to compare, in the order to report.
 * @returns the changed keys, in the given order.
 */
export function changedDependencies(
  a: DependencyVersions,
  b: DependencyVersions,
  keys: readonly DependencyKey[],
): DependencyKey[] {
  const changed: DependencyKey[] = []
  for (const key of keys) {
    if (a[key] !== b[key]) changed.push(key)
  }
  return changed
}

/**
 * Whether two dependency records ran under the same versions on every
 * given key: comparable exactly when no compared key changed.
 * @param a - the first dependency record.
 * @param b - the second dependency record.
 * @param keys - the keys to compare.
 * @returns whether the two records are comparable on those keys.
 */
export function comparable(a: DependencyVersions, b: DependencyVersions, keys: readonly DependencyKey[]): boolean {
  return changedDependencies(a, b, keys).length === 0
}

/**
 * Which change an ablation credits with the improvement. The joint arm
 * must pass for any credit at all: without it there is no gain to
 * attribute. Both single arms passing credits both changes; one passing
 * credits it; neither passing alone credits the interaction — neither
 * change reproduces the joint gain on its own, so no single arm earns it.
 * @param arms - pass or fail of each ablation arm.
 * @returns the attribution of the improvement.
 */
export function attributeImprovement(arms: AblationResults): Attribution {
  if (!arms.both) return 'none'
  if (arms.aOnly && arms.bOnly) return 'both'
  if (arms.aOnly) return 'a'
  if (arms.bOnly) return 'b'
  return 'interaction'
}
