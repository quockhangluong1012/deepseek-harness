/** Desktop application menus built from shell-owned locale copy. */

import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopMessages } from './locale.ts'

/**
 * Callbacks behind the application-owned menu entries.
 */
export interface DesktopMenuHandlers {
  /** Open the desktop plugin-management window. */
  openPlugins(): void
  /** Run one manual update check with user-facing dialogs. */
  checkUpdates(): void
}

/**
 * Build the application menu template. Editing roles carry their platform
 * labels from Electron; only the top-level menus use shell-owned copy.
 * Developer tooling stays visible in unpackaged development only.
 * @param applicationLabel - first-menu label (the bundle name on macOS).
 * @param messages - shell-owned locale dictionary for top-level menu labels.
 * @param packaged - whether plugin management is available (packaged builds).
 * @param handlers - callbacks for the application-owned menu entries.
 * @returns menu template for `Menu.buildFromTemplate`.
 */
export function buildDesktopMenu(
  applicationLabel: string,
  messages: DesktopMessages,
  packaged: boolean,
  handlers: DesktopMenuHandlers,
): MenuItemConstructorOptions[] {
  return [
    {
      label: applicationLabel,
      submenu: [
        {
          label: packaged ? messages.pluginsMenu : messages.pluginsMenuPackagedOnly,
          accelerator: 'CmdOrCtrl+,',
          enabled: packaged,
          click: () => { handlers.openPlugins() },
        },
        { label: messages.checkUpdatesMenu, click: () => { handlers.checkUpdates() } },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: messages.editMenu,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: messages.viewMenu,
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'toggleDevTools', visible: !packaged },
      ],
    },
    {
      label: messages.windowMenu,
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ]
}
