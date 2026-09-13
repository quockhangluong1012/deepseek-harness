/** Startup controls for shell documents; application documents receive the carrier marker plus window controls. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  type DshDesktopStartupApi,
  type DshDesktopWindowControls,
} from './ipc.ts'
import type { DesktopBackendState } from './backend-controller.ts'

const startup: DshDesktopStartupApi = {
  protocolVersion: 1,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as ReturnType<DshDesktopStartupApi['locale']>,
  backend: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus) as ReturnType<DshDesktopStartupApi['backend']['status']>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopBackendState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.backendState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
    },
  },
  disablePlugins: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsDisableAll) as Promise<void>,
  restart: () => ipcRenderer.invoke(DESKTOP_IPC.applicationRestart) as Promise<void>,
  resetConfiguration: () => ipcRenderer.invoke(DESKTOP_IPC.configurationReset) as Promise<void>,
}

// The frameless app document renders the themed web titlebar; its window
// controls are the preload's bridge, gated to the dsh-app://app hostname (the
// web client) so recovery shell documents never show them.
const windowControls: DshDesktopWindowControls = {
  available: true,
  isMaximized: () => ipcRenderer.invoke(DESKTOP_IPC.windowIsMaximized) as Promise<boolean>,
  minimize: () => ipcRenderer.invoke(DESKTOP_IPC.windowMinimize) as Promise<void>,
  toggleMaximize: () => ipcRenderer.invoke(DESKTOP_IPC.windowToggleMaximize) as Promise<void>,
  close: () => ipcRenderer.invoke(DESKTOP_IPC.windowClose) as Promise<void>,
  subscribe(listener) {
    const handle = (_event: Electron.IpcRendererEvent, maximized: boolean): void => { listener(maximized) }
    ipcRenderer.on(DESKTOP_IPC.windowMaximizedState, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.windowMaximizedState, handle) }
  },
}

contextBridge.exposeInMainWorld('dshDesktop',
  location.protocol === 'dsh-app:' && location.hostname === 'shell'
    ? startup
    : location.protocol === 'dsh-app:' && location.hostname === 'app'
      ? { protocolVersion: 1, window: windowControls }
      : { protocolVersion: 1 })
