/**
 * The plugin's registrations, and the reveal wiring behind them.
 *
 * The tab registry is real, because "registered" means what it says a type is;
 * the slot, locale, Session, and right-Sidebar faces are recorders, because
 * what matters is what was handed to them and what the reveal does with a
 * progress frame. The reveal reads the Session binding's three faces — the
 * session's own lifecycle, the `todos` projection, and the Chat target —
 * through fakes that publish on demand.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionBinding, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { PROGRESS_ID, PROGRESS_KIND } from '../src/client/definition.ts'
import { apply, inject } from '../src/client/index.ts'
import { ProgressBody } from '../src/client/ProgressBody.tsx'
import { en, zh } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'

interface Recorded {
  name: string
  key: string
  locale: string
  component: unknown
}

/** A bare observable that publishes synchronously, as a frame would. */
interface Publishing<T> extends ObservableSnapshot<T> {
  publish(value: T): void
}

function observable<T>(initial: T): Publishing<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish: (next) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const SESSION = 'session-1' as SessionId

function timelineOf(...paths: readonly string[]): ConversationTimelineSnapshot {
  return {
    turnOrder: [1],
    turns: new Map([[1, {
      data: {
        get: (key: string) => key === 'deliverables'
          ? { produced: paths.map((path, seq) => ({ seq, path })) }
          : undefined,
      },
    }]]),
  } as unknown as ConversationTimelineSnapshot
}

async function boot() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    // Copy is the dictionary's contract; the key stands in for the translation.
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const todos = observable<readonly TodoItem[] | null>(null)
  const chat = observable<{ timeline: ConversationTimelineSnapshot } | undefined>(undefined)
  const running = observable({ running: false })
  const absent = observable<unknown>(undefined)
  const bindings = new Map<string, SessionBinding>([[SESSION, {
    sessionId: SESSION,
    session: {
      getSnapshot: () => running.getSnapshot(),
      subscribe: (listener: () => void) => running.subscribe(listener),
      projections: { faceOf: (key: string) => key === 'todos' ? todos : absent },
    },
  } as unknown as SessionBinding]])
  const list = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  })
  const sessions = { list, binding: (id: SessionId) => bindings.get(id) }
  const openTab = vi.fn()
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('uiConversation', { binding: () => ({ target: () => chat }) } as never)
  ctx.provide('sidebarRight', { openTab } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    fiber, tabs, registered, dictionaries, openTab, todos, chat, running,
    /** Select one Session, exactly as the list store's own commit would. */
    open: (id: SessionId | undefined) => {
      const state = list.getSnapshot()
      const byId = id === undefined ? {} : {
        [id]: { id, displayTitle: String(id), running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 0 },
      }
      list.set({ ...state, ids: id === undefined ? [] : [id], byId })
    },
    /** Report the agent working, exactly as the Session snapshot would. */
    start: () => { running.publish({ running: true }) },
  }
}

describe('ui-progress apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers the type, its dictionaries, and the body seat under the type\'s id', async () => {
    const b = await boot()
    const definition = b.tabs.get(PROGRESS_KIND)
    expect(definition?.id).toBe(PROGRESS_ID)
    expect(definition?.priority).toBe('builtin')
    expect(definition?.title?.('sidebar://progress')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title?.(), entry.description?.()]))
      .toEqual([[30, 'guide.title', 'guide.description']])
    expect(b.dictionaries.get('sidebarProgress')).toEqual({ zh, en })
    expect(b.registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', PROGRESS_ID, 'sidebarProgress', ProgressBody],
    ])
  })

  it('reveals the panel at a running Session\'s first checklist, once', async () => {
    const b = await boot()
    b.open(SESSION)
    expect(b.openTab).not.toHaveBeenCalled()
    b.start()
    expect(b.openTab).not.toHaveBeenCalled()
    b.todos.publish([{ content: 'write the panel', status: 'pending' }])
    expect(b.openTab).toHaveBeenCalledExactlyOnceWith(PROGRESS_KIND)
    b.todos.publish([{ content: 'write the panel', status: 'completed' }])
    expect(b.openTab).toHaveBeenCalledOnce()
  })

  it('reveals the panel for a produced file alone', async () => {
    const b = await boot()
    b.open(SESSION)
    b.start()
    b.chat.publish({ timeline: timelineOf('out/report.html') })
    expect(b.openTab).toHaveBeenCalledExactlyOnceWith(PROGRESS_KIND)
  })

  it('reveals nothing for progress that was already there, or with no binding, or without a selection', async () => {
    const b = await boot()
    b.open(SESSION)
    b.todos.publish([{ content: 'loaded from history', status: 'completed' }])
    expect(b.openTab).not.toHaveBeenCalled()
    b.open('absent' as SessionId)
    b.start()
    b.todos.publish([{ content: 'still nothing', status: 'pending' }])
    expect(b.openTab).not.toHaveBeenCalled()
  })

  it('removes every registration and stops revealing when the plugin unloads', async () => {
    const b = await boot()
    b.open(SESSION)
    b.start()
    await b.fiber.dispose()
    expect(b.tabs.get(PROGRESS_KIND)).toBeUndefined()
    expect(b.registered).toHaveLength(0)
    expect(b.dictionaries.size).toBe(0)
    b.todos.publish([{ content: 'after unload', status: 'pending' }])
    expect(b.openTab).not.toHaveBeenCalled()
  })
})
