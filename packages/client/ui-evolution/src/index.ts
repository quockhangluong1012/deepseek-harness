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
import type {} from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type {} from '@deepseek-ai/dsh-usage-ledger'
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
   * Read the curator's recorded status plus the two dashboard rates: today's
   * cache-hit share from the usage ledger and the aggregate skill failure
   * rate from telemetry. Either rate is null when its source is unmounted or
   * holds no loads. An unmounted curator is reported as such — never as a
   * pass that never ran.
   * @returns the mounted flag, newest pass instant, recorded passes, and rates.
   */
  @Remote('status')
  async status(): Promise<EvolutionCuratorStatus> {
    const none = { mounted: false as const, lastRunAt: null, passes: [] as const, cacheHitRate: null, skillFailureRate: null }
    const curator = this.ctx.get('evolutionCurator')
    if (curator === undefined) return none
    const ledger = this.ctx.get('usageLedger')
    // The face owns no caller cancellation; the ledger read is an in-memory
    // fold, so it runs under a signal that never aborts.
    const today = ledger === undefined ? undefined : await ledger.summary('today', new AbortController().signal)
    const entries = this.ctx.get('evolutionSkillTelemetry')?.entries() ?? []
    const loads = entries.reduce((sum, entry) => sum + entry.usage.useCount + (entry.usage.failureCount ?? 0), 0)
    const failures = entries.reduce((sum, entry) => sum + (entry.usage.failureCount ?? 0), 0)
    return {
      mounted: true as const,
      lastRunAt: curator.lastRunAt(),
      passes: await curator.passes(),
      cacheHitRate: today === undefined ? null : today.totals.cacheHitAvg,
      skillFailureRate: loads === 0 ? null : failures / loads,
    }
  }
}

export default EvolutionCuratorStatusController
