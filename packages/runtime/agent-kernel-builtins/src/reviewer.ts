/**
 * The independent reviewer the agent kernel's §10.5 REVIEW phase spawns: the
 * adapter from this product's shipped reviewer seam (`dsh-command-review`) to
 * the kernel's `IndependentReviewer` port (§10.6). One spawn path serves the
 * `/review` command, the `/security-review` command, and the lifecycle, so the
 * reviewer runs in a fresh context under its own provider and model and its
 * structured report reaches both callers.
 *
 * The port is what the kernel consumes; this module is the product's wiring of
 * it, and a deployment that wants a different backend registers its own
 * reviewer instead of mounting this one.
 *
 * @module @deepseek-ai/dsh-agent-kernel-builtins/reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import { REVIEW_OUTPUT_SCHEMA, reviewPrompt, runReviewer } from '@deepseek-ai/dsh-command-review'
import type { ReviewerConfig, ReviewReport } from '@deepseek-ai/dsh-command-review'
import type { CodeReviewReport, IndependentReviewer } from '@deepseek-ai/dsh-agent-kernel'

/**
 * Register the coding lifecycle's independent reviewer over the shipped
 * reviewer seam. The reviewer runs as a fresh child of the task's agent and its
 * report is consumed as the REVIEW phase's structured result.
 * @param ctx - the mounting composition's scope context.
 * @param config - delegation backend and route overrides for the reviewer child; defaults review on the caller's own route.
 * @returns a disposer that removes this reviewer while it remains registered.
 * @throws When the kernel already has a reviewer registered.
 */
export function registerCodingReviewer(ctx: Context, config: ReviewerConfig = {}): () => void {
  const reviewer: IndependentReviewer = {
    review: async (request): Promise<CodeReviewReport> => {
      const result = await runReviewer(ctx, config, {
        label: 'lifecycle-review',
        prompt: `${reviewPrompt('code', request.ref)}\n\nThe change was supposed to accomplish: ${request.objective}`,
        outputSchema: REVIEW_OUTPUT_SCHEMA,
      }, { parent: request.agent, signal: request.signal })
      if (result.stopReason !== 'completed') {
        const detail = result.diagnostic === undefined ? '' : ` — ${result.diagnostic}`
        throw new Error(`the independent reviewer did not finish (${result.stopReason})${detail}`)
      }
      const report = result.structured as ReviewReport | undefined
      if (report === undefined) {
        throw new Error('the independent reviewer finished without returning a structured report')
      }
      return report
    },
  }
  return ctx.agentKernel.lifecycle.registerReviewer(reviewer)
}
