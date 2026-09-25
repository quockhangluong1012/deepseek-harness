/** Fire-and-forget notification requests plus one main-process click subscription per window. */
import { ipcRenderer } from 'electron'
import type { DesktopNotificationBridge } from '@deepseek-ai/dsh-client-ui-desktop-notifications/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns notification operations that expose neither IPC nor Electron objects. */
export function createDesktopNotificationBridge(): DesktopNotificationBridge {
  const listeners = new Set<(id: string) => void>()
  ipcRenderer.on(DESKTOP_IPC.notificationsClicked, (_event, id: unknown) => {
    if (typeof id !== 'string') return
    for (const listener of [...listeners]) {
      try { listener(id) }
      catch (error) { console.error('Desktop notification click handler failed', error) }
    }
  })
  return {
    show: (request) => {
      void ipcRenderer.invoke(DESKTOP_IPC.notificationsShow, request.id, request.title, request.body)
    },
    withdraw: (id) => { void ipcRenderer.invoke(DESKTOP_IPC.notificationsWithdraw, id) },
    onClick(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
