/**
 * Execute command hooks through `ctx.shell`, using its credential scrub,
 * process-group cancellation, and timeout machinery. The bridge supplies the
 * trusted stdin payload and dialect environment, then this module decodes the
 * captured outcome.
 * @module @deepseek-ai/dsh-hook-protocol/runner
 */

import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { parseHookBody, parseHookOutput } from './codec.ts'
import type { CommandHook, HookHandler, HookOutput, HttpHook } from './types.ts'

/**
 * The reference default per-hook timeout, in ms (10 minutes) — the value both
 * Claude Code and Codex apply to a hook whose config sets no `timeout`. It
 * lives here, once, as the protocol's default; the bridges' `defaultTimeoutMs`
 * config defaults to it, and a per-hook {@link CommandHook.timeoutSec} is the
 * override API.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000

/** Everything a single hook invocation needs beyond its command line. */
export interface RunHookOptions {
  /** The JSON payload the bridge builds: the hook's stdin (command) or POST body (HTTP). */
  payload: unknown
  /** Extra env vars for the hook process (`CLAUDE_PROJECT_DIR`, …); the bridge builds these. */
  env?: Record<string, string>
  /** Working directory for the hook (defaults to the executor's own default when omitted). */
  cwd?: string
  /** Explicit owning-operation signal; firing it cancels the hook run. */
  readonly signal: AbortSignal
  /** Whether to append a trailing newline to the stdin payload (CC yes, Codex no). */
  trailingNewline: boolean
  /**
   * Timeout applied when the hook's config sets no `timeout` of its own. The
   * bridge owns the default (its `defaultTimeoutMs` config, reference default
   * {@link DEFAULT_HOOK_TIMEOUT_MS}) and passes it in explicitly.
   */
  defaultTimeoutMs: number
  /**
   * The event this hook is firing for (e.g. `'PreToolUse'`). When set, a
   * structured `hookSpecificOutput` block whose `hookEventName` names a DIFFERENT
   * event is treated as malformed and its event-scoped fields are discarded (see
   * {@link parseHookOutput}). Omit it to apply any block as-is.
   */
  expectedEventName?: string
}

/** The {@link HookOutput} plus the wall-clock duration of the run (for `hook/result`). */
export interface RunHookResult {
  output: HookOutput
  /** Wall-clock duration of the run, from `now` — durable on the `hook/result` event. */
  durationMs: number
}

/**
 * Run one configured hook — a shell command through the executor, or an HTTP
 * endpoint — and decode its outcome. A hook-specific timeout in seconds
 * overrides the default. A command hook that cannot run is a NON-BLOCKING
 * error (no exit code, the failure on stderr); an HTTP transport fault FAILS
 * CLOSED (a `deny` decision plus {@link HookOutput.transportError}), so a
 * hook endpoint that errors never silently allows the action. Neither
 * transport throws, so a hook can never crash the calling turn.
 * @param bash - The executor service command hooks run through.
 * @param hook - the configured handler; its `timeoutSec` (wire unit: seconds) overrides the default timeout.
 * @param options - the invocation's payload, env, cwd, signal, stdin framing, and default timeout.
 * @param now - millisecond clock used for the reported duration.
 * @returns the decoded output plus the run's wall-clock duration.
 */
export async function runHook(
  bash: Pick<ShellExecutor, 'resolve' | 'execute'>,
  hook: HookHandler,
  options: RunHookOptions,
  now: () => number,
): Promise<RunHookResult> {
  const started = now()
  return isHttpHook(hook)
    ? await runHttpHook(hook, options, started, now)
    : await runCommandHook(bash, hook, options, started, now)
}

/** Whether a configured handler is the HTTP transport (`url`) rather than a command line. */
export function isHttpHook(hook: HookHandler): hook is HttpHook {
  return 'url' in hook
}

