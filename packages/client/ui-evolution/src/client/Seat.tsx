/**
 * Seats for the evolution journey surface: the sidebar panel row that selects
 * the journey panel, and the center-track panel that maps the framework's
 * Session and Workspace state into the page props. A Session whose Workspace
 * the registry no longer lists — like no Session at all — renders the page's
 * no-Scope state rather than a blank column.
 */
import type { ReactNode } from 'react'
import { IconEnhanceOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls ui-workspace's standard-props merge (useWorkspaces).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { EvolutionPage } from './Page.tsx'
import type { PageRemote } from './rpc.ts'

/** Injected page services: the throwing Remote verbs plus the follow transport. */
export interface EvolutionInjected {
  /** Throwing Remote verbs plus the follow transport. */
  remote: PageRemote
}

/** Main-panel seat props: root runtime share plus the injected face and copy. */
export type EvolutionSeatProps =
  & PropsRuntime<'main'>
  & InjectFace<EvolutionInjected>
  & PropsLocale<'evolution'>

/** Sidebar panel-row props: the row's glyph share plus the locale seat. */
export type EvolutionPanelIconProps = PropsRuntime<'sidebar.panellist'>

/**
 * Render the sidebar row's glyph for the journey panel.
 * @param props - the row's owner share.
 * @returns the icon element.
 */
export function EvolutionPanelIcon({ size }: EvolutionPanelIconProps): ReactNode {
  return <IconEnhanceOutlineRegular size={size} />
}

/**
 * Render the journey panel for the selected Session's Workspace.
 * @param props - composed slot props.
 * @returns the page, or its no-Scope state while no Workspace is selected.
 */
export function EvolutionSeat({ remote, useSessions, useWorkspaces, t }: EvolutionSeatProps): ReactNode {
  const current = useSessions(state => Object.values(state.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const workspaces = useWorkspaces(state => state.items)
  const workspace = current === undefined
    ? undefined
    : workspaces.find(entry => entry.sessionIds.includes(current))
  return (
    <EvolutionPage
      scopeId={workspace?.workspaceId ?? null}
      scopeTitle={workspace?.title ?? null}
      remote={remote}
      t={t}
    />
  )
}
