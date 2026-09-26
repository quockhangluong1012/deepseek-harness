/**
 * Settlement of one ONE-SHOT subagent run into a background-Task outcome. Only
 * the one-shot background path uses Jobs; continuable children have no Task,
 * no per-message result, and no Task cancellation.
 *
 * @module @deepseek-ai/dsh-subagent/run-settlement
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { NO_FOLLOW_UP, agentResultOf, gateAgentResult } from './agent-result.ts'
import type { SubagentResult, SubagentRun } from './types.ts'

/** Flatten a child's final output blocks to the task's final text. */
function finalText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Render a failed stop reason with optional provider-authored detail. */
function failureDetail(result: SubagentResult): string {
  const stopReason = result.stopReason
  return result.diagnostic === undefined
    ? stopReason
    : `${stopReason}; diagnostic: ${result.diagnostic}`
}

/**
 * Map a child result to the task outcome: completed carries final text, local
 * cancellation (`aborted` without a diagnostic) is killed, and provider-
 * diagnosed remote aborts plus every other reason are failed without partial
 * output.
 *
 * A `completed` run still passes the result gate: a child that finished its
 * turn but reported a status the parent must not consume as success fails the
 * job with the gate's reason instead of announcing a result. This path starts
 * no follow-up run — the parent collects the outcome and decides whether to
 * delegate again.
 * @param result - child terminal result.
 * @returns outcome for the `ctx.jobs` registration.
 */
function runOutcome(result: SubagentResult): JobOutcome {
  switch (result.stopReason) {
    case 'completed': {
      const gate = gateAgentResult(agentResultOf(result), NO_FOLLOW_UP)
      return gate.kind === 'rejected'
        ? { status: 'failed', detail: gate.reason }
        : { status: 'completed', result: finalText(result.output) }
    }
    case 'aborted':
      return result.diagnostic === undefined
        ? { status: 'killed' }
        : { status: 'failed', detail: failureDetail(result) }
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return { status: 'failed', detail: failureDetail(result) }
    // Merge-extensible reasons remain failures with provider-authored detail.
    default:
      return { status: 'failed', detail: failureDetail(result) }
  }
}

/**
 * Await the child result, dispose the run, then return its task outcome. Result
 * and disposal failures become `failed`; when both fail, both details survive.
 * @param run - live run to settle and release.
 * @returns outcome after child resources are released.
 */
export async function settleRun(run: SubagentRun): Promise<JobOutcome> {
  let outcome: JobOutcome
  try {
    outcome = runOutcome(await run.result)
  } catch (error: unknown) {
    outcome = { status: 'failed', detail: String(error) }
  }
  try {
    await run.dispose()
  } catch (error: unknown) {
    const prefix = outcome.detail === undefined ? '' : `${outcome.detail}; `
    return { status: 'failed', detail: `${prefix}dispose failed: ${String(error)}` }
  }
  return outcome
}
