/**
 * Host face of the evolution journey page: the `evolutionCurator` Remote
 * namespace over the mounted curator's recorded passes. The page's Scope verbs
 * live on the Host `ctx.evolutionController` (`evolution` namespace); this face
 * exists because a browser cannot read a Host Cordis service, and the curator
 * card reads the passes a curator actually recorded rather than assuming one.
 * @module @deepseek-ai/dsh-client-ui-evolution
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-evolution-curator'
import type { EvolutionCuratorStatus } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `evolutionCurator` Remote namespace. */
    evolutionCuratorStatus: EvolutionCuratorStatusController
  }
}

/**
 * Host Remote face over the mounted curator's ledger summary.
 * @param ctx - Host context carrying the optional curator.
 */
export class EvolutionCuratorStatusController extends TypertRemoteService {
  static inject = ['typert']

  /**
   * @param ctx - Host context carrying the optional curator.
   */
  constructor(ctx: Context) {
    super(ctx, 'evolutionCuratorStatus', { namespace: 'evolutionCurator' })
  }

  /**
   * Read the curator's recorded status. An unmounted curator is reported as
   * such — never as a pass that never ran.
   * @returns the mounted flag, newest pass instant, and recorded passes.
   */
  @Remote('status')
  async status(): Promise<EvolutionCuratorStatus> {
    const curator = this.ctx.get('evolutionCurator')
    if (curator === undefined) return { mounted: false, lastRunAt: null, passes: [] }
    return { mounted: true, lastRunAt: curator.lastRunAt(), passes: await curator.passes() }
  }
}

export default EvolutionCuratorStatusController
