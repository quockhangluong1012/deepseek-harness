/**
 * Browser half: the right-Sidebar `usage` tab type (current session only)
 * plus the left-sidebar Dashboard entry (all sessions).
 *
 * The right tab body reads the current session's projections and fetches
 * nothing. The footer-action trigger opens a full-viewport overlay whose body
 * reads cross-session figures over the `usageDashboard` Remote namespace.
 * Every import from another client plugin is a type.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { USAGE_ID, usageDefinition } from './definition.ts'
import { createFetchSummary } from './rpc.ts'
import { usageFace } from './face.ts'
import { UsageDashboard } from './UsageDashboard.tsx'
import { DashboardAction } from './DashboardAction.tsx'
import { createUsageDashboardStore } from './store.ts'
import { en, zh } from './locales.ts'

// Values stay package-private unless another package needs them; the plugin
// surface is `apply`, `inject`, and the store factory another registration may
// share, plus the types a consumer of the seat or the store names.
export type { SidebarUsageKey } from './locales.ts'
export type { UsageDashboardProps } from './UsageDashboard.tsx'
export type { DashboardActionProps } from './DashboardAction.tsx'
export { DASHBOARD_OVERLAY_ID } from './DashboardAction.tsx'
export type { UsageInjected } from './face.ts'
export type { FetchUsageSummary, UsageDashboardReadRemote } from './rpc.ts'
export type { UsageState, UsageStore, UsageTabState } from './store.ts'

/** This package's copy namespace. */
const NS = 'sidebarUsage'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Usage dashboard tab copy. */
    sidebarUsage: import('./locales.ts').SidebarUsageKey
  }
}

/**
 * Required browser services: the tab registry, the slot registry, copy, and
 * the Remote carrier with its `usageDashboard` namespace.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.usageDashboard']

/**
 * Client plugin body: register the current-session type, its dictionaries,
 * its body, and the all-sessions Dashboard footer action.
 * @param ctx - client root context carrying the registry, the slots, copy, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(usageDefinition(t)), 'ui-usage-dashboard: usage type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-usage-dashboard: dictionaries')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: USAGE_ID, locale: NS },
    UsageDashboard,
  )), 'ui-usage-dashboard: usage tab body')

  // One store for the overlay dialog (root scope): the right tab body keeps
  // no fetch state of its own.
  const store = createUsageDashboardStore()
  const face = usageFace(createFetchSummary(ctx.remote))
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action', id: 'usage-dashboard', locale: NS, store, inject: face,
    },
    DashboardAction,
  )), 'ui-usage-dashboard: dashboard action')
}
