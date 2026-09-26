/**
 * The ACP client terminal as a `ctx.shell` provider: every model-visible
 * command in a routed ACP session runs in the client's own terminal through
 * `terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
 * `terminal/kill`, and `terminal/release` instead of a harness-owned process.
 *
 * The provider extends the local executor so the composition's local behavior
 * stays available as the fallback: a client that advertises no `terminal`
 * capability (`ClientCapabilities.terminal`), a call carrying `stdin` (ACP
 * defines no terminal input method), and a call that cannot be attributed to
 * exactly one ACP session all stay local. Because the client owns the process,
 * the delegated command is not confined by the harness's sandbox; a deployment
 * that needs confinement keeps the sandboxed local executor instead.
 *
 * @module @deepseek-ai/dsh-acp/client-shell
 */

import { LocalBashExecutor, ENV_OVERRIDES } from '@deepseek-ai/dsh-bash-local'
import type {
  CollectedOutput,
  ShellExecSpec,
  ShellExecution,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  SubprocessOutputRead,
  SubprocessOutputReader,
} from '@deepseek-ai/dsh-shell'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AcpTerminalHandle } from './client.ts'

/** How often the provider refreshes its captured view of the client terminal. */
const POLL_INTERVAL_MS = 200

/** The client terminal's retained output for one execution, as one stream. */
class TerminalCapture {
  private buffer = Buffer.alloc(0)
  /** Whole-stream byte offset of `buffer[0]`; grows when the client drops its head. */
  private retainedStart = 0
  private clientTruncated = false
  private cursor = 0

  /** Replace the captured view with one `terminal/output` observation. */
  set(output: string, truncated: boolean): void {
    const next = Buffer.from(output, 'utf8')
    if (next.length >= this.buffer.length && next.subarray(0, this.buffer.length).equals(this.buffer)) {
      this.buffer = next
    } else {
      // The client truncates from the beginning, so a non-prefix view means
      // retained bytes slid out of the window and their offsets are gone.
      this.retainedStart += this.buffer.length
      this.buffer = next
    }
    this.clientTruncated = truncated
  }

  /** Read everything after whole-stream byte `fromByte`. */
  readFrom(fromByte: number): SubprocessOutputRead {
    const byteLength = this.buffer.length
    const nextOffset = this.retainedStart + byteLength
    if (fromByte < this.retainedStart) {
      return { text: this.buffer.toString('utf8'), nextOffset, lossy: true }
    }
    return { text: this.buffer.subarray(fromByte - this.retainedStart).toString('utf8'), nextOffset, lossy: false }
  }

  /** Consume everything produced since the previous consuming read. */
  consume(): ShellProcessRead {
    const read = this.readFrom(this.cursor)
    this.cursor = read.nextOffset
    return { delta: read.text, lossy: read.lossy }
  }

  /** The settled projection of this stream. */
  collected(): CollectedOutput {
    return {
      text: this.readFrom(this.retainedStart).text,
      truncated: this.clientTruncated || this.retainedStart > 0,
    }
  }
}

/** A reader that never sees bytes — the empty stream paired with a merged capture. */
const EMPTY_READER: SubprocessOutputReader = {
  readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }),
}

/**
 * Registers as `ctx.shell` and runs each routable command in the connected ACP
 * client's terminal; other commands keep the inherited local execution.
 * Requires `ctx.acpClient` in addition to the local executor's `ctx.subprocess`.
 */
