/**
 * Mutation-strategy evolution (§9): the instruction line one operator and
 * artifact class currently holds as a proposal, the evidence recorded for and
 * against it, and the bounded nudge those verdicts contribute to the
 * operator's ranking. Nothing here rewrites an optimizer's instructions — the
 * optimizer keeps the strings it ships, and this is the record a deployment
 * reads when it decides whether to change them.
 * @module @deepseek-ai/dsh-evolution-operators/src/instructions
 */

import type { InstructionInput, InstructionVerdict, OperatorInstruction } from './types.ts'

/**
 * Fold one proposed instruction into what an operator and artifact class
 * holds. The proposal's identity is the pair, so re-proposing the same text
 * keeps the verdicts it already earned and only counts another proposal, while
 * a different text starts its tally over: evidence belongs to the text it
 * judged.
 * @param current - the row the pair holds, or undefined for the first proposal.
 * @param input - the proposed instruction and why it was proposed.
 * @param at - ISO-8601 instant of the proposal.
 * @returns the row after the proposal.
 */
export function proposedInstruction(
  current: OperatorInstruction | undefined,
  input: InstructionInput,
  at: string,
): OperatorInstruction {
  const replaced = current !== undefined && current.instruction !== input.instruction
  return {
    operator: input.operator,
    artifactClass: input.artifactClass,
    instruction: input.instruction,
    reason: input.reason,
    proposals: (current?.proposals ?? 0) + 1,
    accepted: replaced ? 0 : current?.accepted ?? 0,
    rejected: replaced ? 0 : current?.rejected ?? 0,
    lastVerdict: replaced ? null : current?.lastVerdict ?? null,
    at,
    decidedAt: replaced ? null : current?.decidedAt ?? null,
  }
}

/**
 * Fold one verdict into the instruction its operator and artifact class
 * currently holds.
 * @param current - the row the pair holds.
 * @param verdict - the verdict and why it landed that way.
 * @param at - ISO-8601 instant of the verdict.
 * @returns the row after the verdict.
 */
export function judgedInstruction(
  current: OperatorInstruction,
  verdict: InstructionVerdict,
  at: string,
): OperatorInstruction {
  return {
    ...current,
    accepted: current.accepted + (verdict.accepted ? 1 : 0),
    rejected: current.rejected + (verdict.accepted ? 0 : 1),
    lastVerdict: verdict.reason,
    decidedAt: at,
  }
}

/**
 * The bounded nudge one operator's instruction evidence contributes to its
 * ranking: the share of verdicts that accepted the current instruction, scaled
 * by the deployment's weight. An operator with no recorded instruction, or one
 * whose instruction was proposed but never judged, is nudged by nothing — a
 * proposal is a hypothesis until evidence decides it.
 * @param current - the instruction row for the operator and class, if any.
 * @param weight - the adjustment weight (0 to 1).
 * @returns the adjustment, positive when accepted, negative when rejected.
 */
export function instructionAdjustment(current: OperatorInstruction | undefined, weight: number): number {
  if (current === undefined) return 0
  const verdicts = current.accepted + current.rejected
  if (verdicts === 0) return 0
  return weight * (current.accepted - current.rejected) / verdicts
}
