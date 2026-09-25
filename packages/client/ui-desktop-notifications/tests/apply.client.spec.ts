// @vitest-environment jsdom
/**
 * The Desktop-only notification watcher: absent-bridge no-op, turn/approval/
 * question diffing against `uiSession.sessionStatus`, job-settlement diffing
 * against `ctx.jobs.state` with per-session roster watch reconciliation, and
 * click routing back to `uiWorkspace.openSession`.
 */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { DesktopNotificationBridge, DesktopNotificationRequest } from '../src/types.ts'

const SESSION_A = 's-a' as SessionId
const SESSION_B = 's-b' as SessionId

interface FakeSessionStatus {
  running?: boolean
  pendingInteraction?: { kind: string } | undefined
  completionUnread: boolean
}

interface FakeJobRow {
  id: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  label: string
}

/** One test's full stub surface plus the fiber under test. */
interface Bench {
  ctx: Context
  bridge: DesktopNotificationBridge
  shows: DesktopNotificationRequest[]
  withdraws: string[]
  clickListener: ((id: string) => void) | undefined
  openSession: ReturnType<typeof vi.fn>
  watchCalls: SessionId[]
  stopFns: Map<string, ReturnType<typeof vi.fn>>
  sessionsList: ReturnType<typeof createSnapshotStore<{ ids: SessionId[]; byId: Record<string, { title?: string }> }>>
  sessionStatus: ReturnType<typeof createSnapshotStore<Map<SessionId, FakeSessionStatus>>>
  jobsState: ReturnType<typeof createSnapshotStore<{ rows: Record<string, FakeJobRow[]> }>>
}

/** Boot the plugin with a full stub surface; `withBridge` controls `window.dshDesktop.notifications` presence. */
async function bench(withBridge: boolean): Promise<Bench> {
  const shows: DesktopNotificationRequest[] = []
  const withdraws: string[] = []
  let clickListener: ((id: string) => void) | undefined
  const bridge: DesktopNotificationBridge = {
    show: (request) => { shows.push(request) },
    withdraw: (id) => { withdraws.push(id) },
    onClick: (listener) => { clickListener = listener; return () => { clickListener = undefined } },
  }
  ;(globalThis as typeof globalThis & { dshDesktop?: unknown }).dshDesktop =
    withBridge ? { protocolVersion: 1, notifications: bridge } : undefined

  const openSession = vi.fn()
  const sessionsList = createSnapshotStore<{ ids: SessionId[]; byId: Record<string, { title?: string }> }>(
    { ids: [], byId: {} },
  )
  const sessionStatus = createSnapshotStore<Map<SessionId, FakeSessionStatus>>(new Map())
  const jobsState = createSnapshotStore<{ rows: Record<string, FakeJobRow[]> }>({ rows: {} })
  const watchCalls: SessionId[] = []
  const stopFns = new Map<string, ReturnType<typeof vi.fn>>()
  let registered: Record<string, string> = {}

  const ctx = new Context()
  ctx.provide('sessions', { list: sessionsList } as never)
  ctx.provide('uiSession', { sessionStatus } as never)
  ctx.provide('jobs', {
    state: jobsState,
    watchRows: (sessionId: SessionId) => {
      watchCalls.push(sessionId)
      const stop = vi.fn()
      stopFns.set(String(sessionId), stop)
      return stop
    },
  } as never)
  ctx.provide('uiWorkspace', { openSession } as never)
  ctx.provide('locale', {
    register: (_ns: string, dict: { en: Record<string, string> }) => {
      registered = dict.en
      return () => {}
    },
    bind: () => (key: string) => registered[key] ?? key,
  } as never)
  await ctx.plugin({ inject: [...inject], apply }).await()

  return {
    ctx, bridge, shows, withdraws, get clickListener() { return clickListener },
    openSession, watchCalls, stopFns, sessionsList, sessionStatus, jobsState,
  }
}

