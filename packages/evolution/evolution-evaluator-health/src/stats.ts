/**
 * Pure evaluator-health aggregation over recorded verdicts: per-channel
 * approval, unanimous agreement, approval-rate drift against the newest
 * window, false-positive and false-negative tracking (either verdict kind later
 * contradicted by a same-skill verdict of the opposite kind), and the
 * agreement with the independent ground truths that later judged the verdicts.
 * @module @deepseek-ai/dsh-evolution-evaluator-health/src/stats
 */

import type { ChannelHealthRow, EvaluatorHealthSummary, EvaluatorRun, JudgeCalibration } from './types.ts'

/** The canonical channel set driving the per-channel rows. */
const CHANNEL_ORDER: readonly string[] = ['contract', 'routing', 'replay']

/**
 * Aggregate recorded verdicts into evaluator-health facts. Verdicts are
 * consumed newest-first; the newest `window` verdicts form the recent slice.
 * @param runs - verdicts, newest first.
 * @param window - verdicts the recent slice covers.
 * @returns the aggregated health.
 */
export function summarizeHealth(runs: readonly EvaluatorRun[], window: number): EvaluatorHealthSummary {
  if (runs.length === 0) {
    return {
      runs: 0,
      unanimousRate: 0,
      approvalRate: 0,
      recentApprovalRate: 0,
      drift: 0,
      falsePositiveRate: 0,
      channels: CHANNEL_ORDER.map(channel => ({ channel, runs: 0, approved: 0, approvalRate: 0 })),
    }
  }
  const approved = runs.filter(run => run.approved)
  const unanimous = runs.filter(run => run.unanimous).length
  const recent = runs.slice(0, window)
  const recentApproved = recent.filter(run => run.approved).length
  const approvalRate = approved.length / runs.length
  const recentApprovalRate = recentApproved / recent.length
  const falsePositives = approved.filter(approvedRun => laterRejection(runs, approvedRun)).length
  return {
    runs: runs.length,
    unanimousRate: unanimous / runs.length,
    approvalRate,
    recentApprovalRate,
    drift: recentApprovalRate - approvalRate,
    falsePositiveRate: approved.length === 0 ? 0 : falsePositives / approved.length,
    channels: channelHealth(runs),
  }
}

/**
 * One channel's aggregated approval over the verdicts it participated in.
 * @param runs - the recorded verdicts to aggregate.
 * @returns one row per evaluation channel.
 */
export function channelHealth(runs: readonly EvaluatorRun[]): ChannelHealthRow[] {
  return CHANNEL_ORDER.map((channel) => {
    const rows = runs.filter(run => run.approving.includes(channel) || run.dissenting.includes(channel))
    const approved = rows.filter(run => run.approving.includes(channel)).length
    return { channel, runs: rows.length, approved, approvalRate: rows.length === 0 ? 0 : approved / rows.length }
  })
}

/**
 * Aggregate the calibration facts of recorded verdicts (§13): the false-negative
 * rate — the mirror of the summary's false-positive rate, a rejection later
 * contradicted by a newer same-skill approval — and the agreement with the
 * ground truths that later judged them independently.
 * @param runs - verdicts, newest first.
 * @returns the calibration facts.
 */
export function judgeCalibration(runs: readonly EvaluatorRun[]): JudgeCalibration {
  const rejected = runs.filter(run => !run.approved)
  const falseNegatives = rejected.filter(rejectedRun => laterApproval(runs, rejectedRun)).length
  const judgments = runs.flatMap(run => run.judgment?.independent === true ? [run.judgment] : [])
  return {
    falseNegativeRate: rejected.length === 0 ? 0 : falseNegatives / rejected.length,
    independentlyJudged: judgments.length,
    agreementRate: judgments.length === 0 ? 0 : judgments.filter(judgment => judgment.agrees).length / judgments.length,
  }
}

/** Whether any NEWER same-skill verdict rejected an approved one. Runs are newest-first, so newer entries have smaller indices. */
function laterRejection(runs: readonly EvaluatorRun[], approvedRun: EvaluatorRun): boolean {
  const index = runs.indexOf(approvedRun)
  return runs.slice(0, index).some(run => run.skill === approvedRun.skill && !run.approved)
}

/** Whether any NEWER same-skill verdict approved a rejected one — the mirror of {@link laterRejection}. */
function laterApproval(runs: readonly EvaluatorRun[], rejectedRun: EvaluatorRun): boolean {
  const index = runs.indexOf(rejectedRun)
  return runs.slice(0, index).some(run => run.skill === rejectedRun.skill && run.approved)
}
