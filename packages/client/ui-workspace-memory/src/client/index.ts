/**
 * Workspace-memory plugin, browser half. Provides the optional
 * `workspacePage` opener consumed by `ui-workspace` and routes the Workspace
 * page through the frame's center-track `shell.page` slot: the entry exists
 * only while a Workspace is open, so the page never outlives its subject.
 * Opening a page resolves the Workspace's blank Session and selects it, so the
 * conversation mounted beneath the page docks its resident composer into the
 * band the page holds open beneath its name and description — the page draws
 * no input of its
 * own, and its reader types into the same editor the home page shows, with the
 * model, permission, and mode seats live.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-workspace client merge (ctx.uiWorkspace).
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { bindPageVerbs } from './rpc.ts'
import type { NamespaceFace } from './rpc.ts'
import { WorkspaceMemorySeat } from './Seat.tsx'
import type { WorkspaceMemoryInjected } from './Seat.tsx'
import { en, zh } from './locales.ts'

export type { WorkspaceMemoryKey } from './locales.ts'
export type { WorkspaceMemorySeatProps, WorkspaceMemoryInjected } from './Seat.tsx'
export type { WorkspaceMemoryPageProps, PageSession, PageActivityRow, PageWorkspace } from './Page.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace-memory page copy. */
    workspaceMemory: import('./locales.ts').WorkspaceMemoryKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional owner of the Workspace page: `open` shows one, `close` vacates
     * the centre column. `ui-workspace` reads it when a chat is opened from the
     * sidebar, so the page never keeps covering the conversation asked for.
     */
    workspacePage: { open(workspaceId: string): void; close(): void }
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspaceMemory'

/** Required browser services. */
export const inject = ['slots', 'locale', 'remote', 'remote.workspaceMemory', 'sessions', 'uiWorkspace']

/**
 * Register the opener service and the page seat.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const uiWorkspace = ctx.get('uiWorkspace') as UiWorkspace
  const memoryNs = (ctx.remote as unknown as { workspaceMemory: NamespaceFace }).workspaceMemory
  const verbs = bindPageVerbs({ workspaceMemory: memoryNs })
  let openWorkspaceId: string | null = null
  // The current session at the moment the page opened. Opening any other
  // session — from the sidebar, a fork, a create — means "show me that
  // conversation", so the page yields the center column to it.
  let anchorSessionId: SessionId | undefined
  // The blank Session this page talks through, once its connect lands.
  let pageSessionId: SessionId | undefined
  const listeners = new Set<() => void>()
  const emitOpen = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const source: HostObservable<string | null> = {
    getSnapshot: () => openWorkspaceId,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  // The centre-track route entry: it exists only while a Workspace is open,
  // so `shell.page` occupancy means "the route is the page" and the
  // conversation keeps its centred hero whenever no page shows.
  let disposePageEntry: (() => void) | null = null
  const syncPageEntry = (): void => {
    if (openWorkspaceId === null) {
      disposePageEntry?.()
      disposePageEntry = null
      return
    }
    if (disposePageEntry === null) {
      disposePageEntry = ctx.slots.register(
        {
          name: 'shell.page',
          inject: () => injected,
          locale: NS,
        },
        WorkspaceMemorySeat as never,
      )
    }
  }
  const closePage = (): void => {
    if (openWorkspaceId === null) return
    openWorkspaceId = null
    pageSessionId = undefined
    emitOpen()
    syncPageEntry()
  }
  // In-flight Workspace connects. While one runs, a selection change may be its
  // own `create` picking the blank Session, which is not "the reader opened a
  // conversation"; the completion re-checks the selection and closes the page
  // when somebody else really did move it.
  let pendingConnects = 0
  // Resolve the Workspace's reusable blank Session (or a fresh one) and select
  // it: the conversation route's composer drives a real Session from the first
  // keystroke, which is what makes it the same control the home page shows. A
  // page closed while the connect was in flight keeps its selection.
  const connectPageSession = (workspaceId: string): void => {
    pendingConnects += 1
    void uiWorkspace.connectWorkspace(workspaceId as WorkspaceId).then(
      (sessionId) => {
        pendingConnects -= 1
        if (openWorkspaceId !== workspaceId) return
        const current = sessions.list.getSnapshot().current
        if (current !== undefined && current !== anchorSessionId && current !== sessionId) {
          closePage()
          return
        }
        pageSessionId = sessionId
        anchorSessionId = sessionId
        sessions.open(sessionId)
      },
      (reason: unknown) => {
        pendingConnects -= 1
        if (openWorkspaceId !== workspaceId) return
        console.warn('workspace page: no session for workspace', reason)
      },
    )
  }
  ctx.effect(() => ctx.provide('workspacePage', {
    open: (workspaceId: string) => {
      pageSessionId = undefined
      anchorSessionId = sessions.list.getSnapshot().current
      openWorkspaceId = workspaceId
      emitOpen()
      syncPageEntry()
      connectPageSession(workspaceId)
    },
    close: closePage,
  }), 'ui-workspace-memory: workspacePage')
  // Two ways the page yields the route. A cleared selection leaves it
  // standing — the page is also what the no-session view shows — and any other
  // session the reader opens means "show me that conversation". The page's own
  // Session hands the route back as soon as it is talked to, because the reply
  // streams in the conversation the page routed away from.
  ctx.effect(() => sessions.list.subscribe(() => {
    if (pendingConnects > 0) return
    const list = sessions.list.getSnapshot()
    const current = list.current
    if (current === undefined) return
    if (current === pageSessionId) {
      if (list.byId[current]?.blank === false) closePage()
      return
    }
    if (current === anchorSessionId) return
    closePage()
  }), 'ui-workspace-memory: page yields to an opened session')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace-memory: dictionaries')
  const injected: WorkspaceMemoryInjected = {
    remote: {
      ...verbs,
      follow: signal => memoryNs.follow(signal),
      openStream: options => ctx.remote.$stream(options),
    },
    openSession: (sessionId: SessionId) => {
      sessions.open(sessionId)
    },
    closePage,
    hooks: { workspacePage: source },
  }
  // The route entry follows the shell.page declaration lifetime, but occupies
  // it only while a Workspace is open — an empty slot routes the centre back
  // to the conversation.
  ctx.slots.inject('shell.page', () => {
    syncPageEntry()
    const onRouteChange = (): void => { syncPageEntry() }
    listeners.add(onRouteChange)
    return () => {
      listeners.delete(onRouteChange)
      disposePageEntry?.()
      disposePageEntry = null
    }
  })
}
