/**
 * Host face of the usage dashboard (`ctx.usageDashboard`): the `summary`
 * Remote over the ledger's durable counters. The fold and the persistence
 * live in `@deepseek-ai/dsh-usage-ledger` behind `ctx.usageLedger`; this
 * dual-face package only contributes the namespace, so its Host entry holds
 * no storage or fold imports of its own.
 * @module @deepseek-ai/dsh-client-ui-usage-dashboard
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-usage-ledger'
import type { UsageRange, UsageSummary } from '@deepseek-ai/dsh-usage-ledger/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `usageDashboard` Remote namespace. */
    usageDashboard: UsageDashboard
  }
}

/**
 * Host Remote service delegating dashboard summaries to the ledger.
 * @param ctx - Host context carrying the ledger and Typert.
 */
export class UsageDashboard extends TypertRemoteService {
  static inject = ['usageLedger', 'typert']

  /**
   * @param ctx - Host context carrying the ledger and Typert.
   */
  constructor(ctx: Context) {
    super(ctx, 'usageDashboard')
  }

  /**
   * Dashboard summary for one filter range, served from the ledger.
   * @param range - the requested window (`today` by dashboard default).
   * @param signal - caller cancellation.
   * @returns totals, per-day buckets, and the per-model table.
   */
  @Remote('summary')
  summary(range: UsageRange, signal: AbortSignal): Promise<UsageSummary> {
    return this.ctx.usageLedger.summary(range, signal)
  }
}

export default UsageDashboard
