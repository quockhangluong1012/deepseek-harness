/**
 * The usage-dashboard domain declaration: one `ledger` table holding the
 * single aggregate state document under the `state` key. The whole ledger —
 * per-day counters, per-day-per-model counters, and per-session fold cursors
 * — is one atomic document, so a crash can never persist counters without
 * their cursor (which would double-count on the next backfill) or a cursor
 * without its counters (which would under-count).
 *
 * The state is disposable derived data: every counter refolds from the
 * durable session logs, so a schema failure backs the document aside and
 * starts empty rather than failing the boot.
 * @module @deepseek-ai/dsh-usage-ledger/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Non-negative safe-integer count at the durable boundary. */
const count = z.number().int().nonnegative()

/** Counters for one calendar day. */
export const usageDayAggregate = z.object({
  requests: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
})

/** One day's counters for one provider/model route. */
export type UsageDayAggregate = z.infer<typeof usageDayAggregate>

/** Counters for one provider/model route on one calendar day. */
export const usageModelAggregate = z.object({
  provider: z.string(),
  model: z.string(),
  requests: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
})

/** One route's counters on one day, inferred from {@link usageModelAggregate}. */
export type UsageModelAggregate = z.infer<typeof usageModelAggregate>

/**
 * The complete ledger state: per-day counters keyed by `YYYY-MM-DD`
 * (UTC+7), per-day-per-model counters keyed by
 * `` `${day}\u0000${provider}\u0000${model}` ``, and the highest folded event
 * sequence per live session id.
 */
export const usageLedgerState = z.object({
  cursors: z.record(z.string(), count),
  daily: z.record(z.string(), usageDayAggregate),
  models: z.record(z.string(), usageModelAggregate),
})

/** The ledger state, inferred from {@link usageLedgerState}. */
export type UsageLedgerState = z.infer<typeof usageLedgerState>

/** The single ledger-table key holding the whole state document. */
export const LEDGER_KEY = 'state'

/** Empty ledger state: no cursors, no counters. */
export const EMPTY_LEDGER: UsageLedgerState = { cursors: {}, daily: {}, models: {} }

/**
 * The usage-dashboard domain spec. `single` layout is irrelevant at one
 * record; what matters is the one atomic document. `backup-and-skip` keeps
 * a corrupt ledger from failing the boot: the document moves aside and the
 * next backfill rebuilds it from the session logs.
 */
export const usageDashboardDomainSpec = defineDomain({
  name: 'usage_dashboard',
  version: 1,
  invalidRecords: 'backup-and-skip',
  layout: 'single',
  tables: { ledger: domainTable<string, UsageLedgerState>(usageLedgerState) },
})
