/**
 * Cooperative tool-call timeout enforcer. A tool declares `timeoutMs` and
 * promises to honor `exec.signal`; this wrapper arms that deadline and maps its
 * own expiry to `TOOL_TIMEOUT` without racing or abandoning the tool promise.
 * The package keeps its `@deepseek-ai/dsh-tool-call-timeout-policy` name: it
 * is published and referenced by the shipped bundle, so renaming would break
 * every consumer for no runtime benefit.
 *
 * @module @deepseek-ai/dsh-tool-call-timeout-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * The code owned by this plugin, used BOTH as the internal {@link deadline}
 * classification code AND as the structured error `code` on the replacement
 * tool result. Scoping {@link timeoutOf} to it keeps a nested outer deadline
 * (another `tools/execute` wrapper's timer that fired first) from being misread
 * as this plugin's own timeout — it reads as an ordinary upstream cancel.
 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'timeout-policy'

/** The tool registry service this plugin wraps (`tools/execute`) and reads (`get`). */
export const inject = ['tools']

/** Deployment-bounded fallback deadline for tools that declare no `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Plugin configuration. `defaultTimeoutMs` bounds every tool that omits its
 * own `timeoutMs` so absence is bounded rather than unbounded; per-tool
 * declarations remain overrides.
 */
export interface Config {
  /** Fallback deadline in milliseconds applied when a tool declares none. */
  defaultTimeoutMs?: number
}

/** Runtime configuration schema for the timeout-policy plugin. */
export const Config: z<Config> = z.object({
  defaultTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
})

/**
 * The structured result substituted when this plugin's deadline wins. `content`
 * is the model-facing message; `error.code` is the same {@link TOOL_TIMEOUT}
 * this plugin owns, so a retry/sandbox plugin (and replay) can route on it.
 *
 * @param timeoutMs - the elapsed budget, rendered into the model-facing message.
 * @returns the `isError` {@link ToolExecutionResult} with a `TOOL_TIMEOUT` error.
 */
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  const message = `tool call timed out after ${timeoutMs}ms`
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT } },
  }
}

/**
 * Register the timeout wrapper. It resolves the caller-visible tool definition,
 * falls back to the configured default when the tool declares no budget,
 * temporarily replaces `exec.signal`, delegates, restores the upstream signal,
 * and replaces the result only when this wrapper's own timer fired.
 * @param ctx - Cordis context owning the `tools/execute` waterfall.
 * @param config - validated plugin configuration carrying the default deadline.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new Error(`timeout-policy: defaultTimeoutMs must be a positive finite number, got ${String(defaultTimeoutMs)}.`)
  }
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const definition = ctx.tools.get(exec.name, exec.agent)
    // A tool that declares no natural time bound (it blocks on a human
    // response) is exempt from the deployment fallback too: applying a fixed
    // default here would cancel a legitimate long wait for an answer.
    if (definition?.unboundedTimeout === true) return next()
    const timeoutMs = definition?.timeoutMs ?? defaultTimeoutMs

    using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
    // Swap the derived deadline onto exec for dispatch, then restore the
    // caller's own signal so post-execute listeners never see this plugin's
    // (possibly already-aborted) timeout signal.
    const upstream = exec.signal
    exec.signal = d.signal
    try {
      const result = await next()
      // If OUR timer fired (scoped by code — a nested outer deadline reads as
      // undefined here), the tool/capability saw the abort and reached
      // quiescence; replace whatever it returned (its own abort result) with the
      // structured TOOL_TIMEOUT the model sees.
      if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) {
        return toolTimeoutResult(timeoutMs)
      }
      return result
    } finally {
      exec.signal = upstream
    }
  })
}
