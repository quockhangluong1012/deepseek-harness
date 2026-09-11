/**
 * The dashboard face: generation-guarded writes, range-mismatch orphans,
 * failures beside settled data, and bucket cleanup when the record ends.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { UsageRange, UsageSummary } from '@deepseek-ai/dsh-usage-ledger/types'
import { usageFace } from '../src/client/face.ts'
import type { FetchUsageSummary } from '../src/client/rpc.ts'
import { createUsageDashboardStore } from '../src/client/store.ts'
import { failure, summary } from './fixtures.client.ts'

const TAB = 'tab-1' as TabId

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function faceWith(results: Partial<Record<UsageRange, RemoteResult<UsageSummary>>> = {}) {
  const instance = createUsageDashboardStore().create()
  const fetch = vi.fn<FetchUsageSummary>(range => Promise.resolve(results[range] ?? { ok: true, value: summary(range) }))
  const face = usageFace(fetch)(instance.actions)
  return { instance, fetch, face }
}

describe('usage dashboard face', () => {
  it('writes a settled summary under its range', async () => {
    const { instance, face } = faceWith({ today: { ok: true, value: summary('today') } })
    const controller = new AbortController()
    face.loadSummary(TAB, 'today', controller.signal)
    expect(instance.getSnapshot().byTab[TAB]?.loading).toBe(true)
    await settle()
    expect(instance.getSnapshot().byTab[TAB]?.summaries['today']?.totals.requests).toBe(3)
    expect(instance.getSnapshot().byTab[TAB]?.loading).toBe(false)
  })

  it('drops a settlement from a superseded range', async () => {
    const instance = createUsageDashboardStore().create()
    let resolveFetch!: (value: RemoteResult<UsageSummary>) => void
    const fetch = vi.fn<FetchUsageSummary>(() => new Promise<RemoteResult<UsageSummary>>((resolve) => { resolveFetch = resolve }))
    const face = usageFace(fetch)(instance.actions)
    const controller = new AbortController()
    face.loadSummary(TAB, 'today', controller.signal)
    resolveFetch({ ok: true, value: summary('7d') })
    await settle()
    expect(instance.getSnapshot().byTab[TAB]?.summaries['today']).toBeUndefined()
    expect(instance.getSnapshot().byTab[TAB]?.loading).toBe(true)
  })

  it('drops a settlement superseded by a newer fetch', async () => {
    const instance = createUsageDashboardStore().create()
    const resolvers: Array<(value: RemoteResult<UsageSummary>) => void> = []
    const fetch = vi.fn<FetchUsageSummary>(() => new Promise<RemoteResult<UsageSummary>>((resolve) => { resolvers.push(resolve) }))
    const face = usageFace(fetch)(instance.actions)
    const controller = new AbortController()
    face.loadSummary(TAB, 'today', controller.signal)
    face.loadSummary(TAB, 'today', controller.signal)
    resolvers[0]?.({ ok: true, value: summary('today') })
    await settle()
    expect(instance.getSnapshot().byTab[TAB]?.summaries['today']).toBeUndefined()
    expect(instance.getSnapshot().byTab[TAB]?.loading).toBe(true)
    resolvers[1]?.({ ok: true, value: summary('today') })
    await settle()
    expect(instance.getSnapshot().byTab[TAB]?.summaries['today']?.totals.requests).toBe(3)
    expect(instance.getSnapshot().byTab[TAB]?.loading).toBe(false)
  })

  it('records a failure and keeps settled summaries', async () => {
    const { instance, face } = faceWith({ today: failure() })
    instance.actions.loaded(TAB, summary('today'))
    const controller = new AbortController()
    face.loadSummary(TAB, 'today', controller.signal)
    await settle()
    expect(instance.getSnapshot().byTab[TAB]?.failure).toBeDefined()
    expect(instance.getSnapshot().byTab[TAB]?.summaries['today']).toBeDefined()
  })

  it('ignores a read for an ended record and forgets the bucket on abort', async () => {
    const { instance, face } = faceWith({ today: { ok: true, value: summary('today') } })
    const ended = new AbortController()
    ended.abort()
    face.loadSummary(TAB, 'today', ended.signal)
    expect(instance.getSnapshot().byTab[TAB]).toBeUndefined()
    const live = new AbortController()
    face.loadSummary(TAB, 'today', live.signal)
    await settle()
    expect(instance.getSnapshot().byTab[TAB]).toBeDefined()
    live.abort()
    expect(instance.getSnapshot().byTab[TAB]).toBeUndefined()
  })
})
