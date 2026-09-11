/**
 * The summary read this type performs, bound to the Client Remote.
 *
 * The ledger is Host-owned cross-session state, so the tab reads it through
 * the generated `usageDashboard` namespace: one range in, one summary out.
 * The per-session header beside it reads the current session's projections
 * instead — no Remote involved.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-usage-dashboard/remote'
import type { UsageRange, UsageSummary } from '@deepseek-ai/dsh-usage-ledger/types'

/** The slice of the Client Remote this package calls. */
export interface UsageDashboardReadRemote {
  readonly usageDashboard: {
    /**
     * Summarize billed usage for one filter range.
     * @param range - the requested window.
     * @param signal - cancels the call.
     * @returns the summary, or the failure the Host declares.
     */
    summary(range: UsageRange, signal?: AbortSignal): Promise<RemoteResult<UsageSummary>>
  }
}

/**
 * The summary fetch one tab performs, injected so the face stays host-free.
 * A Remote call does not reject: the result carries the failure.
 */
export type FetchUsageSummary = (
  range: UsageRange,
  signal: AbortSignal,
) => Promise<RemoteResult<UsageSummary>>

/**
 * Bind the summary read to one Remote face.
 * @param remote - the Client Remote carrying the `usageDashboard` namespace.
 * @returns the fetch the face performs.
 */
export function createFetchSummary(remote: UsageDashboardReadRemote): FetchUsageSummary {
  return (range, signal) => remote.usageDashboard.summary(range, signal)
}
