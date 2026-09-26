/** Save original startup diagnostics while keeping the terminal report concise. */

import { randomUUID } from 'node:crypto'
import { mkdir, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import type { StartupError } from '@deepseek-ai/dsh-app-boot'

/** Launcher-owned context; no environment values or plugin configurations are collected. */
interface StartupDiagnosticContext {
  home: string
  version: string
  profile: string
}

/** Outcome of one startup check: working, working with a caveat, or no data. */
type StartupCheckStatus = 'ok' | 'degraded' | 'unavailable'

/** One startup check, carrying the deployment fact it reports and the observation behind it. */
interface StartupCheck {
  readonly id: 'sandbox' | 'provider-keys' | 'mcp' | 'lsp' | 'disk'
  readonly status: StartupCheckStatus
  readonly detail: string
}

/** Free space on the volume that holds the Harness home. */
async function homeVolumeCheck(home: string): Promise<StartupCheck> {
  try {
    const stats = await statfs(home)
    return { id: 'disk', status: 'ok', detail: `${String(stats.bavail * stats.bsize)} bytes free on ${home}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { id: 'disk', status: 'unavailable', detail: `the harness-home volume could not be read: ${message}` }
  }
}

/**
 * Check what a failed boot can still observe. The harness-home volume is
 * reachable without a plugin tree; every other check names the service the
 * failure left unreachable rather than claiming a result it cannot observe.
 * @param home - resolved Harness home whose volume is measured.
 * @returns one check per doctor fact: sandbox, provider keys, MCP, LSP, then disk.
 */
async function startupChecks(home: string): Promise<StartupCheck[]> {
  return [
    { id: 'sandbox', status: 'unavailable', detail: 'no plugin tree: startup failed before sandboxPolicy was reachable' },
    { id: 'provider-keys', status: 'unavailable', detail: 'no plugin tree: startup failed before the llm registry was reachable' },
    { id: 'mcp', status: 'unavailable', detail: 'no plugin tree: startup failed before the tool registry was reachable' },
    { id: 'lsp', status: 'unavailable', detail: 'no plugin tree: startup failed before the lsp service was reachable' },
    await homeVolumeCheck(home),
  ]
}

/** Wait for stderr to finish the write before the failed process exits. */
function writeStderr(text: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  process.stderr.write(text, (error) => {
    if (error) reject(error)
    else resolve()
  })
  return promise
}

/**
 * Print the startup summary and save a private, uniquely named report under DSH_HOME/logs.
 * Failed writes print the complete report to stderr instead of claiming a saved path.
 * @param error - startup audit failure retaining plugin metadata and original errors.
 * @param context - resolved Harness home, application version, and selected profile.
 * @param write - terminal output sink; awaited before returning, defaults to stderr.
 * @returns after saving or printing the report and completing terminal writes.
 */
export async function reportStartupFailure(
  error: StartupError,
  context: StartupDiagnosticContext,
  write: (text: string) => void | Promise<void> = writeStderr,
): Promise<void> {
  const now = new Date().toISOString()
  await write(`${error.message}\n`)
  const report = 'WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.\n\n' + inspect({
    timestamp: now,
    dshVersion: context.version,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    profile: context.profile,
    doctor: await startupChecks(context.home),
    error,
  }, {
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    showHidden: true,
    customInspect: false,
    getters: false,
    colors: false,
  }) + '\n'
  const logDir = join(context.home, 'logs')
  const logPath = join(logDir, `startup-${now.replaceAll(':', '-')}-${randomUUID()}.log`)
  try {
    await mkdir(logDir, { recursive: true, mode: 0o700 })
    await writeFile(logPath, report, { flag: 'wx', mode: 0o600 })
  } catch (writeError) {
    await write(`\ndsh: warning: could not write startup diagnostics: ${String(writeError)}\nFull diagnostics:\n${report}`)
    return
  }
  await write(`\nFull diagnostics: ${logPath}\n`)
}
