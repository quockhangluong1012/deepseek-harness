/**
 * The dashboard's own state: the selected filter range per tab plus the
 * fetched Host summary for that range. Summaries are keyed by range, so
 * switching back to a visited range shows its settled snapshot while a
 * refetch runs. Buckets live as long as their tab record.
 */
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { UsageRange, UsageSummary } from '@deepseek-ai/dsh-usage-ledger/types'

/** The filter the dashboard selects before any explicit choice. */
export const DEFAULT_USAGE_RANGE: UsageRange = 'today'

/** One tab's filter selection and fetched summaries. */
export interface UsageTabState {
  /** The range the reader selected; the dashboard default before any choice. */
  range: UsageRange
  /** Settled summaries by range. */
  summaries: Partial<Record<UsageRange, UsageSummary>>
  /** A summary fetch is in flight for the selected range. */
  loading: boolean
  /** Why the last fetch failed; cleared by the next fetch. */
  failure: RemoteFailure | undefined
}

/** Every tab's state, keyed by tab id. */
export interface UsageState {
  byTab: Record<TabId, UsageTabState>
}

/**
 * A tab's state before it selects or reads anything.
 * @returns the empty bucket at the default range.
 */
export function fresh(): UsageTabState {
  return { range: DEFAULT_USAGE_RANGE, summaries: {}, loading: false, failure: undefined }
}

/** The bucket for one tab, created on first write. */
function bucket(state: UsageState, tabId: TabId): UsageTabState {
  return state.byTab[tabId] ??= fresh()
}

/** The dashboard store's write set; every action names the tab it writes. */
type UsageActions = {
  selectRange: (draft: UsageState, tabId: TabId, range: UsageRange) => void
  loading: (draft: UsageState, tabId: TabId) => void
  loaded: (draft: UsageState, tabId: TabId, summary: UsageSummary) => void
  failed: (draft: UsageState, tabId: TabId, failure: RemoteFailure) => void
  forget: (draft: UsageState, tabId: TabId) => void
}

/**
 * Declare the dashboard's store.
 *
 * Constructed once in apply and shared by the body registration, which the
 * slot runtime allows because both are session-scoped.
 * @returns the store handle to declare on the registration.
 */
export function createUsageDashboardStore(): EngineStoreHandle<UsageState, UsageActions> {
  return defineStore({
    init: (): UsageState => ({ byTab: {} }),
    actions: {
      /**
       * Select one filter range. A settled summary for the range stays, so
       * the body shows it while the refetch runs.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param range - the newly selected range.
       */
      selectRange: (d, tabId: TabId, range: UsageRange) => {
        bucket(d, tabId).range = range
      },
      /**
       * Mark a summary fetch as in flight for the tab's selected range.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       */
      loading: (d, tabId: TabId) => {
        bucket(d, tabId).loading = true
      },
      /**
       * Keep one fetched summary under its range and clear the failure.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param summary - the Host summary for its range.
       */
      loaded: (d, tabId: TabId, summary: UsageSummary) => {
        const state = bucket(d, tabId)
        state.summaries[summary.range] = summary
        state.loading = false
        state.failure = undefined
      },
      /**
       * Record why a summary fetch failed; settled summaries stay.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param failure - the settled Remote failure.
       */
      failed: (d, tabId: TabId, failure: RemoteFailure) => {
        const state = bucket(d, tabId)
        state.loading = false
        state.failure = failure
      },
      /**
       * Drop one tab's state, for a tab record that is gone.
       * @param d - draft state.
       * @param tabId - the tab that went away.
       */
      forget: (d, tabId: TabId) => {
        const byTab: UsageState['byTab'] = {}
        // Keys were written from tab ids; reading them back as ids is exact.
        for (const [id, state] of Object.entries(d.byTab) as [TabId, UsageTabState][]) {
          if (id !== tabId) byTab[id] = state
        }
        d.byTab = byTab
      },
    },
  })
}

/** The store handle type the registration declares. */
export type UsageStore = ReturnType<typeof createUsageDashboardStore>
