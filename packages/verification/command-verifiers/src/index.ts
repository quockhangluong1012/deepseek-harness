/**
 * Command-backed criterion verifiers for the agent kernel's completion gate.
 *
 * The kernel owns the gate and registers no criterion verifier of its own, so a
 * task whose acceptance criteria name a `test`, `build`, `assertion`, or `diff`
 * family records `unknown` and never completes. This plugin supplies those
 * answers from what the deployment declares: one shell command per criterion id
 * or verifier family, run through the `ctx.shell` executor in force, a scope
 * check for `diff` criteria, and a change-contract check for the criteria a
 * deployment holds to the boundary their task declared. It decides nothing
 * itself — a criterion it was not configured for stays unresolved, and the
 * kernel's own decision, not this plugin's, allows completion.
 *
 * @module @deepseek-ai/dsh-command-verifiers
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: activates the `ctx.agentKernel` Context declaration.
import type {} from '@deepseek-ai/dsh-agent-kernel'
// Type-only: activates the `ctx.shell` Context declaration.
import type {} from '@deepseek-ai/dsh-shell'
import { resolveTargets } from './targets.ts'
import { CommandCriterionVerifier } from './verifier.ts'
import type { VerifierEntry } from './types.ts'

export { VERIFIER_ID } from './verifier.ts'
export { CommandCriterionVerifier } from './verifier.ts'
export { resolveTargets, withinExpectedPaths } from './targets.ts'
export { compareChangeContract, type ContractComparison, type ContractViolation } from './contract.ts'
export type { ResolvedCommandTarget, ResolvedContractTarget, ResolvedScopeTarget, ResolvedTarget, VerifierEntry } from './types.ts'

/** Deployment configuration for the command-backed criterion verifiers. */
export interface Config {
  /**
   * Targets keyed by acceptance criterion id or verifier family. A criterion is
   * claimed by its own id first, else by its family, so one family entry covers
   * every criterion that names no target of its own. The configuration schema
   * materializes one, so the map is mutable here.
   */
  verifiers?: Record<string, VerifierEntry>
}

/** Plugin name used by loader diagnostics. */
export const name = 'command-verifiers'

/** Required service: the kernel owns the criterion-verifier registry this plugin contributes to. */
export const inject = ['agentKernel']

/** Runtime configuration schema for the command-backed criterion verifiers. */
export const Config: z<Config> = z.object({
  verifiers: z.dict(z.object({
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    timeoutMs: z.number(),
    expectedExitCodes: z.array(z.number()),
    expectedPaths: z.array(z.string()),
    contract: z.boolean(),
  })),
})

/**
 * Register one verifier over the resolved targets. Registration is an effect,
 * so unloading this plugin removes exactly the verifier it added.
 * @param ctx - the mounting composition's scope context.
 * @param config - the validated configuration; an unusable target fails the load.
 * @throws When the configuration declares no target, or one that could never
 * decide a criterion.
 */
export function apply(ctx: Context, config: Config): void {
  const verifier = new CommandCriterionVerifier(ctx, resolveTargets(config))
  ctx.effect(() => ctx.agentKernel.verifiers.register(verifier), 'command-verifiers.registration')
}
