/** Browser plugin for durable kernel-task Conversation Nodes. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { KernelTaskPanel } from './KernelTaskPanel.tsx'
import { en, NS, type KernelTaskKey, zh } from './locales.ts'
import { kernelTaskDefinition } from './task-definition.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Durable kernel-task node copy. */
    kernelTask: KernelTaskKey
  }
}

/** Required services for the Definition, copy, and keyed renderer. */
export const inject = ['uiConversation', 'slots', 'locale']

/** Register the kernel-task Definition, dictionary, and keyed Chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(kernelTaskDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-kernel-task: dictionaries')
  ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'kernel-task',
    locale: NS,
  }, KernelTaskPanel)
}
