/**
 * The plugin's registrations, and their removal when the plugin goes.
 *
 * The registry is real, because "registered" means what it says a type is;
 * the slot, locale, and Remote faces are recorders, because what matters
 * here is what was handed to them — the current-session body seat under the
 * type's id plus the all-sessions Dashboard footer action with its store and
 * face — and that every registration is gone after dispose, which is what
 * makes a reload safe.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { USAGE_ID, USAGE_KIND } from '../src/client/definition.ts'
import { apply, inject } from '../src/client/index.ts'
import { UsageDashboard } from '../src/client/UsageDashboard.tsx'
import { DashboardAction } from '../src/client/DashboardAction.tsx'
import { en, zh } from '../src/client/locales.ts'

interface Recorded {
  name: string
  key?: string
  id?: string
  locale: string
  store?: unknown
  inject?: unknown
  component: unknown
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
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
    bind: vi.fn(() => (key: string) => key),
  }
  const usageDashboard = { summary: vi.fn() }
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('remote', { usageDashboard } as never)
  ctx.provide('remote.usageDashboard', usageDashboard as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber }
}

describe('ui-usage-dashboard apply', () => {
  it('registers the type, its dictionaries, the session body, and the Dashboard action', async () => {
    const { tabs, registered, dictionaries } = await boot()
    expect(tabs.get(USAGE_KIND)?.priority).toBe('builtin')
    expect(tabs.get(USAGE_KIND)?.id).toBe(USAGE_ID)
    expect(dictionaries.get('sidebarUsage')).toEqual({ zh, en })
    // The seat key is the implementation's id, not the kind: an extension may
    // take the kind over, and the seat must still find this body.
    expect(registered.map(entry => [entry.name, entry.key ?? entry.id, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', USAGE_ID, 'sidebarUsage', UsageDashboard],
      ['sidebar.footer.action', 'usage-dashboard', 'sidebarUsage', DashboardAction],
    ])
    const action = registered.find(entry => entry.name === 'sidebar.footer.action')
    expect(action?.store).toBeDefined()
    expect(typeof action?.inject).toBe('function')
  })

  it('takes every registration back when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(USAGE_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
