/**
 * Stage one of this package's registration: what the `progress` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page
 * offers it as an entry box, and the panel reveals itself at a Session's first
 * progress (see `auto-open.ts`).
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tab kind this package owns. */
export const PROGRESS_KIND = 'progress'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const PROGRESS_ID = '@deepseek-ai/dsh-client-ui-progress'

/**
 * The progress type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function progressDefinition(t: TranslateNS<'sidebarProgress'>): SidebarRightTabDefinition {
  return {
    id: PROGRESS_ID,
    kind: PROGRESS_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      order: 30,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: IconChecklistOutlineRegular,
    }],
  }
}
