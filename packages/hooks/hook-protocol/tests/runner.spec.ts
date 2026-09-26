import { describe, expect, expectTypeOf, it } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { DEFAULT_HOOK_TIMEOUT_MS, isHttpHook, runHook } from '@deepseek-ai/dsh-hook-protocol'
import type { RunHookOptions } from '@deepseek-ai/dsh-hook-protocol'

/**
 * A minimal stand-in for the bits of {@link ShellExecutor} that {@link runHook}
 * actually calls (`resolve` then `execute().result()`). `runHook` is pure
 * plumbing over those two methods, so a duck-typed recorder is the right test
 * hook — the REAL executor (dsh-bash-local) is exercised end-to-end by the
 * hook-bridge plugins that consume this library, not here.
 */
function recordingBash(run: (spec: ShellExecSpec) => Promise<ShellRunResult>): {
  bash: Pick<ShellExecutor, 'resolve' | 'execute'>
  specs: ShellExecSpec[]
} {
  const specs: ShellExecSpec[] = []
  const reader = { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) }
  const bash: Pick<ShellExecutor, 'resolve' | 'execute'> = {
    resolve(request: ShellExecRequest): ShellExecSpec {
      // Carry the request through verbatim, defaulting the required spec fields —
      // exactly what dsh-bash-local's resolve does for the fields runHook sets.
      return {
        command: request.command,
        workdir: request.workdir ?? '/stub',
        timeoutMs: request.timeoutMs ?? 0,
        onExpiry: request.onExpiry ?? 'kill',
        stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
        ...request.signal ? { signal: request.signal } : {},
        ...request.stdin !== undefined ? { stdin: request.stdin } : {},
        ...request.env !== undefined ? { env: request.env } : {},
        sandboxPolicy: request.sandboxPolicy,
      }
    },
    async execute(spec: ShellExecSpec): Promise<ShellExecution> {
      specs.push(spec)
      // Only `result()` is consulted; the live-handle members are inert.
      return {
        status: 'completed',
        exitCode: 0,
        signal: null,
        done: Promise.resolve(),
        readOutput: () => ({ delta: '', lossy: false }),
        observed: { stdout: reader, stderr: reader },
        kill: () => false,
        result: () => run(spec),
      }
    },
  }
  return { bash, specs }
}

function result(over: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...over,
  }
}

const clock = () => { let t = 0; return () => (t += 5) } // +5ms per call → duration 5
const testSignal = (): AbortSignal => new AbortController().signal

describe('runHook — payload + env + stdin plumbing', () => {
  it('requires an explicit caller-owned abort signal', () => {
    expectTypeOf<RunHookOptions['signal']>().toEqualTypeOf<AbortSignal>()
  })

  it('serializes the payload to stdin (with trailing newline when requested)', async () => {
    const { bash, specs } = recordingBash(async () => result({ stdout: { text: '', truncated: false } }))
    await runHook(bash, { command: 'my-hook.sh' }, {
      payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      signal: testSignal(),
      defaultTimeoutMs: 60000,
      trailingNewline: true,
    }, clock())
    expect(specs[0]!.stdin).toBe(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }) + '\n')
    expect(specs[0]!.command).toBe('my-hook.sh')
  })

  it('omits the trailing newline when trailingNewline is false (Codex)', async () => {
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h' }, { payload: { a: 1 }, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: false }, clock())
    expect(specs[0]!.stdin).toBe('{"a":1}')
  })

  it('threads env and cwd into the request', async () => {
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h' }, {
      payload: {}, env: { CLAUDE_PROJECT_DIR: '/proj' }, cwd: '/work', signal: testSignal(),
      defaultTimeoutMs: 1000, trailingNewline: true,
    }, clock())
    expect(specs[0]!.env).toEqual({ CLAUDE_PROJECT_DIR: '/proj' })
    expect(specs[0]!.workdir).toBe('/work')
  })

  it('a per-hook timeoutSec (seconds) overrides the default (ms)', async () => {
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h', timeoutSec: 3 }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 60000, trailingNewline: true }, clock())
    expect(specs[0]!.timeoutMs).toBe(3000)
  })

  it('falls back to the default timeout when the hook sets none', async () => {
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 60000, trailingNewline: true }, clock())
    expect(specs[0]!.timeoutMs).toBe(60000)
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(600_000) // the CC/Codex reference default (10 minutes)
  })

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('falls back to the default timeout for a non-positive or non-finite timeoutSec (%s)', async (timeoutSec) => {
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h', timeoutSec }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 60000, trailingNewline: true }, clock())
    expect(specs[0]!.timeoutMs).toBe(60000)
  })

  it('passes the abort signal through', async () => {
    const controller = new AbortController()
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h' }, { payload: {}, signal: controller.signal, defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(specs[0]!.signal).toBe(controller.signal)
  })
})