describe('ui-desktop-notifications browser half', () => {
  let hasFocus: MockInstance<typeof document.hasFocus>

  beforeEach(() => { hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false) })
  afterEach(() => {
    hasFocus.mockRestore()
    ;(globalThis as typeof globalThis & { dshDesktop?: unknown }).dshDesktop = undefined
  })

  it('does nothing when the Desktop bridge is absent', async () => {
    const { shows } = await bench(false)
    expect(shows).toHaveLength(0)
  })

  it('notifies a turn finishing while unfocused, using the session title', async () => {
    const { sessionsList, sessionStatus, shows } = await bench(true)
    sessionsList.set({ ids: [SESSION_A], byId: { [SESSION_A]: { title: 'Refactor auth' } } })
    sessionStatus.set(new Map([[SESSION_A, { running: true, completionUnread: false }]]))
    sessionStatus.set(new Map([[SESSION_A, { running: false, completionUnread: false }]]))
    expect(shows).toEqual([{ id: `turn:${SESSION_A}`, title: 'Turn finished', body: 'Refactor auth' }])
  })

  it('does not notify a turn finishing while focused', async () => {
    hasFocus.mockReturnValue(true)
    const { sessionStatus, shows } = await bench(true)
    sessionStatus.set(new Map([[SESSION_A, { running: true, completionUnread: false }]]))
    sessionStatus.set(new Map([[SESSION_A, { running: false, completionUnread: false }]]))
    expect(shows).toHaveLength(0)
  })

  it('notifies an approval request, then withdraws it once answered', async () => {
    const { sessionStatus, shows, withdraws } = await bench(true)
    sessionStatus.set(new Map([[SESSION_A, { completionUnread: false, pendingInteraction: { kind: 'approval' } }]]))
    sessionStatus.set(new Map([[SESSION_A, { completionUnread: false }]]))
    expect(shows).toEqual([{ id: `pending:${SESSION_A}`, title: 'Approval needed', body: 'Unnamed session' }])
    expect(withdraws).toEqual([`pending:${SESSION_A}`])
  })

  it('notifies a question request distinctly from an approval', async () => {
    const { sessionStatus, shows } = await bench(true)
    sessionStatus.set(new Map([[SESSION_A, { completionUnread: false, pendingInteraction: { kind: 'plan-review' } }]]))
    expect(shows).toEqual([{ id: `pending:${SESSION_A}`, title: 'New question', body: 'Unnamed session' }])
  })

  it('notifies a background job settling while unfocused', async () => {
    const { jobsState, shows } = await bench(true)
    jobsState.set({ rows: { [SESSION_A]: [{ id: 'job-1', status: 'running', label: 'pnpm test' }] } })
    jobsState.set({ rows: { [SESSION_A]: [{ id: 'job-1', status: 'completed', label: 'pnpm test' }] } })
    expect(shows).toEqual([{ id: `job:${SESSION_A}:job-1`, title: 'Background job finished', body: 'pnpm test' }])
  })

  it('does not notify a job settling while focused', async () => {
    hasFocus.mockReturnValue(true)
    const { jobsState, shows } = await bench(true)
    jobsState.set({ rows: { [SESSION_A]: [{ id: 'job-1', status: 'running', label: 'pnpm test' }] } })
    jobsState.set({ rows: { [SESSION_A]: [{ id: 'job-1', status: 'completed', label: 'pnpm test' }] } })
    expect(shows).toHaveLength(0)
  })

  it('routes a notification click to the encoded session', async () => {
    const { clickListener, openSession } = await bench(true)
    clickListener?.(`turn:${SESSION_A}`)
    expect(openSession).toHaveBeenCalledWith(SESSION_A)
  })

  it('watches every listed session\'s job roster and stops watching one that leaves the list', async () => {
    const { sessionsList, watchCalls, stopFns } = await bench(true)
    sessionsList.set({ ids: [SESSION_A, SESSION_B], byId: {} })
    expect(watchCalls).toEqual([SESSION_A, SESSION_B])
    sessionsList.set({ ids: [SESSION_B], byId: {} })
    expect(stopFns.get(SESSION_A)).toHaveBeenCalledTimes(1)
    expect(stopFns.get(SESSION_B)).not.toHaveBeenCalled()
  })
})

describe('ui-desktop-notifications node half', () => {
  it('is an inert Host companion', () => {
    expect(() => { applyNode() }).not.toThrow()
  })
})
