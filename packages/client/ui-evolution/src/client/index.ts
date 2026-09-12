/**
 * Evolution journey plugin, browser half: the sidebar panel row and the
 * center-track panel behind it, plus the `evolution` dictionaries. Both
 * registrations are additive — a `sidebar.panellist` list id and the matching
 * `main` keyed entry — so the journey neither replaces the conversation nor
 * contends for the single `shell.page` seat the Workspace page owns. The
 * plugin depends on the two Remote namespaces it reads and on nothing else.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { bindPageVerbs } from './rpc.ts'
import type { CuratorRawVerbs, NamespaceFace } from './rpc.ts'
import { EvolutionPanelIcon, EvolutionSeat } from './Seat.tsx'
import type { EvolutionInjected } from './Seat.tsx'
import { en, zh } from './locales.ts'
import type { EvolutionKey } from './locales.ts'

export type { EvolutionKey } from './locales.ts'
export type { EvolutionPageProps, PageTranslate } from './Page.tsx'
export type { EvolutionFollowSubscription, EvolutionFollowSink, PageRemote, PageVerbs } from './rpc.ts'
export type { EvolutionInjected, EvolutionPanelIconProps, EvolutionSeatProps } from './Seat.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Evolution journey page copy. */
    evolution: EvolutionKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'evolution'

/**
 * The panel's one identity: the `sidebar.panellist` row id and the `main`
 * keyed entry the row selects.
 */
const JOURNEY_PANEL_ID = 'evolution-journey'

/** Required browser services: the slot registry, copy, and both Remote faces. */
export const inject = ['slots', 'locale', 'remote', 'remote.evolution', 'remote.evolutionCurator']

/**
 * Register the journey panel row, its center-track panel, and the dictionaries.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const faces = ctx.remote as unknown as {
    evolution: NamespaceFace
    evolutionCurator: CuratorRawVerbs
  }
  const evolutionNs = faces.evolution
  const injected: EvolutionInjected = {
    remote: {
      ...bindPageVerbs({ evolution: evolutionNs, evolutionCurator: faces.evolutionCurator }),
      follow: signal => evolutionNs.follow(signal),
      openStream: options => ctx.remote.$stream(options),
    },
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-evolution: dictionaries')
  // Registration-time text (the row label) reads through the bound translate
  // as a thunk, so it follows the active locale without re-registration.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: JOURNEY_PANEL_ID,
    order: 10,
    label: () => t('panel.title'),
    locale: NS,
  }, EvolutionPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: JOURNEY_PANEL_ID,
    locale: NS,
    inject: () => injected,
  }, EvolutionSeat))
}
