/**
 * Desktop-only OS notifications for turn completions, pending approvals or
 * questions, and background-job settlements. Fires only while the window has
 * no focus (the in-app UI already surfaces these while the user is looking),
 * and clicking a notification focuses the originating session. No-op outside
 * the Desktop shell: the plugin reads its bridge from `window.dshDesktop`,
 * left absent by the Web build.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-job-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopNotificationBridge } from '../types.ts'
import { en, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop OS-notification copy. */
    desktopNotifications: import('./locales.ts').DesktopNotificationsKey
  }
}

const NS = 'desktopNotifications'

/** Required services: Session state and UI status, jobs rosters, Workspace navigation, dictionaries. */
export const inject = ['sessions', 'uiSession', 'jobs', 'uiWorkspace', 'locale']

/**
 * Register the OS-notification watcher.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly notifications?: DesktopNotificationBridge }
  }).dshDesktop
  const bridge = carrier?.protocolVersion === 1 ? carrier.notifications : undefined
  if (bridge === undefined) return

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-desktop-notifications.copy')
  const t = ctx.locale.bind(NS)

  const sessionTitle = (sessionId: SessionId): string =>
    ctx.sessions.list.getSnapshot().byId[sessionId]?.title ?? t('unnamedSession')

  ctx.effect(() => bridge.onClick((id) => {
    const sessionId = id.split(':')[1] as SessionId | undefined
    if (sessionId !== undefined) ctx.uiWorkspace.openSession(sessionId)
  }), 'ui-desktop-notifications.click')

  // Turn completions and pending approval/question requests, from Session UI status.
  let previousStatus = ctx.uiSession.sessionStatus.getSnapshot()
  ctx.effect(() => ctx.uiSession.sessionStatus.subscribe(() => {
    const next = ctx.uiSession.sessionStatus.getSnapshot()
    if (document.hasFocus()) { previousStatus = next; return }
    for (const [sessionId, status] of next) {
      const before = previousStatus.get(sessionId)
      if (before?.running === true && status.running === false) {
        bridge.show({ id: `turn:${sessionId}`, title: t('turnFinished'), body: sessionTitle(sessionId) })
      }
      if (before?.pendingInteraction === undefined && status.pendingInteraction !== undefined) {
        const title = status.pendingInteraction.kind === 'approval' ? t('approvalNeeded') : t('questionAsked')
        bridge.show({ id: `pending:${sessionId}`, title, body: sessionTitle(sessionId) })
      } else if (before?.pendingInteraction !== undefined && status.pendingInteraction === undefined) {
        bridge.withdraw(`pending:${sessionId}`)
      }
    }
    previousStatus = next
  }), 'ui-desktop-notifications.session-status')

  // Background-job settlements, watched across every session currently listed (not just the visible one).
  let previousJobs = ctx.jobs.state.getSnapshot().rows
  ctx.effect(() => ctx.jobs.state.subscribe(() => {
    const rows = ctx.jobs.state.getSnapshot().rows
    if (!document.hasFocus()) {
      for (const [sessionId, jobs] of Object.entries(rows)) {
        const before = previousJobs[sessionId] ?? []
        for (const job of jobs) {
          const wasLive = before.find(row => row.id === job.id)?.status
          const isLive = job.status === 'running' || job.status === 'stopping'
          if ((wasLive === 'running' || wasLive === 'stopping') && !isLive) {
            bridge.show({ id: `job:${sessionId}:${job.id}`, title: t('jobFinished'), body: job.label })
          }
        }
      }
    }
    previousJobs = rows
  }), 'ui-desktop-notifications.jobs')

  const jobWatchers = new Map<SessionId, () => void>()
  const reconcileJobWatchers = (): void => {
    const present = new Set(ctx.sessions.list.getSnapshot().ids)
    for (const sessionId of present) {
      if (!jobWatchers.has(sessionId)) jobWatchers.set(sessionId, ctx.jobs.watchRows(sessionId))
    }
    for (const [sessionId, stop] of jobWatchers) {
      if (!present.has(sessionId)) { stop(); jobWatchers.delete(sessionId) }
    }
  }
  ctx.effect(() => {
    reconcileJobWatchers()
    const unsubscribe = ctx.sessions.list.subscribe(reconcileJobWatchers)
    return () => {
      unsubscribe()
      for (const stop of jobWatchers.values()) stop()
      jobWatchers.clear()
    }
  }, 'ui-desktop-notifications.job-watch')
}
