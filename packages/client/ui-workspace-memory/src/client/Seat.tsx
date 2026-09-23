/**
 * Seat for the Workspace page on the frame's center-track `shell.page` slot:
 * maps the viewing hook, the session and workspace snapshots, and the injected
 * Remote face into the page body. Renders null while no Workspace is open,
 * which leaves the conversation underneath visible and clickable — including
 * the composer seat the page layer reserves at the column floor.
 */
import type { ReactNode } from 'react'
import type {
  HostObservable,
  InjectFace,
  PropsHooks,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-turn-outline'
import { WorkspaceMemoryPage } from './Page.tsx'
import type { PageRemote } from './rpc.ts'

/** Injected page services: Remote verbs plus session navigation. */
export interface WorkspaceMemoryInjected {
  /** Throwing Remote verbs plus the follow transport. */
  remote: PageRemote
  /** Open a session; the page closes through the entry's own close. */
  openSession(sessionId: SessionId): void
  /** Leave the page. */
  closePage(): void
  /** Registrant-private viewing fact: the open Workspace id or null. */
  hooks: {
    workspacePage: HostObservable<string | null>
  }
}

/** Seat props: root runtime share plus the injected page services and copy. */
export type WorkspaceMemorySeatProps =
  & PropsRuntime<'shell.page'>
  & PropsHooks<WorkspaceMemoryInjected['hooks']>
  & InjectFace<WorkspaceMemoryInjected>
  & PropsLocale<'workspaceMemory'>

/**
 * Render the Workspace page seat.
 * @param props - composed slot props.
 * @returns the page, or null while no Workspace is open or the record is gone.
 */
export function WorkspaceMemorySeat({
  useWorkspacePage, remote, openSession, closePage, useSessions, useWorkspaces, t,
}: WorkspaceMemorySeatProps): ReactNode {
  const openWorkspaceId = useWorkspacePage(id => id)
  const workspaces = useWorkspaces(state => state.items)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const sessions = useSessions(state => state)
  if (openWorkspaceId === null) return null
  const workspace = workspaces.find(entry => entry.workspaceId === openWorkspaceId)
  if (workspace === undefined) return null
  // Workspace accounting keeps archived slots and never dedupes, so the page
  // filters to visible sessions itself: archived rows stay hidden (the browser
  // tree does the same) and a repeated id renders once. The blank rule mirrors
  // the tree too — only the selected provisional session stays visible — since
  // the page opens onto the workspace's blank session.
  const archived = new Set(archivedSessionIds)
  const currentSessionId = Object.values(sessions.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const seen = new Set<SessionId>()
  const visible = workspace.sessionIds.flatMap((id) => {
    if (seen.has(id)) return []
    seen.add(id)
    const summary = sessions.byId[id]
    if (summary === undefined || archived.has(id)) return []
    if (summary.blank && summary.id !== currentSessionId) return []
    return [summary]
  })
  const chats = visible
    .map(summary => ({ id: summary.id, title: summary.displayTitle, updatedAt: summary.updatedAt }))
  const activity = [...visible]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .flatMap(summary => (summary.projectionValues?.turnOutline ?? []).map(entry => ({
      sessionId: summary.id,
      sessionTitle: summary.displayTitle,
      turn: entry.turn,
      prompt: entry.prompt,
    })))
    .slice(0, 50)
  return (
    <WorkspaceMemoryPage
      openWorkspaceId={openWorkspaceId}
      workspace={{ workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path }}
      sessions={chats}
      activity={activity}
      remote={remote}
      onOpenSession={(id) => {
        openSession(id as SessionId)
        closePage()
      }}
      t={t}
    />
  )
}
