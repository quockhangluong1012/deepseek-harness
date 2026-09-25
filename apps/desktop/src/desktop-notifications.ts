/** Best-effort background OS notifications; never grants approval or answers a question by itself. */
import { Notification } from 'electron'

/** One process-wide OS-notification broker: shows/withdraws native notifications by caller id, and reports clicks. */
export class DesktopNotifications {
  private readonly live = new Map<string, Notification>()

  /** @param platform - Native support probe, replaceable for platform tests. */
  constructor(private readonly platform: string = process.platform) {}

  /**
   * Show or replace the notification for `id`.
   * @param id - Caller-chosen identity; a second `show` for the same id replaces it.
   * @param title - Native notification title.
   * @param body - Native notification body.
   * @param onClick - Invoked with `id` when the user clicks the shown notification.
   */
  show(id: string, title: string, body: string, onClick: (id: string) => void): void {
    this.withdraw(id)
    try {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      this.live.set(id, notification)
      notification.on('failed', () => {
        if (this.live.get(id) === notification) this.live.delete(id)
        notification.removeAllListeners()
      })
      notification.once('click', () => {
        if (this.live.get(id) !== notification) return
        this.live.delete(id)
        notification.removeAllListeners()
        onClick(id)
      })
      notification.show()
    } catch (error) { console.warn(`desktop notifications: notification unavailable (${this.platform})`, error) }
  }

  /** Release one owned notification without invoking its click callback; idempotent. */
  withdraw(id: string): void {
    const notification = this.live.get(id)
    if (notification === undefined) return
    this.live.delete(id)
    notification.removeAllListeners()
    try { notification.close() }
    catch (error) { console.warn('desktop notifications: could not close notification', error) }
  }

  /** Release every owned notification, e.g. on shutdown. */
  disposeAll(): void {
    for (const id of [...this.live.keys()]) this.withdraw(id)
  }
}
