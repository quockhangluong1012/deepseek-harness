/**
 * Sign-in companion for the Models page, browser half. It registers the
 * provider-card seat that renders OAuth and interactive logins beside the
 * page's own API-key editor. The Host authorization and credential contracts
 * stay behind their existing wire APIs.
 * Export discipline:
 * packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the provider-card seat).
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the slot registry's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (credential invalidations ride the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { SignInCard } from './SignInCard.tsx'
import type { SignInCardInjected } from './SignInCard.tsx'
import { createAuthorizationOperations } from './operations.ts'
import { en, zh, type AuthorizationKey } from './locales.ts'

export type { SignInCardInjected, SignInCardProps } from './SignInCard.tsx'
export type { AuthorizationOperations } from './operations.ts'
export type { AuthorizationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The sign-in companion copy. */
    'settings.authorization': AuthorizationKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.authorization'

/**
 * Required services (cordis fiber inject). The target seat is declared by the
 * Models page, whose activation order relative to this one is NOT
 * constrained; registration depends on the seat through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.authorization']

/**
 * Register the sign-in companion on the Models provider-card seat for the
 * `llm-pi-ai` family.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-authorization: copy dictionaries')

  // Bound once here, where the Remote namespace is declared in this plugin's
  // own `inject`; the card receives callbacks and never a context.
  const operations = createAuthorizationOperations(ctx)
  // Registration-time copy and the inject face share one bound translate;
  // copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as SignInCardInjected['t']
  const injected = (): SignInCardInjected => ({ operations, t })

  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-pi-ai',
    locale: NS,
    inject: injected,
  }, SignInCard))
}
