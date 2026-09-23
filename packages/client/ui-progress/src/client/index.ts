/**
 * Browser half: register `progress` as a right-Sidebar tab type over the two
 * facts the Session already publishes — the host-computed `todos` projection
 * and the files `ui-deliverables` reports per Turn — and reveal the panel at
 * each Session's first progress.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`,
 * the body into the keyed `sidebar.right.pane.tab` seat under the type's `id`.
 * The file split is this package's layering: what the type IS
 * (`definition.ts`), what it reports and how that is derived (`progress.ts`),
 * when it reveals itself (`auto-open.ts`), what it draws (`ProgressBody.tsx`),
 * what it says (`locales.ts`), and this module, which only wires them together.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { revealOnProgress } from './auto-open.ts'
import { PROGRESS_ID, PROGRESS_KIND, progressDefinition } from './definition.ts'
import { ProgressBody } from './ProgressBody.tsx'
import { en, zh } from './locales.ts'
import { hasProgress } from './progress.ts'

export type { ProgressKey } from './locales.ts'
export type { ProgressBodyProps } from './ProgressBody.tsx'

/** This package's copy namespace. */
const NS = 'sidebarProgress'

/**
 * Required browser services: the tab registry and keyed seat, copy, the
 * Session list and its bindings, and the Conversation assembly the Turn data
 * arrives through.
 */
export const inject = [
  'slots', 'locale', 'sessions', 'uiConversation', 'sidebarRight', 'sidebarRightTabs',
]

/**
 * Client plugin body: register the type, its dictionaries, and its body, then
 * start watching the current Session for the first progress to reveal.
 * @param ctx - client root context carrying the registry, the slots, and the Session services.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-progress: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(progressDefinition(t)), 'ui-progress: progress type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: PROGRESS_ID, locale: NS },
    ProgressBody,
  )), 'ui-progress: progress tab body')

  ctx.effect(() => revealOnProgress({
    current: () => Object.values(ctx.sessions.list.getSnapshot().byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id,
    onSelection: listener => ctx.sessions.list.subscribe(listener),
    follow: (sessionId, onChange) => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return undefined
      // The projection face and the Chat target both cross the framework's open
      // key space: the projection store erases per-key types (its typed read is
      // the `useProjection` seat) and the Chat target is typed by the view that
      // renders it. Re-establishing those two types here is this module's whole
      // reason to import them; the Session face is typed on its own.
      const todos = binding.session.projections.faceOf('todos')
      const chat = ctx.uiConversation.binding(binding).target('chat')
      const session = binding.session
      const offTodos = todos.subscribe(onChange)
      const offChat = chat.subscribe(onChange)
      const offSession = session.subscribe(onChange)
      return {
        isRunning: () => session.getSnapshot().running,
        hasProgress: () => hasProgress(
          todos.getSnapshot() as readonly TodoItem[] | null | undefined,
          chat.getSnapshot()?.timeline,
        ),
        dispose: () => {
          offTodos()
          offChat()
          offSession()
        },
      }
    },
    reveal: () => { ctx.sidebarRight.openTab(PROGRESS_KIND) },
  }), 'ui-progress: reveal on first progress')
}