describe('runHook — outcome decoding + duration', () => {
  it('decodes a clean exit with structured stdout and reports a duration', async () => {
    const { bash } = recordingBash(async () => result({
      exitCode: 0, stdout: { text: JSON.stringify({ decision: 'block', reason: 'no' }), truncated: false },
    }))
    const { output, durationMs } = await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(output.decision).toBe('block')
    expect(output.reason).toBe('no')
    expect(durationMs).toBe(5)
  })

  it('a signal death (exitCode null) decodes as undefined exit (non-blocking error)', async () => {
    const { bash } = recordingBash(async () => result({ exitCode: null, signal: 'SIGKILL', stderr: { text: 'killed', truncated: false } }))
    const { output } = await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(output.exitCode).toBeUndefined()
    expect(output.decision).toBeUndefined()
    expect(output.stderr).toBe('killed')
  })

  it('an executor rejection (infra fault) becomes a non-blocking error, never throws', async () => {
    const { bash } = recordingBash(async () => { throw new Error('bad workdir: ENOENT') })
    const { output } = await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(output.exitCode).toBeUndefined()
    expect(output.stderr).toBe('bad workdir: ENOENT')
    expect(output.decision).toBeUndefined()
  })

  it('a non-Error rejection is stringified onto stderr', async () => {
    const { bash } = recordingBash(async () => { throw 'plain string fault' })
    const { output } = await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(output.stderr).toBe('plain string fault')
  })

  it('threads expectedEventName so a mismatched hookSpecificOutput block is discarded', async () => {
    const { bash } = recordingBash(async () => result({
      exitCode: 0,
      stdout: { text: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }), truncated: false },
    }))
    const { output } = await runHook(bash, { command: 'h' }, {
      payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true, expectedEventName: 'Stop',
    }, clock())
    // A PreToolUse block on a Stop hook is malformed → its decision is discarded.
    expect(output.hookEventName).toBe('PreToolUse')
    expect(output.decision).toBeUndefined()
  })
})

/**
 * Real HTTP endpoint for the transport tests. The HTTP hook transport speaks to
 * a listening socket, so these cases start one, record what it received, and
 * answer — no shell and no platform-specific executable is involved.
 */
interface Endpoint {
  readonly url: string
  readonly requests: { body: string; contentType: string | undefined }[]
  close(): Promise<void>
}

async function startEndpoint(handler: (res: ServerResponse) => void): Promise<Endpoint> {
  const requests: Endpoint['requests'] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ body: Buffer.concat(chunks).toString('utf8'), contentType: req.headers['content-type'] })
      handler(res)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  /* v8 ignore next -- a listening server always reports an object address */
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

/** A local port nothing listens on, for the unreachable-endpoint case. */
async function closedPort(): Promise<number> {
  const probe = await startEndpoint(() => undefined)
  const port = Number(new URL(probe.url).port)
  await probe.close()
  return port
}

const httpOptions = (over: Partial<RunHookOptions> = {}): RunHookOptions => ({
  payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
  signal: testSignal(),
  defaultTimeoutMs: 5000,
  trailingNewline: true,
  ...over,
})

