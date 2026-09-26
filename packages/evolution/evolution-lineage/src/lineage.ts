/**
 * Pure helpers for dependency-aware lineage: dependency-change detection,
 * comparability checks, ablation attribution, and the revision arithmetic a
 * policy chain needs (its stored key and the line diff between two bodies).
 * No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-lineage/src/lineage
 */

import type { AblationResults, Attribution, DependencyKey, DependencyVersions, PolicyDiff } from './types.ts'

/** Separator between a policy identity and its revision number in a stored key. */
const REVISION_KEY_SEPARATOR = '#'

/**
 * The stored key of one policy revision. Exporting the format keeps the store
 * and any reader deriving keys the same way.
 * @param policy - policy identity.
 * @param version - revision number inside that policy.
 * @returns the durable key for that revision.
 */
export function revisionKey(policy: string, version: number): string {
  return `${policy}${REVISION_KEY_SEPARATOR}${version}`
}

/**
 * Count the lines one policy body change added and removed: both bodies minus
 * their longest common subsequence, so unchanged lines in place cost nothing
 * and every other line counts once on its own side. Order-sensitive — a pure
 * reorder counts as change. Memoized recursion keeps it quadratic in the body
 * sizes, which is fine for policy bodies of hundreds of lines.
 * @param before - the replaced body.
 * @param after - the body that replaced it.
 * @returns added and removed line counts.
 */
export function lineDiff(before: string, after: string): PolicyDiff {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  const memo = new Map<string, number>()
  const shared = (i: number, j: number): number => {
    if (i >= oldLines.length || j >= newLines.length) return 0
    const key = `${i},${j}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    const value = oldLines[i] === newLines[j]
      ? shared(i + 1, j + 1) + 1
      : Math.max(shared(i + 1, j), shared(i, j + 1))
    memo.set(key, value)
    return value
  }
  const common = shared(0, 0)
  return { addedLines: newLines.length - common, removedLines: oldLines.length - common }
}

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
