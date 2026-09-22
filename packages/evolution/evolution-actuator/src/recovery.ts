/**
 * The pure rung mapping behind stagnation recovery: which step a §32 ladder
 * rung asks this engine to perform. No I/O.
 * @module @deepseek-ai/dsh-evolution-actuator/src/recovery
 */

import type { StagnationStrategy } from '@deepseek-ai/dsh-evolution-stagnation'
import type { RecoveryStep } from './types.ts'

/**
 * The step one ladder rung asks for. Three rungs name something an existing
 * store accepts: a diversity migration into the skill's novelty lane, the
 * mutation instruction `evolution-operators` recommends for the skill's
 * artifact class, and a curriculum proposal derived from its measured gaps.
 *
 * The `newOperators` rung is a read, not a write: `evolution-operators` owns
 * the operator portfolio and proposes the instruction to try next, and nothing
 * in the shipped profile may rewrite that store's proposals from here, so the
 * loop reports the recommended instruction and leaves the choice with the
 * optimizer that consumes it. The rung is acted on exactly when the store
 * recommends one; the loop's log reports it `unactionable` while the store is
 * unmounted or holds no instruction for the class.
 *
 * The two remaining rungs each name a switch no store accepts today, so they
 * report `unactionable` rather than have this loop invent a policy:
 *
 * - `newEvaluators` would need **`evolution-evaluator-strategy`** to accept a
 *   proposed evaluator set for a task class; it records verdict/ground-truth
 *   pairs and ranks what it observed, and mounting a new evaluator is the
 *   scorer's decision.
 * - `newModel` would need **`evolution-model-routes`** to accept a pinned
 *   switch of the role's route. A configured route is not a model switch —
 *   §32 asks for a different model, and approximating it with the route table
 *   would report a switch nothing made — so this rung stays unactionable until
 *   that store accepts one.
 *
 * Normal exploitation is not a recovery step at all.
 * @param strategy - the strategy the stagnation detector recommends.
 * @returns the step this actuator performs for that rung.
 */
export function recoveryStep(strategy: StagnationStrategy): RecoveryStep {
  if (strategy === 'diversity') return 'diversify'
  if (strategy === 'newOperators') return 'operators'
  if (strategy === 'newTasks') return 'propose'
  return 'unactionable'
}
