/**
 * Run-level halt for a hook that asked to stop the run (`{"continue": false}`).
 * Both bridges fold the request into {@link MergedHookOutcome.stop}; this module
 * turns it into the one durable, reconstructable halt both apply.
 * @module @deepseek-ai/dsh-hook-protocol/halt
 */

import type { AgentCancelCause } from '@deepseek-ai/dsh-session'
import type { MergedHookOutcome } from './merge.ts'

/** The live run a halt acts on — an agent accepts the `hook` cancellation cause. */
export interface HaltableRun {
  /** Abort the run's live activity, recording `cause` as why it stopped. */
  cancel(cause: AgentCancelCause): void
}

/**
 * Apply a hook point's folded halt request. The run is cancelled with the
 * `hook` cause, so the loop's own abort path writes the durable `turn/end`
 * reason `{ kind: 'aborted', reason: { kind: 'hook', reason } }` and the halt is
 * reconstructable from the log next to the `hook/result` that asked for it. The
 * hook's `stopReason` names the reason when it gave one; otherwise the reason
 * names the hook point.
 *
 * A point with no live run (a detached lifecycle point) cannot halt: the
 * request is reported through `warn` and only the `hook/result` record remains.
 *
 * @param merged - the folded outcome of the point's matched hooks.
 * @param point - the hook point that asked, used in the fallback reason and the warning.
 * @param run - the live run to halt, or `undefined` at a point without one.
 * @param warn - sink for the cannot-halt diagnostic.
 * @returns `true` only when the halt was applied to a live run.
 */
export function applyRunHalt(
  merged: MergedHookOutcome,
  point: string,
  run: HaltableRun | undefined,
  warn: (message: string) => void,
): boolean {
  if (!merged.stop) return false
  if (run === undefined) {
    warn(`hook point ${point} asked to halt the run, but no live run exists there; the request is only recorded`)
    return false
  }
  run.cancel({ kind: 'hook', reason: merged.stopReason ?? `${point} hook halted the run` })
  return true
}
