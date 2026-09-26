/**
 * MCP settings page, browser half: the **MCP** section of the Settings dialog.
 * It lists the servers declared in the project and user config files with their
 * declared trust label and live connection state, and adds, edits, or removes
 * them through the Host's `mcpServers` Remote. That service owns the config
 * files; a change that extends what the model can reach goes through the
 * Host's approval seam before anything is written.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.uiSession merge, read for the session an approval ask is
// addressed to, and the settings shell's SlotMap merge (the 'settings.section'
// entry).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { McpServersSection } from './McpServersSection.tsx'
import { McpSettingsController } from './mcp-settings-controller.ts'
import { en, zh, type McpSettingsLocaleKey } from './locales.ts'

export type { McpServersSectionProps } from './McpServersSection.tsx'
export type {
  DraftDeclaration, McpDraftProblem, McpNotice, McpServerDraft, McpSettingsFace, McpSettingsState,
} from './mcp-settings-controller.ts'
export type { McpSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP settings page copy. */
    'settings.mcp': McpSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.mcp'

/** Required services: the settings shell's slot ledger, copy, and the Host's management Remote. */
export const inject = ['slots', 'locale', 'remote', 'remote.mcpServers']

/**
 * Mount the MCP settings section and its dictionaries.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: dictionaries')
  const t = ctx.locale.bind(NS)
  // An approval ask needs the session the user is viewing; the read stays a
  // call so it reflects the selection at the moment of a write.
  const controller = new McpSettingsController(ctx, () => ctx.get('uiSession')?.adapter.current.getSnapshot().key as SessionId | undefined)
  // The section is registered whether or not it is the open one, so the page
  // reads the Host's view once when the plugin activates.
  void controller.load()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp',
    order: 60,
    label: () => t('nav'),
    locale: NS,
    inject: () => controller.inject(key => t(key)),
  }, McpServersSection))
}
