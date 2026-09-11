/**
 * The all-sessions dashboard's asynchronous half: fetching Host summaries
 * into the store.
 *
 * The overlay body never awaits anything. It asks for the selected range and
 * this face performs the fetch and writes the outcome through the store's
 * own actions — the Slot-standard `inject` form, so the write set stays the
 * store's. A settlement from before a range switch writes nothing: the
 * overlay's generation guards every write, and the record's end forgets the
 * bucket. The face serves the root-scoped overlay dialog, whose single
 * bucket lives under {@link DASHBOARD_OVERLAY_ID}.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { UsageRange } from '@deepseek-ai/dsh-usage-ledger/types'
import type { FetchUsageSummary } from './rpc.ts'
import type { UsageStore } from './store.ts'

/** The dashboard's injected business face, as the overlay body receives it. */
export interface UsageInjected {
  /**
   * Fetch the summary for the overlay's selected range into the store. A
   * settlement from a superseded range writes nothing.
   * @param tabId - the overlay bucket id.
   * @param range - the range to fetch.
   * @param signal - the overlay record's lifetime.
   */
  readonly loadSummary: (tabId: TabId, range: UsageRange, signal: AbortSignal) => void
}

/** What the face remembers of one bucket: the fetch generation a settlement must match. */
interface TabReads {
  generation: number
}

/**
 * Bind the dashboard's face to one summary fetch.
 * @param fetch - the bound `usageDashboard.summary` call.
 * @returns the Slot `inject` factory: bound actions in, face out.
 */
export function usageFace(fetch: FetchUsageSummary): (actions: BoundActions<UsageStore>) => UsageInjected {
  return (actions: BoundActions<UsageStore>): UsageInjected => {
    const tabs = new Map<TabId, TabReads>()
    // Reached with a live signal only: the record's end forgets the bucket
    // and this bookkeeping in one listener, however often the body mounts.
    const readsOf = (tabId: TabId, signal: AbortSignal): TabReads => {
      const held = tabs.get(tabId)
      if (held !== undefined) return held
      const created: TabReads = { generation: 0 }
      tabs.set(tabId, created)
      signal.addEventListener('abort', () => {
        tabs.delete(tabId)
        actions.forget(tabId)
      }, { once: true })
      return created
    }
    const loadSummary = (tabId: TabId, range: UsageRange, signal: AbortSignal): void => {
      if (signal.aborted) return
      const reads = readsOf(tabId, signal)
      // A newer fetch supersedes every older one: only its settlement writes.
      reads.generation += 1
      const { generation } = reads
      actions.loading(tabId)
      void fetch(range, signal).then((result) => {
        if (signal.aborted || reads.generation !== generation) return
        if (!result.ok) {
          actions.failed(tabId, result.error)
          return
        }
        // A range switch since the fetch started leaves this settlement
        // orphaned: the body fetches the newly selected range itself.
        if (result.value.range !== range) return
        actions.loaded(tabId, result.value)
      })
    }
    return { loadSummary }
  }
}
