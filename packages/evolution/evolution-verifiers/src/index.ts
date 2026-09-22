/**
 * Verifier-first candidate admission (`ctx.evolutionVerifiers`): one ladder
 * over a candidate skill body, cheapest rung first, stopping at the first rung
 * that refuses. Levels 0 and 1 are deterministic and always available; levels 2
 * to 4 are seams the caller mounts, and an unmounted seam abstains rather than
 * passing. Nothing here calls a model by itself.
 * @module @deepseek-ai/dsh-evolution-verifiers
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { runVerifierLadder } from './ladder.ts'
import type { VerifierRequest, VerifierVerdict } from './types.ts'

export type * from './types.ts'
export { runVerifierLadder, VERIFIER_LEVEL_NAMES, verifyDeterministic, verifySchema } from './ladder.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The verifier-first ladder over candidate skill bodies. */
    evolutionVerifiers: EvolutionVerifiers
  }
}

/**
 * The ladder, mounted so a host and the packages that admit candidates share
 * one admission rule.
 */
export class EvolutionVerifiers extends Service {
  /**
   * @param ctx - host context.
   */
  constructor(ctx: Context) {
    super(ctx, 'evolutionVerifiers')
  }

  /**
   * Run the ladder over one candidate.
   * @param request - candidate body plus the seams the host mounts for the simulated, evaluator, and human rungs.
   * @returns the verdict, naming every consulted rung and the level that decided.
   */
  async verify(request: VerifierRequest): Promise<VerifierVerdict> {
    return await runVerifierLadder(request)
  }
}

export default EvolutionVerifiers
