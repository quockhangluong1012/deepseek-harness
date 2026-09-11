/**
 * Watch-only half of the dev reload chain, for compositions whose transport
 * carries no `/plugins/events` channel: the Electron Desktop Host mounts this
 * row in development and reloads its window when a bundle rebuild reaches
 * `clientModules`, while the browser composition mounts `client-hmr` for the
 * SSE channel and the in-page swap.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installBundleWatch } from './bundle-watch.ts'

/** Cordis plugin name. */
export const name = 'client-hmr-watch'

/** Required service: the web plugin table that owns bundle revisions. */
export const inject = ['clientModules']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(1).default(500),
})

/**
 * Mount the bundle watch without a notification channel.
 * @param ctx - plugin context with the client module table available.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the field is set after validation.
  installBundleWatch(ctx, config.pollIntervalMs as number)
}
