/**
 * The dashboard store's write set: range selection that keeps settled
 * summaries, fetch lifecycle beside them, and one bucket per tab dropped on
 * `forget`.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createUsageDashboardStore, fresh } from '../src/client/store.ts'
import { summary } from './fixtures.client.ts'

const TAB_1 = 'tab-1' as TabId
const TAB_2 = 'tab-2' as TabId

describe('usage dashboard store', () => {
  it('starts empty and mints a bucket at the default range on the first write', () => {
    const instance = createUsageDashboardStore().create()
    expect(instance.getSnapshot().byTab).toEqual({})
    instance.actions.loading(TAB_1)
    expect(instance.getSnapshot().byTab[TAB_1]).toEqual({ ...fresh(), loading: true })
    expect(instance.getSnapshot().byTab[TAB_1]?.range).toBe('today')
  })

  it('keeps settled summaries across range switches', () => {
    const instance = createUsageDashboardStore().create()
    instance.actions.loaded(TAB_1, summary('today'))
    instance.actions.selectRange(TAB_1, '7d')
    expect(instance.getSnapshot().byTab[TAB_1]?.range).toBe('7d')
    expect(instance.getSnapshot().byTab[TAB_1]?.summaries['today']?.totals.requests).toBe(3)
  })

  it('records a failure beside settled summaries, cleared by the next load', () => {
    const instance = createUsageDashboardStore().create()
    instance.actions.loaded(TAB_1, summary('today'))
    const failure = { code: 'gateway/internal', message: 'x', details: {} } as unknown as RemoteFailure
    instance.actions.failed(TAB_1, failure)
    expect(instance.getSnapshot().byTab[TAB_1]?.failure).toBe(failure)
    expect(instance.getSnapshot().byTab[TAB_1]?.summaries['today']).toBeDefined()
    instance.actions.loaded(TAB_1, summary('today'))
    expect(instance.getSnapshot().byTab[TAB_1]?.failure).toBeUndefined()
    expect(instance.getSnapshot().byTab[TAB_1]?.loading).toBe(false)
  })

  it('drops only the forgotten tab', () => {
    const instance = createUsageDashboardStore().create()
    instance.actions.loading(TAB_1)
    instance.actions.loading(TAB_2)
    instance.actions.forget(TAB_1)
    expect(instance.getSnapshot().byTab[TAB_1]).toBeUndefined()
    expect(instance.getSnapshot().byTab[TAB_2]).toBeDefined()
  })
})
