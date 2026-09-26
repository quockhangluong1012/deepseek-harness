/**
 * The command layer of the git tool family: one git or gh command spawned
 * through `ctx.subprocess` with a scrubbed environment, a caller-owned signal,
 * and bounded collected output.
 *
 * Arguments are never shell-interpreted, so the tools need no shell dialect:
 * `argv` reaches the process as written on both POSIX and Windows. The
 * subprocess seam owns environment scrubbing, bounded collection, spill
 * files, managed-range termination, and the exit facts returned here.
 *
 * @module @deepseek-ai/dsh-tool-git/git
 */

import type { Context } from '@deepseek-ai/cordis'
import { throwToolAborted } from '@deepseek-ai/dsh-tools'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { CommandLimits, CommandOutcome, StreamOutput } from './types.ts'

/**
 * Environment every git and gh command receives, merged onto the subprocess
 * seam's scrubbed parent environment. `GIT_CONFIG_COUNT=0` neutralizes any
 * ambient `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pair, `GIT_TERMINAL_PROMPT=0`
 * and `GH_PROMPT_DISABLED=1` fail on a missing credential instead of hanging a
 * tool call on an interactive prompt, and a fixed locale keeps git's output
 * stable enough to read.
 */
const COMMAND_ENV = {
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GH_PROMPT_DISABLED: '1',
  LC_ALL: 'C',
} as const

/**
 * Resolve one tool executable in the composition's execution world, reporting
 * an absent program as a tool error the model can act on instead of a provider
 * class name.
 * @param ctx - the subprocess capability.
 * @param program - `git` or `gh`.
 * @param signal - caller-owned cancellation.
 * @returns the canonical executable path.
 * @throws when this execution world has no such program, or when lookup itself fails.
 */
export async function resolveExecutable(ctx: Context, program: 'git' | 'gh', signal: AbortSignal): Promise<string> {
  try {
    return await ctx.subprocess.resolveExecutable(program, undefined, signal)
  } catch (error: unknown) {
    // A lookup miss is the one failure the model can fix by installing the program.
    if (error instanceof SubprocessExecutableNotFoundError) {
      throw new Error(program === 'git'
        ? 'git is not available in this execution world; install git, or run the command through a shell tool'
        : 'gh is not available in this execution world; install the GitHub CLI (`gh`) and authenticate it, or open the pull request another way')
    }
    throw error
  }
}

/** One fully specified git or gh invocation. */
export interface CommandRequest {
  /** Absolute executable path from {@link resolveExecutable}. */
  executable: string
  /** Arguments in argv order. */
  args: readonly string[]
  /** Absolute working directory the command runs in. */
  cwd: string
  /** Complete stdin payload, or undefined to leave stdin closed. */
  stdin?: string
  /** Per-command budgets. */
  limits: CommandLimits
  /** Caller-owned cancellation; the subprocess seam terminates the managed range when it fires. */
  signal: AbortSignal
}

/**
 * The program name a failure message names, taken from a resolved executable
 * path on either platform: `git`, not `C:\Program Files\Git\cmd\git.exe` or
 * `C:\bin\git.exe`. Both separators are recognized because the path comes from
 * the subprocess seam, and any `.exe` suffix is dropped because Windows reports
 * its own casing (`git.EXE`).
 */
function programName(executable: string): string {
  const file = executable.slice(Math.max(executable.lastIndexOf('/'), executable.lastIndexOf('\\')) + 1)
  return file.replace(/\.exe$/iu, '')
}

/**
 * Run one git or gh command to completion.
 * @param ctx - the subprocess capability.
 * @param request - the resolved command line, working directory, budgets, and cancellation.
 * @returns the exit facts and bounded streams; a nonzero exit is a value, not an error.
 * @throws when the call is cancelled, the process cannot start, or the provider fails to report an outcome.
 */
export async function runCommand(ctx: Context, request: CommandRequest): Promise<CommandOutcome> {
  const label = programName(request.executable)
  if (request.signal.aborted) throwToolAborted()
  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv: [request.executable, ...request.args],
      cwd: request.cwd,
      stdio: {
        stdin: request.stdin === undefined ? 'ignore' : { data: request.stdin },
        stdout: { maxBytes: request.limits.outputMaxBytes, spill: { maxBytes: request.limits.spillMaxBytes } },
        stderr: { maxBytes: request.limits.stderrMaxBytes, spill: { maxBytes: request.limits.spillMaxBytes } },
      },
      graceMs: request.limits.graceMs,
      signal: request.signal,
      env: COMMAND_ENV,
    } satisfies SubprocessSpawnSpec)
  } catch (error: unknown) {
    // Node's spawn throws synchronously for a NUL byte in argv, and the local
    // provider can throw synchronously when the signal aborts between the check
    // above and this call. AbortSignals change state without a static trace, so
    // the re-check stays.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (request.signal.aborted) throwToolAborted()
    throw new Error(`${label} could not start: ${error instanceof Error ? error.message : String(error)}`)
  }
  let outcome: Awaited<SubprocessHandle['done']>
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    throw new Error(`${label} did not report an outcome: ${error instanceof Error ? error.message : String(error)}`)
  }
  // The signal can abort while `done` is awaited; an aborted call must not read
  // as a completed command.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (request.signal.aborted) throwToolAborted()
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  /* v8 ignore start -- collect-mode stdio always publishes both readers. */
  if (stdout === undefined || stderr === undefined) throw new Error(`${label} produced no collected output stream`)
  /* v8 ignore stop */
  const captured = (read: { text: string; lossy: boolean; spillPath?: string }): StreamOutput => ({
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  })
  return { exitCode: outcome.exitCode, signal: outcome.signal, stdout: captured(stdout), stderr: captured(stderr) }
}