export default class AcpClientShellExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'acpClient']

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const client = this.ctx.acpClient
    const sessionId = client.clientCapabilities.terminal ? client.sessionForEnv(spec.dshEnv) : undefined
    if (sessionId === undefined || spec.stdin !== undefined) return super.execute(spec)
    return this.executeOnClient(sessionId, spec)
  }

  /** Run one command in the client terminal named by the execution's session. */
  private async executeOnClient(sessionId: SessionId, spec: ShellExecSpec): Promise<ShellExecution> {
    // One fused deadline: the timer's own reason identifies a timeout, so a
    // caller abort that won the race is never misreported as one.
    const timeoutReason = new Error('ACP terminal deadline expired')
    const timeoutController = new AbortController()
    const timer = spec.onExpiry === 'kill'
      ? setTimeout(() => { timeoutController.abort(timeoutReason) }, spec.timeoutMs)
      : undefined
    const fused = spec.signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([spec.signal, timeoutController.signal])
    const disarm = (): void => { clearTimeout(timer) }

    let terminal: AcpTerminalHandle
    try {
      if (fused.aborted) throw fused.reason
      terminal = await this.ctx.acpClient.createTerminal({
        sessionId,
        command: 'bash',
        args: ['-c', spec.command],
        env: Object.entries({ ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv })
          .map(([name, value]) => ({ name, value })),
        cwd: spec.workdir,
        outputByteLimit: spec.stdoutMaxBytes,
      })
    } catch (error: unknown) {
      disarm()
      // A cancelled preparation is the caller's failure, not a provider one.
      if (fused.aborted) throw fused.reason
      return this.failedExecution(error)
    }

    const capture = new TerminalCapture()
    let status: ShellProcessStatus = 'running'
    let exitCode: number | null = null
    let signal: NodeJS.Signals | null = null
    let refreshing = false
    const killed = (): void => {
      status = 'killed'
      void terminal.kill().catch(() => {
        this.ctx.logger.warn(`acp: terminal/kill failed for session ${sessionId}`)
      })
    }
    const onAbort = (): void => { killed() }
    fused.addEventListener('abort', onAbort, { once: true })
    const poll = setInterval(() => {
      if (refreshing) return
      refreshing = true
      void terminal.currentOutput()
        .then((output) => { capture.set(output.output, output.truncated) })
        .catch(() => { /* a client that stopped answering output keeps the last view */ })
        .finally(() => { refreshing = false })
    }, POLL_INTERVAL_MS)
    poll.unref()

    const settle = async (): Promise<void> => {
      clearInterval(poll)
      fused.removeEventListener('abort', onAbort)
      disarm()
      try {
        const output = await terminal.currentOutput()
        capture.set(output.output, output.truncated)
      } catch { /* retained view stands */ }
      await terminal.release().catch(() => {
        this.ctx.logger.warn(`acp: terminal/release failed for session ${sessionId}`)
      })
    }

    const wait = terminal.waitForExit().then(
      (outcome) => {
        // ACP reports the terminating signal only when one ended the process,
        // so an absent signal is a normal exit, not a kill.
        const reportedSignal = outcome.signal ?? null
        status = fused.aborted || reportedSignal !== null ? 'killed' : 'completed'
        exitCode = outcome.exitCode ?? null
        signal = reportedSignal as NodeJS.Signals | null
      },
      (error: unknown) => {
        status = 'killed'
        return Promise.reject(new Error(`ACP terminal wait failed: ${String(error)}`, { cause: error }))
      },
    )
    const done = wait.then(settle, async (error: unknown) => {
      await settle()
      throw error
    })

    let resultPromise: Promise<ShellRunResult> | undefined
    const proc: ShellExecution = {
      get status(): ShellProcessStatus { return status },
      get exitCode(): number | null { return exitCode },
      get signal(): NodeJS.Signals | null { return signal },
      observed: { stdout: { readFrom: fromByte => capture.readFrom(fromByte) }, stderr: EMPTY_READER },
      done: done.then(() => undefined, () => undefined),
      readOutput: () => capture.consume(),
      kill: () => {
        if (status !== 'running') return false
        killed()
        return true
      },
      result: () => {
        resultPromise ??= (async (): Promise<ShellRunResult> => {
          try {
            await done
          } catch (error: unknown) {
            throw new Error(`ACP terminal execution failed: ${String(error)}`, { cause: error })
          }
          const timedOut = fused.reason === timeoutReason
          return {
            exitCode,
            signal,
            timedOut,
            aborted: fused.aborted && !timedOut,
            timeoutMs: spec.timeoutMs,
            stdout: capture.collected(),
            stderr: { text: '', truncated: false },
          }
        })()
        return resultPromise
      },
    }
    return proc
  }

  /** The seam's settled-killed shape for a terminal the client never created. */
  private failedExecution(error: unknown): ShellExecution {
    const note = `terminal/create failed: ${String(error)}`
    const reader: SubprocessOutputReader = {
      readFrom: (fromByte) => {
        const bytes = Buffer.from(note, 'utf8')
        return {
          text: bytes.subarray(Math.min(fromByte, bytes.length)).toString('utf8'),
          nextOffset: bytes.length,
          lossy: false,
        }
      },
    }
    let read = false
    return {
      status: 'killed',
      exitCode: null,
      signal: null,
      observed: { stdout: reader, stderr: EMPTY_READER },
      done: Promise.resolve(),
      readOutput: () => {
        if (read) return { delta: '', lossy: false }
        read = true
        return { delta: note, lossy: false }
      },
      kill: () => false,
      result: () => Promise.reject(new Error(note, { cause: error })),
    }
  }
}
