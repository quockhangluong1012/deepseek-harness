/**
 * Evaluator disagreement: what the behavior gates said about one candidate,
 * reduced to who approved and who dissented. The gates measure different
 * things — a committable body, correct routing, no replay regression — so a
 * split verdict is evidence about the evaluators, not just the candidate:
 * persistent disagreement across revisions marks the candidate (and its
 * evaluation) as worth investigating rather than promoting or rejecting on
 * one channel's word. Pure, so specs drive it without spawning anything.
 * @module @deepseek-ai/dsh-evolution-scorer/disagreement
 */

import type { ChannelVerdict, DisagreementChannel, EvaluatorDisagreement } from './types.ts'

/** Canonical channel order: cheapest gate first, replay evidence last. */
const CHANNEL_ORDER: readonly DisagreementChannel[] = ['contract', 'routing', 'replay']

/**
 * Reduce channel verdicts to their disagreement: which channels approved,
 * which dissented, and whether they speak with one voice. A lone channel
 * cannot disagree with itself; zero channels is a caller bug, not a verdict.
 * @param channels - one verdict per evaluating channel.
 * @returns the approving and dissenting channels in canonical order, with unanimity.
 */
export function evaluatorDisagreement(channels: readonly ChannelVerdict[]): EvaluatorDisagreement {
  if (channels.length === 0) throw new Error('evaluator disagreement needs at least one channel verdict')
  const rank = new Map<DisagreementChannel, number>(CHANNEL_ORDER.map((channel, index) => [channel, index]))
  const ordered = [...channels].sort((left, right) =>
    (rank.get(left.channel) ?? CHANNEL_ORDER.length) - (rank.get(right.channel) ?? CHANNEL_ORDER.length))
  const approving = ordered.filter(entry => entry.ok).map(entry => entry.channel)
  const dissenting = ordered.filter(entry => !entry.ok).map(entry => entry.channel)
  return { unanimous: dissenting.length === 0 || approving.length === 0, approving, dissenting }
}
