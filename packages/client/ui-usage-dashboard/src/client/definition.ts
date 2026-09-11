/**
 * Stage one of this package's registration: what the `usage` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page
 * offers it as an entry box, and the body reads the Host usage ledger over
 * the `usageDashboard` Remote namespace plus the current session's
 * projections for its header.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconGaugeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tab kind this package owns. */
export const USAGE_KIND = 'usage'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const USAGE_ID = '@deepseek-ai/dsh-client-ui-usage-dashboard'

/**
 * The usage type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function usageDefinition(t: TranslateNS<'sidebarUsage'>): SidebarRightTabDefinition {
  return {
    id: USAGE_ID,
    kind: USAGE_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      order: 20,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: IconGaugeOutline16,
    }],
  }
}
