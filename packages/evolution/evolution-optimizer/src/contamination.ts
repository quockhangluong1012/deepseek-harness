/**
 * Holdout contamination: a scenario the ledger already records as search for a
 * skill has shaped that skill's selection, so no later run may treat it as a
 * clean holdout for the same skill. Holdout scenarios never train — the guard
 * only reads recorded *search* lists — and reusing a scenario for search is
 * ordinary practice, never contamination.
 * @module @deepseek-ai/dsh-evolution-optimizer/contamination
 */

import type { ExperimentRecord } from './types.ts'

/**
 * Name the holdout scenarios a run must not claim as clean: the ones the
 * skill's own recorded runs already searched. Order follows the holdout list.
 * @param rows - the skill's recorded runs, any order.
 * @param holdout - holdout scenarios the run wants to check.
 * @returns the holdout scenarios already used for search, empty when clean.
 */
export function contaminatedHoldout(rows: readonly ExperimentRecord[], holdout: readonly string[]): string[] {
  const searched = new Set<string>()
  for (const row of rows) {
    for (const scenario of row.scenarios) searched.add(scenario)
  }
  return holdout.filter(scenario => searched.has(scenario))
}
