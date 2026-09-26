/**
 * Agent-backed acceptance-criterion verifiers for the agent kernel's completion
 * gate.
 *
 * Three §8.1 families cannot be decided by one shell command: `security` (does
 * the change introduce an exploitable defect?), `browser` (does the scenario
 * still work?), and `review` (does an independent reviewer see a defect?). Each
 * is decided here by one independent subagent — a fresh context and, where
 * configured, a different route — that reports a structured verdict this
 * package consumes as the criterion's result. Every family starts its reviewer
 * through `runReviewer` from `@deepseek-ai/dsh-command-review`, so `/review`,
 * `/security-review`, the kernel's lifecycle reviewer, and these verifiers
 * share one spawn path and one report contract instead of each starting
 * children its own way.
 *
 * A criterion of another family, an agentless verification, or a deployment
 * whose subagent provider cannot start the reviewer resolves to `fail` with the
 * reason recorded: a verifier claims a criterion only to answer it.
 *
 * @module @deepseek-ai/dsh-agent-verifiers
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ReviewSeverity } from '@deepseek-ai/dsh-command-review'
// Type-only: activates the `ctx.agentKernel` Context declaration.
import type {} from '@deepseek-ai/dsh-agent-kernel'
// Type-only: activates the `ctx.agents` and `ctx.subagents` Context declarations.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import { AgentCriterionVerifier } from './verifier.ts'

export { SUPPORTED_FAMILIES, isAgentVerifierFamily } from './families.ts'
export { AgentCriterionVerifier, VERIFIER_ID } from './verifier.ts'
export type { AgentVerifierFamily, ScenarioReport } from './types.ts'

/** Deployment configuration for the agent-backed criterion verifiers. */
export interface Config {
  /**
   * `ctx.subagents` provider name every reviewer starts through. Defaults to
   * `spawn`, a fresh context with no parent history.
   */
  subagentProvider?: string
  /** Provider route override for the reviewer child; omitted inherits the parent's route. */
  provider?: string
  /** Model id override for the reviewer child; omitted inherits the parent's model. */
  model?: string
  /**
   * Lowest finding severity that fails a `security` or `review` criterion: a
   * report whose worst finding is below it passes. Defaults to `high`.
   */
  minSeverity?: ReviewSeverity
  /**
   * Ref the reviewer diffs the working tree against. Defaults to `HEAD`, whose
   * diff is the uncommitted change set.
   */
  reviewRef?: string
}

/** Plugin name used by loader diagnostics. */
export const name = 'agent-verifiers'

/**
 * Required services: the kernel owns the registry this plugin contributes to,
 * `agents` supplies the Agent a reviewer starts from, and `subagents` starts it.
 */
export const inject = ['agentKernel', 'agents', 'subagents']

/** Runtime configuration schema for the agent-backed criterion verifiers. */
export const Config: z<Config> = z.object({
  subagentProvider: z.string().min(1).default('spawn'),
  provider: z.string(),
  model: z.string(),
  minSeverity: z.union(['high', 'medium', 'low'] as const).default('high'),
  reviewRef: z.string().default('HEAD'),
})

/**
 * Register one verifier over the mounted subagent service. Registration is an
 * effect, so unloading this plugin removes exactly the verifier it added.
 * @param ctx - the mounting composition's scope context.
 * @param config - the validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const verifier = new AgentCriterionVerifier(ctx, config)
  ctx.effect(() => ctx.agentKernel.verifiers.register(verifier), 'agent-verifiers.registration')
}
