/**
 * Development-only renderer reload for the Desktop Host: the watch row the
 * workspace composition mounts, and the artifact observation the Host runs to
 * tell the Electron shell when to reload its window. The Desktop transport
 * carries no `/plugins/events` SSE channel, so a rebuilt client bundle reaches
 * the page through a window reload rather than an in-page fiber swap.
 */

import { statSync } from 'node:fs'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Cordis row id of the watch-only reload row the workspace composition mounts. */
export const DEVELOPMENT_WATCH_ROW_ID = 'client-hmr-watch'

/** Published subpath providing the watch-only half of the client HMR package. */
const DEVELOPMENT_WATCH_ROW = '@deepseek-ai/dsh-client-hmr/watch'

/** Shell document stat-poll interval in milliseconds (the build-side watcher's polling default). */
const SHELL_POLL_INTERVAL_MS = 500

/**
 * Composition layer mounting the reload row for workspace development.
 * @returns the patch layer appended to the desktop composition.
 */
export function developmentWatchLayer(): PatchOptions[] {
  return [{ insert: [{ id: DEVELOPMENT_WATCH_ROW_ID, name: DEVELOPMENT_WATCH_ROW }] }]
}

/** Renderer artifacts the Host can observe for a reload. */
export interface RendererArtifactSources {
  /** Absolute path of the shell index document served over the custom protocol. */
  readonly shellIndex: string
  /**
   * Subscribe to client-bundle rebuilds.
   * @param listener - called once per rebuilt bundle.
   * @returns the unsubscriber.
   */
  readonly subscribeToRebuilds: (listener: () => void) => () => void
}

interface ShellStat {
  readonly mtimeMs: number
  readonly size: number
}

/** Read the shell document's reload-relevant metadata, or undefined while the file is absent. */
function shellStat(path: string): ShellStat | undefined {
  try {
    const stat = statSync(path)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function sameShellStat(left: ShellStat | undefined, right: ShellStat | undefined): boolean {
  return left?.mtimeMs === right?.mtimeMs && left?.size === right?.size
}

/**
 * Report every renderer artifact change: a rewrite of the shell index document
 * or a client-bundle rebuild. Polling by design: the development watcher writes
 * both outside this process, and network mounts deliver no inotify events.
 * @param sources - shell document path and bundle rebuild subscription.
 * @param onRebuilt - called once per observed change.
 * @returns disposer that stops the poll and the rebuild subscription.
 */
export function watchRendererArtifacts(
  sources: RendererArtifactSources,
  onRebuilt: () => void,
): () => void {
  const notify = (): void => {
    try {
      onRebuilt()
    } catch {
      // The reload hint is advisory: a shell already stopping cannot receive
      // it, and the shell's own teardown reports the failure that matters.
    }
  }
  let shell = shellStat(sources.shellIndex)
  const timer = setInterval(() => {
    const current = shellStat(sources.shellIndex)
    if (sameShellStat(shell, current)) return
    shell = current
    notify()
  }, SHELL_POLL_INTERVAL_MS)
  timer.unref()
  const unsubscribe = sources.subscribeToRebuilds(notify)
  return () => {
    clearInterval(timer)
    unsubscribe()
  }
}
