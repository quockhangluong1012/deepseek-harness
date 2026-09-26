/**
 * Merge matched hooks into one most-restrictive outcome. Permission precedence
 * is `deny > ask > allow`; the first `continue:false` stop is sticky; reasons
 * for the winning rank are joined; and context and system messages accumulate
 * in hook order.
 * @module @deepseek-ai/dsh-hook-protocol/merge
 */

import type { HookContribution } from './contribution.ts'
import { classifyHookOutput } from './contribution.ts'
import type { HookOutput, HookRequestPatch } from './types.ts'

/** The single decision a hook point resolves to after merging all matched hooks. */
export type MergedDecision = 'allow' | 'ask' | 'deny' | 'none'

/** The folded outcome of every hook that matched one point. */
export interface MergedHookOutcome {
  /**
   * The most-restrictive permission decision across all hooks (`deny` > `ask` >
   * `allow`), or `none` when no hook expressed one. `block`/`deny` both fold to
   * `deny`; `approve`/`allow` both fold to `allow`.
   */
  decision: MergedDecision
  /** Joined (`\n\n`) reasons from every blocking/denying hook, or `undefined`. */
  reason?: string
  /** `true` when any hook asked to halt (`continue:false`). */
  stop: boolean
  /** The first halting hook's `stopReason`, when one halted. */
  stopReason?: string
  /**
   * The merged {@link HookOutput.requestPatch} of every hook that named one, in
   * hook order: a later hook's field replaces an earlier hook's for the same
   * key, so the last hook to speak wins per field. `undefined` when no hook
   * asked for a change.
   */
  requestPatch?: HookRequestPatch
  /**
   * The intersection of every hook's {@link HookOutput.allowTools}, in hook
   * order. A hook that names no allow-list does not constrain the set, and a
   * hook can only narrow: the result never contains a name no hook allowed, and
   * `undefined` means no hook narrowed at all.
   */
  allowTools?: string[]
  /**
   * Every hook's `additionalContext`, in hook order (no joining — the bridge
   * decides). This is untrusted external data: it may reach the next request as
   * context, never as policy.
   */
  additionalContext: string[]
  /** Every hook's `systemMessage`, in hook order. */
  systemMessages: string[]
  /**
   * One {@link HookContribution} per matched hook, in hook order — what each
   * hook contributed, so a policy owner sees who vetoed, who asked, and who
   * only injected context. No kind grants a capability.
   */
  contributions: HookContribution[]
}

/** Rank a single hook's decision for the deny>ask>allow precedence (higher = stricter). */
function rank(decision: HookOutput['decision']): number {
  switch (decision) {
    case 'deny': case 'block': return 3
    case 'ask': return 2
    case 'approve': case 'allow': return 1
    default: return 0 // no decision
  }
}

/** Collapse a ranked decision back to the merged enum. */
function decisionForRank(maxRank: number): MergedDecision {
  switch (maxRank) {
    case 3: return 'deny'
    case 2: return 'ask'
    case 1: return 'allow'
    default: return 'none'
  }
}

/**
 * Fold `outputs` (the results of every hook that matched a point, in hook order)
 * into one {@link MergedHookOutcome} by the precedence rules above. An empty list
 * yields a neutral outcome (`decision: 'none'`, no stop, empty context) — the
 * caller treats that as "no hook had anything to say".
 * @param outputs - every matched hook's decoded output, in hook order.
 * @returns the single folded outcome the bridge maps onto its extension point.
 */
export function mergeHookOutputs(outputs: HookOutput[]): MergedHookOutcome {
  let maxRank = 0
  // Keep reasons per rank so only objections explaining the winning decision surface.
  const reasonsByRank = new Map<number, string[]>()
  let stop = false
  let stopReason: string | undefined
  const additionalContext: string[] = []
  const systemMessages: string[] = []
  const contributions: HookContribution[] = []
  let requestPatch: HookRequestPatch | undefined
  let allowTools: string[] | undefined

  for (const out of outputs) {
    contributions.push({ index: contributions.length, kind: classifyHookOutput(out) })
    const r = rank(out.decision)
    if (r > maxRank) maxRank = r
    if ((r === 3 || r === 2) && out.reason !== undefined && out.reason.length > 0) {
      const list = reasonsByRank.get(r) ?? []
      list.push(out.reason)
      reasonsByRank.set(r, list)
    }
    if (out.continue === false && !stop) {
      stop = true
      if (out.stopReason !== undefined) stopReason = out.stopReason
    }
    if (out.additionalContext !== undefined && out.additionalContext.length > 0) {
      additionalContext.push(out.additionalContext)
    }
    if (out.systemMessage !== undefined && out.systemMessage.length > 0) {
      systemMessages.push(out.systemMessage)
    }
    if (out.requestPatch !== undefined) requestPatch = { ...requestPatch, ...out.requestPatch }
    if (out.allowTools !== undefined) {
      const allowed = out.allowTools
      allowTools = allowTools === undefined ? [...allowed] : allowTools.filter(name => allowed.includes(name))
    }
  }

  const reasons = reasonsByRank.get(maxRank) ?? []
  return {
    decision: decisionForRank(maxRank),
    ...reasons.length > 0 ? { reason: reasons.join('\n\n') } : {},
    stop,
    ...stopReason !== undefined ? { stopReason } : {},
    ...requestPatch !== undefined ? { requestPatch } : {},
    ...allowTools !== undefined ? { allowTools } : {},
    additionalContext,
    systemMessages,
    contributions,
  }
}
