/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopPluginRecord } from './project-manager.ts'
import type { DesktopLocale } from './locale.ts'
import type { DesktopBackendState } from './backend-controller.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  localeGet: 'dsh-desktop:locale-get',
  pluginsList: 'dsh-desktop:plugins-list',
  pluginsAdd: 'dsh-desktop:plugins-add',
  pluginsRemove: 'dsh-desktop:plugins-remove',
  pluginsUpdate: 'dsh-desktop:plugins-update',
  pluginsToggle: 'dsh-desktop:plugins-toggle',
  pluginsDisableAll: 'dsh-desktop:plugins-disable-all',
  backendStatus: 'dsh-desktop:backend-status',
  backendRetry: 'dsh-desktop:backend-retry',
  applicationRestart: 'dsh-desktop:application-restart',
  configurationReset: 'dsh-desktop:configuration-reset',
  backendState: 'dsh-desktop:backend-state',
  updatesCheck: 'dsh-desktop:updates-check',
  updatesInstall: 'dsh-desktop:updates-install',
  updatesState: 'dsh-desktop:updates-state',
  updatesVersion: 'dsh-desktop:updates-version',
  windowMinimize: 'dsh-desktop:window-minimize',
  windowToggleMaximize: 'dsh-desktop:window-toggle-maximize',
  windowClose: 'dsh-desktop:window-close',
  windowIsMaximized: 'dsh-desktop:window-is-maximized',
  windowMaximizedState: 'dsh-desktop:window-maximized-state',
} as const

/**
 * Window titlebar controls exposed to the frameless desktop application
 * renderer. Present on supported non-macOS shells; the web titlebar renders
 * only when this bridge is available.
 */
export interface DshDesktopWindowControls {
  /** Whether the owning shell installs a custom titlebar control bridge. */
  readonly available: true
  /** Query the window's current maximized state. */
  isMaximized(): Promise<boolean>
  /** Minimize the window. */
  minimize(): Promise<void>
  /** Toggle maximize/restore. */
  toggleMaximize(): Promise<void>
  /** Close the window. */
  close(): Promise<void>
  /**
   * Subscribe to maximized-state changes.
   * @param listener - called with the new maximized state after a change.
   * @returns disposal that unsubscribes the listener.
   */
  subscribe(listener: (maximized: boolean) => void): () => void
}

/** Desktop release update state rendered by desktop-owned UI. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
  /** Download progress percentage while `phase` is `installing`. */
  readonly percent?: number
}

/** Narrow bridge exposed through context isolation. */
export interface DshDesktopApi {
  readonly protocolVersion: 1
  locale(): Promise<DesktopLocale>
  readonly plugins: {
    list(): Promise<readonly DesktopPluginRecord[]>
    add(spec: string): Promise<void>
    remove(name: string): Promise<void>
    update(name: string, version: string): Promise<void>
    toggle(name: string, enabled: boolean): Promise<void>
    disableAll(): Promise<void>
  }
  readonly backend: {
    status(): Promise<DesktopBackendState>
    retry(): Promise<void>
    subscribe(listener: (state: DesktopBackendState) => void): () => void
  }
  readonly updates: {
    check(): Promise<DesktopUpdateState>
    install(): Promise<void>
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
    /** Exact version of the running packaged shell (and its bound dsh). */
    version(): Promise<string>
  }
  /**
   * Custom titlebar window controls. Absent on platforms that keep the native
   * frame (macOS), so the renderer feature-detects `window.dshDesktop.window`.
   */
  readonly window?: DshDesktopWindowControls
}

/** Startup-page controls, unavailable to backend-provided application documents. */
export interface DshDesktopStartupApi extends Pick<DshDesktopApi, 'protocolVersion' | 'locale'> {
  readonly backend: Omit<DshDesktopApi['backend'], 'retry'>
  disablePlugins(): Promise<void>
  restart(): Promise<void>
  resetConfiguration(): Promise<void>
}
