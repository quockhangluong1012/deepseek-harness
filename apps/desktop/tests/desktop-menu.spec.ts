import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { en, zh } from '../src/locale.ts'
import { buildDesktopMenu } from '../src/menu.ts'

function submenuOf(entry: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  const submenu = entry.submenu
  if (!Array.isArray(submenu)) throw new Error('desktop menu: expected a submenu array')
  return submenu
}

/**
 * Read one top-level menu entry by position.
 * @param template - menu template built by `buildDesktopMenu`.
 * @param index - zero-based position of the expected entry.
 * @returns the entry at that position.
 */
function entryAt(template: MenuItemConstructorOptions[], index: number): MenuItemConstructorOptions {
  const entry = template[index]
  if (entry === undefined) throw new Error(`desktop menu: missing entry ${String(index)}`)
  return entry
}

describe('desktop application menu', () => {
  it('builds Edit, View, and Window menus beside the application menu', () => {
    const template = buildDesktopMenu('DeepSeek Harness', en, true, {
      openPlugins: vi.fn(),
      checkUpdates: vi.fn(),
    })
    expect(template.map(entry => entry.label)).toEqual([
      'DeepSeek Harness',
      en.editMenu,
      en.viewMenu,
      en.windowMenu,
    ])
    const roles = (entry: MenuItemConstructorOptions): unknown[] =>
      submenuOf(entry).map(item => item.role ?? item.type)
    expect(roles(entryAt(template, 1))).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll'])
    expect(roles(entryAt(template, 2))).toEqual(
      ['reload', 'separator', 'zoomIn', 'zoomOut', 'resetZoom', 'separator', 'toggleDevTools'],
    )
    expect(roles(entryAt(template, 3))).toEqual(['minimize', 'close'])
    expect(roles(entryAt(template, 0))).toEqual([undefined, undefined, 'separator', 'quit'])
  })

  it('enables plugin management only in packaged applications', () => {
    const handlers = { openPlugins: vi.fn(), checkUpdates: vi.fn() }
    const packagedEntry = entryAt(submenuOf(entryAt(buildDesktopMenu('app', en, true, handlers), 0)), 0)
    expect(packagedEntry.label).toBe(en.pluginsMenu)
    expect(packagedEntry.enabled).toBe(true)
    const devEntry = entryAt(submenuOf(entryAt(buildDesktopMenu('app', en, false, handlers), 0)), 0)
    expect(devEntry.label).toBe(en.pluginsMenuPackagedOnly)
    expect(devEntry.enabled).toBe(false)
  })

  it('shows developer tooling only in unpackaged development', () => {
    const handlers = { openPlugins: vi.fn(), checkUpdates: vi.fn() }
    const viewPackaged = submenuOf(entryAt(buildDesktopMenu('app', en, true, handlers), 2))
    const viewDev = submenuOf(entryAt(buildDesktopMenu('app', en, false, handlers), 2))
    expect(viewPackaged.find(item => item.role === 'toggleDevTools')?.visible).toBe(false)
    expect(viewDev.find(item => item.role === 'toggleDevTools')?.visible).toBe(true)
  })

  it('labels top-level menus from the active locale dictionary', () => {
    const handlers = { openPlugins: vi.fn(), checkUpdates: vi.fn() }
    expect(buildDesktopMenu('app', zh, true, handlers).map(entry => entry.label)).toEqual([
      'app',
      zh.editMenu,
      zh.viewMenu,
      zh.windowMenu,
    ])
  })
})