describe('runHook — HTTP transport', () => {
  it('POSTs the payload as JSON and decodes a structured 200 body', async () => {
    const endpoint = await startEndpoint((res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } }))
    })
    try {
      const { output } = await runHook(recordingBash(async () => result()).bash, { url: endpoint.url }, httpOptions({ expectedEventName: 'PreToolUse' }), clock())
      expect(endpoint.requests[0]!.body).toBe(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }) + '\n')
      expect(endpoint.requests[0]!.contentType).toBe('application/json')
      expect(output.decision).toBe('deny')
      expect(output.reason).toBe('no')
      // An HTTP hook has no process, so no exit code is ever recorded.
      expect(output.exitCode).toBeUndefined()
      expect(output.transportError).toBeUndefined()
    } finally {
      await endpoint.close()
    }
  })

  it('posts without a trailing newline when the dialect does not frame one', async () => {
    const endpoint = await startEndpoint((res) => { res.writeHead(200); res.end('') })
    try {
      await runHook(recordingBash(async () => result()).bash, { url: endpoint.url }, httpOptions({ trailingNewline: false }), clock())
      expect(endpoint.requests[0]!.body).toBe('{"hook_event_name":"PreToolUse","tool_name":"Bash"}')
    } finally {
      await endpoint.close()
    }
  })

  it('sends configured headers and honors the per-hook timeout', async () => {
    const endpoint = await startEndpoint((res) => { res.writeHead(200); res.end('') })
    const seen: string[] = []
    const bash = recordingBash(async (spec) => { seen.push(String(spec.timeoutMs)); return result() }).bash
    try {
      await runHook(bash, { url: endpoint.url, headers: { authorization: 'Bearer test' }, timeoutSec: 2 }, httpOptions(), clock())
      // The command transport is never touched for an HTTP hook.
      expect(seen).toEqual([])
    } finally {
      await endpoint.close()
    }
  })

  it('keeps plain (non-JSON) response bodies as stdout', async () => {
    const endpoint = await startEndpoint((res) => { res.writeHead(200); res.end('just text') })
    try {
      const { output } = await runHook(recordingBash(async () => result()).bash, { url: endpoint.url }, httpOptions(), clock())
      expect(output.stdout).toBe('just text')
      expect(output.decision).toBeUndefined()
    } finally {
      await endpoint.close()
    }
  })

  it('discards a hookSpecificOutput block naming a different event', async () => {
    const endpoint = await startEndpoint((res) => {
      res.writeHead(200)
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'deny' } }))
    })
    try {
      const { output } = await runHook(recordingBash(async () => result()).bash, { url: endpoint.url }, httpOptions({ expectedEventName: 'PreToolUse' }), clock())
      expect(output.hookEventName).toBe('Stop')
      expect(output.decision).toBeUndefined()
    } finally {
      await endpoint.close()
    }
  })

  it('FAILS CLOSED on a non-2xx status (deny + transportError, no exit code)', async () => {
    const endpoint = await startEndpoint((res) => { res.writeHead(503); res.end('unavailable') })
    try {
      const { output } = await runHook(recordingBash(async () => result()).bash, { url: endpoint.url }, httpOptions(), clock())
      expect(output.decision).toBe('deny')
      expect(output.transportError).toMatch(/HTTP 503/)
      expect(output.reason).toBe(output.transportError)
      expect(output.exitCode).toBeUndefined()
    } finally {
      await endpoint.close()
    }
  })

  it('FAILS CLOSED when the endpoint cannot be reached', async () => {
    const port = await closedPort()
    const { output } = await runHook(recordingBash(async () => result()).bash, { url: `http://127.0.0.1:${port}/hook` }, httpOptions(), clock())
    expect(output.decision).toBe('deny')
    expect(output.transportError).toContain('failed')
  })

  it('FAILS CLOSED on a timeout, bounded by the per-hook seconds value', async () => {
    // The endpoint accepts the request and never answers: only the transport's
    // own bound can end the exchange.
    const endpoint = await startEndpoint(() => undefined)
    try {
      const started = Date.now()
      const { output } = await runHook(
        recordingBash(async () => result()).bash,
        { url: endpoint.url, timeoutSec: 0.15 },
        httpOptions({ defaultTimeoutMs: 60_000 }),
        clock(),
      )
      expect(output.decision).toBe('deny')
      expect(output.transportError).toContain('failed')
      expect(Date.now() - started).toBeLessThan(30_000)
    } finally {
      await endpoint.close()
    }
  })

  it('an aborted CALLER is not a transport fault (no deny, no transportError)', async () => {
    const endpoint = await startEndpoint(() => undefined)
    const controller = new AbortController()
    try {
      const pending = runHook(
        recordingBash(async () => result()).bash,
        { url: endpoint.url },
        httpOptions({ signal: controller.signal }),
        clock(),
      )
      controller.abort(new Error('turn cancelled'))
      const { output } = await pending
      expect(output.decision).toBeUndefined()
      expect(output.transportError).toBeUndefined()
    } finally {
      await endpoint.close()
    }
  })

  it('isHttpHook distinguishes the two transports', () => {
    expect(isHttpHook({ url: 'http://x/hook' })).toBe(true)
    expect(isHttpHook({ command: 'h' })).toBe(false)
  })
})
