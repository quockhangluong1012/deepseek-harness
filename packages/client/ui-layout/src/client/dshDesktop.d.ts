/**
 * Ambient contract for the Electron desktop titlebar bridge the frameless
 * shell exposes on `window.dshDesktop.window`. The desktop application owns the
 * concrete shape (`apps/desktop/src/ipc.ts`); this declaration is the browser
 * half of that contract so the shared web client type-checks the optional
 * bridge without importing desktop-only code. The bridge is absent in a plain
 * browser and on macOS, so every consumer feature-detects `available`.
 */
declare global {
  /** Window titlebar controls exposed by a frameless desktop shell renderer. */
  interface DshDesktopWindowControls {
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

  interface Window {
    /** Narrow desktop shell bridge; present only inside the Electron shell. */
    readonly dshDesktop?: {
      readonly protocolVersion: 1
      /** Custom titlebar controls; absent on macOS and shell recovery documents. */
      readonly window?: DshDesktopWindowControls
    }
  }
}

export {}