/** The per-hook timeout: a hook's own seconds override the bridge's default. */
function timeoutMsOf(hook: CommandHook | HttpHook, defaultTimeoutMs: number): number {
  // The wire unit is seconds and unvalidated at the bridges: a missing,
  // non-positive, or non-finite value falls back to the default rather than
  // arming a degenerate (instant or effectively infinite) timeout.
  return hook.timeoutSec !== undefined && Number.isFinite(hook.timeoutSec) && hook.timeoutSec > 0
    ? hook.timeoutSec * 1000
    : defaultTimeoutMs
}

/** Run one command hook through the executor and decode its exit code and streams. */
async function runCommandHook(
  bash: Pick<ShellExecutor, 'resolve' | 'execute'>,
  hook: CommandHook,
  options: RunHookOptions,
  started: number,
  now: () => number,
): Promise<RunHookResult> {
  const request = {
    command: hook.command,
    timeoutMs: timeoutMsOf(hook, options.defaultTimeoutMs),
    // The dialect's stdin framing: CC appends a trailing newline, Codex does not.
    stdin: JSON.stringify(options.payload) + (options.trailingNewline ? '\n' : ''),
    signal: options.signal,
    ...options.cwd !== undefined ? { workdir: options.cwd } : {},
    ...options.env !== undefined ? { env: options.env } : {},
  }

  try {
    const result = await (await bash.execute(bash.resolve(request))).result()
    // ShellRunResult.exitCode is `number | null` (null = died by signal); the
    // protocol's exit-code contract is numeric, so a signal death maps to
    // `undefined` (a non-blocking error — no clean exit code to act on).
    const exitCode = result.exitCode ?? undefined
    return {
      output: parseHookOutput(exitCode, result.stdout.text, result.stderr.text, options.expectedEventName),
      durationMs: now() - started,
    }
  } catch (error: unknown) {
    // The executor rejects only on infrastructure faults (unusable workdir,
    // missing shell). A hook that cannot run is a non-blocking error: no exit
    // code, the failure on stderr for the record. The turn proceeds.
    const message = describeError(error)
    return {
      output: parseHookOutput(undefined, '', message),
      durationMs: now() - started,
    }
  }
}

/**
 * POST the payload to an HTTP hook endpoint and decode the response body like a
 * command hook's clean-exit stdout. Every transport fault is FAIL-CLOSED: the
 * returned outcome denies with the failure as its reason and names it in
 * {@link HookOutput.transportError}. A caller abort is not a fault — the run
 * that owned the hook is already gone, so the outcome stays empty.
 */
async function runHttpHook(
  hook: HttpHook,
  options: RunHookOptions,
  started: number,
  now: () => number,
): Promise<RunHookResult> {
  // The bound covers the whole exchange: connect, request body, and response read.
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMsOf(hook, options.defaultTimeoutMs))])
  let body: string
  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...hook.headers },
      body: JSON.stringify(options.payload) + (options.trailingNewline ? '\n' : ''),
      signal,
    })
    if (!response.ok) {
      return failClosedHook(`http hook endpoint ${hook.url} returned HTTP ${response.status}`, started, now)
    }
    body = await response.text()
  } catch (error: unknown) {
    if (options.signal.aborted) {
      return { output: { exitCode: undefined, stderr: '', stdout: '' }, durationMs: now() - started }
    }
    return failClosedHook(`http hook request to ${hook.url} failed: ${describeError(error)}`, started, now)
  }
  return { output: parseHookBody(body, options.expectedEventName), durationMs: now() - started }
}

/**
 * Build the fail-closed outcome one HTTP transport fault produces: no exit
 * code, the failure on stderr, a `deny` decision whose reason is the failure,
 * and the transport marker the durable result records.
 */
function failClosedHook(message: string, started: number, now: () => number): RunHookResult {
  const output: HookOutput = {
    exitCode: undefined,
    stderr: message,
    stdout: '',
    decision: 'deny',
    reason: message,
    transportError: message,
  }
  return { output, durationMs: now() - started }
}

/** Human-readable failure text, including the wrapped cause a failed fetch carries. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
}
