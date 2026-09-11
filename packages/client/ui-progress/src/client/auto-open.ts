/**
 * When the progress panel reveals itself.
 *
 * The right Sidebar ships collapsed, holding a guide tab, and a reader opens
 * what they need; a reload returns every Session to that default. The one
 * exception is a Session whose agent is working: the panel opens itself once
 * that Session has something to report — a standing checklist or a produced
 * file — so the first sign of work is visible without hunting for the
 * affordance.
 *
 * Two facts gate the reveal. Progress alone is not enough, because a Session
 * that is merely opened carries whatever its history holds, and the column is
 * not supposed to open for history. The agent must have been running while
 * this Session was on screen; that latch is what tells live work apart from
 * loaded records. The reveal then happens once per Session: a panel the reader
 * collapsed again is not reopened, and progress that lands while another
 * Session is on screen gathers no latch and reveals nothing.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One Session's live subscription. */
export interface ProgressFollow {
  /**
   * Whether this Session's agent has been running since the follow began.
   * @returns whether the Session is running now.
   */
  isRunning(): boolean
  /**
   * Whether this Session has a standing checklist or a produced file.
   * @returns whether progress exists right now.
   */
  hasProgress(): boolean
  /** Stop following. */
  dispose(): void
}

/** The live facts the reveal reads, and the one command it issues. */
export interface RevealWatch {
  /**
   * The Session on screen.
   * @returns the selected Session, or undefined while none is selected.
   */
  current(): SessionId | undefined
  /**
   * Subscribe to the current selection changing.
   * @param listener - called after the selection store commits.
   * @returns the unsubscribe function.
   */
  onSelection(listener: () => void): () => void
  /**
   * Follow one Session's running state and progress.
   * @param sessionId - the Session to follow.
   * @param onChange - called on every change of those facts.
   * @returns the subscription, or undefined while that Session has no live
   *   client binding, in which case the next selection change tries again.
   */
  follow(sessionId: SessionId, onChange: () => void): ProgressFollow | undefined
  /** Open and expand the panel on the Session on screen. */
  reveal(): void
}

/**
 * Reveal the panel once per Session, at its first progress under a running agent.
 * @param watch - the live facts to read and the command to issue.
 * @returns the disposer that releases the selection subscription and the
 *   followed Session.
 */
export function revealOnProgress(watch: RevealWatch): () => void {
  const revealed = new Set<SessionId>()
  let watched: SessionId | undefined
  let follow: ProgressFollow | undefined
  // Latched per Session: whether its agent ran while it was on screen.
  let live = false
  const unfollow = (): void => {
    follow?.dispose()
    follow = undefined
  }
  const evaluate = (): void => {
    const current = watch.current()
    if (current !== watched) {
      unfollow()
      watched = current
      live = false
    }
    if (current === undefined || revealed.has(current)) return
    follow ??= watch.follow(current, evaluate)
    if (follow === undefined) return
    live ||= follow.isRunning()
    if (!live || !follow.hasProgress()) return
    revealed.add(current)
    // Nothing left to watch for this Session, and a reader who collapses the
    // panel again must not have it reopened by later progress.
    unfollow()
    watch.reveal()
  }
  const off = watch.onSelection(evaluate)
  evaluate()
  return () => {
    off()
    unfollow()
  }
}
