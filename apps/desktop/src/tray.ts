/** Desktop tray icon: window visibility, running agents, and the real quit. */

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** What the tray reports about the shell and the Host. */
export interface DesktopTrayStatus {
  /** Whether the primary window is visible; the menu then offers to hide it. */
  readonly windowVisible: boolean
  /** Whether the Host reported running agents or jobs; undefined when it could not be asked. */
  readonly activeTasks: boolean | undefined
}

/** Native actions the tray offers. */
export interface DesktopTrayActions {
  toggleWindow(): void
  openQuickPrompt(): void
  quit(): void
}

/** Live tray icon whose tooltip and menu are replaced on every status change. */
export interface DesktopTray {
  /** @param status - current window visibility and background work. */
  update(status: DesktopTrayStatus): void
  /** Remove the icon; the window close then keeps its quit semantics. */
  dispose(): void
}

/**
 * Build the tray menu for one status.
 * @param locale - shell-owned localized copy.
 * @param status - current window visibility and background work.
 * @param actions - native actions; every entry maps to exactly one.
 * @returns a menu whose first entry toggles the window and whose last quits for real.
 */
export function trayMenuTemplate(
  locale: DesktopLocale,
  status: DesktopTrayStatus,
  actions: DesktopTrayActions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: status.windowVisible ? locale.messages.trayHideWindow : locale.messages.trayShowWindow,
      click: () => { actions.toggleWindow() },
    },
    { label: locale.messages.trayQuickPrompt, click: () => { actions.openQuickPrompt() } },
    ...status.activeTasks === true
      ? [
        { type: 'separator' as const },
        { label: locale.messages.trayAgentsRunning, enabled: false },
      ]
      : [],
    { type: 'separator' },
    { label: locale.messages.trayQuit, click: () => { actions.quit() } },
  ]
}

/**
 * Create the application tray icon.
 * @param options - platform, icon path, current locale, and the actions the menu exposes.
 * @returns tray handle; `update` also installs the menu that right-click and macOS clicks open.
 */
export function createDesktopTray(options: {
  readonly platform: NodeJS.Platform
  readonly iconPath: string
  readonly locale: () => DesktopLocale
  readonly actions: DesktopTrayActions
}): DesktopTray {
  const image = nativeImage.createFromPath(options.iconPath)
  if (image.isEmpty()) console.error(`desktop tray: no icon at ${options.iconPath}`)
  // Windows scales the packaged icon itself; the macOS and Linux menu bar needs an explicit small size.
  const tray = new Tray(options.platform === 'win32' ? image : image.resize({ width: 16, height: 16 }))
  // The macOS context menu owns every click, so the icon never toggles the window directly there.
  if (options.platform !== 'darwin') tray.on('click', () => { options.actions.toggleWindow() })
  return {
    update(status) {
      const locale = options.locale()
      tray.setToolTip(status.activeTasks === true ? locale.messages.trayTooltipAgentsRunning : locale.messages.trayTooltip)
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(locale, status, options.actions)))
    },
    dispose() { tray.destroy() },
  }
}
