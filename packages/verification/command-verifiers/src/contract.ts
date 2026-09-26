/**
 * The comparison a change boundary is decided by: the scopes a change touched
 * against the contract its task declared before touching anything.
 *
 * The comparison is pure and reads nothing but its two arguments, so a replayed
 * log decides the same criterion, and it reports every broken bound rather than
 * the first: a change that touched a forbidden path and skipped an expected one
 * must learn both from one verdict.
 *
 * @module @deepseek-ai/dsh-command-verifiers/contract
 */

import type { ChangeContract } from '@deepseek-ai/dsh-agent-kernel'
import { withinExpectedPaths } from './targets.ts'

/** One declared bound a change broke. */
export interface ContractViolation {
  /** Human- and model-readable reason, naming the bound and the scopes that broke it. */
  readonly reason: string
  /** Changed scopes the violation rests on; empty for a bound the change had to reach and did not. */
  readonly scopes: readonly string[]
}

/** The comparison of one change against the boundary its task declared. */
export interface ContractComparison {
  /** Bounds the change broke, in declaration order; empty when it stayed inside the contract. */
  readonly violations: readonly ContractViolation[]
  /** Whether the contract declared any bound to compare. False means it admits every change. */
  readonly bounded: boolean
}

/** A contract field whose globs bound a change. */
type BoundField = keyof Omit<ChangeContract, 'goal'>

/**
 * One declared bound: which contract field it is, how a reason names it, and
 * which way a change breaks it. `require` bounds must be reached by the change
 * (`changed none of the expected files`), `admit` bounds accept only scopes a
 * glob selects (`changed outside the allowed files`), and `refuse` bounds accept
 * no scope a glob selects (`changed a forbidden path`).
 */
interface Bound {
  readonly field: BoundField
  /** Noun phrase the reason for a broken bound names. */
  readonly label: string
  readonly kind: 'require' | 'admit' | 'refuse'
}

/** Every bound a contract can declare, in the order a comparison reports the broken ones. */
const BOUNDS: readonly Bound[] = [
  { field: 'expectedFiles', label: 'expected files', kind: 'require' },
  { field: 'expectedTests', label: 'expected tests', kind: 'require' },
  { field: 'allowedFiles', label: 'allowed files', kind: 'admit' },
  { field: 'forbiddenChanges', label: 'a forbidden path', kind: 'refuse' },
  { field: 'mustPreserve', label: 'a path the contract must preserve', kind: 'refuse' },
]

/**
 * Every bound one change broke.
 * @param contract - the boundary the task declared.
 * @param changedScopes - the scopes the change touched, as the `workspace/changes` recorder reported them.
 * @returns the broken bounds in declaration order, and whether the contract declared any bound at all.
 */
export function compareChangeContract(
  contract: ChangeContract,
  changedScopes: readonly string[],
): ContractComparison {
  const changed = changedScopes.map(scope => scope.replaceAll('\\', '/'))
  const violations: ContractViolation[] = []
  let bounded = false
  for (const { field, label, kind } of BOUNDS) {
    const globs = contract[field]
    if (globs.length === 0) continue
    bounded = true
    const named = globs.join(', ')
    if (kind === 'require') {
      const missing = globs.filter(glob => !changed.some(scope => withinExpectedPaths(scope, [glob])))
      if (missing.length > 0) {
        violations.push({ reason: `changed none of the ${label} (${named}): ${missing.join(', ')}`, scopes: [] })
      }
      continue
    }
    const offenders = changed.filter(scope => kind === 'admit'
      ? !withinExpectedPaths(scope, globs)
      : withinExpectedPaths(scope, globs))
    if (offenders.length === 0) continue
    violations.push({
      reason: kind === 'admit'
        ? `changed outside the ${label} (${named}): ${offenders.join(', ')}`
        : `changed ${label} (${named}): ${offenders.join(', ')}`,
      scopes: offenders,
    })
  }
  return { violations, bounded }
}
