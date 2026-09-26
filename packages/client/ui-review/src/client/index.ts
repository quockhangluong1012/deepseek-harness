/**
 * Review plugin, browser half: registers the `review` Conversation Node
 * Definition for the durable `review/report` a `/review` or `/security-review`
 * run wrote, its keyed Chat renderer (the findings panel), and the `review`
 * dictionary. All presentation policy lives here, so composing this plugin out
 * of cordis.yml removes the panel and leaves the command's plain text.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ReviewPanel } from './ReviewPanel.tsx'
import { en, NS, type ReviewKey, zh } from './locales.ts'
import { reviewDefinition } from './review-definition.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Independent review panel copy. */
    review: ReviewKey
  }
}

/** Required services for the Definition, the keyed renderer, and the dictionary. */
export const inject = ['uiConversation', 'slots', 'locale']

/** Register the review Definition, dictionary, and keyed Chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(reviewDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-review: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'review',
    locale: NS,
  }, ReviewPanel))
}
