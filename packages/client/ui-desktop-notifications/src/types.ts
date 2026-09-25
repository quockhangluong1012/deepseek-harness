/** Type-only Electron bridge declarations shared by the desktop shell and this plugin. */

/** One OS notification request. A second `show` for the same `id` replaces the first. */
export interface DesktopNotificationRequest {
  /** Caller-chosen identity; also the value handed back by {@link DesktopNotificationBridge.onClick}. */
  readonly id: string
  readonly title: string
  readonly body: string
}

/** Origin-scoped operations; no Electron objects cross this interface. */
export interface DesktopNotificationBridge {
  /** Show or replace the notification for `request.id`; fire-and-forget. */
  show(request: DesktopNotificationRequest): void
  /** Withdraw the notification for `id`, if still visible; fire-and-forget, idempotent. */
  withdraw(id: string): void
  /** @param listener - receives the `id` of every clicked notification shown through this bridge. @returns unsubscribe callback. */
  onClick(listener: (id: string) => void): () => void
}
