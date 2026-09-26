/**
 * Tests for the two optional capability-seam providers that delegate to the
 * connected ACP client: the text filesystem reads/writes routed by workspace,
 * and the terminal commands routed by managed `DSH_*` session identity.
 *
 * The fake client in the harness serves `fs/*` from an in-memory map and
 * records every `terminal/*` call, so delegation is observable as the
 * difference between the client's view and the harness's own filesystem.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Config as BashConfig } from '@deepseek-ai/dsh-bash-local'
import AcpClientFileSystem from '../src/client-fs.ts'
import AcpClientShellExecutor from '../src/client-shell.ts'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

let harness: BridgeHarness | undefined
let scratch: string | undefined

afterEach(async () => {
  const bridge = harness
  harness = undefined
  await bridge?.dispose()
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

/**
 * A real workspace named exactly as `mkdtemp` returned it: the platform's own
 * spelling (an 8.3 short name on Windows, a symlinked temp root on macOS).
 * Routing has to canonicalize that against the filesystem seam's
 * realpath-derived target keys, so this workspace is deliberately not
 * pre-canonicalized.
 */
function workspace(): string {
  scratch ??= mkdtempSync(join(tmpdir(), 'dsh-acp-client-'))
  return scratch
}

describe('ACP client filesystem delegation', () => {
  it('reads and writes through the client for a target inside the session workspace', async () => {
    const bridge = await makeBridgeHarness()
    harness = bridge
    const root = workspace()
    const file = join(root, 'note.txt')
    writeFileSync(file, 'disk view\n')
    await bridge.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const { sessionId } = await bridge.client.newSession({ cwd: root, mcpServers: [] })
    expect(sessionId).toBeTruthy()
    const fiber = await bridge.ctx.plugin(AcpClientFileSystem, { cwd: root })
    try {
      const target = await bridge.ctx.fs.resolve(file)
      bridge.clientFiles.set(bridge.ctx.fs.processPath(target), 'client view\n')

      // The client's own view wins over the bytes on disk.
      await expect(bridge.ctx.fs.readText(target)).resolves.toBe('client view\n')

      const update = await bridge.ctx.fs.writeText(target, 'rewritten\n')
      expect(update).toEqual({
        operation: 'update',
        version: expect.stringMatching(/^acp:/) as string,
        before: 'client view\n',
        after: 'rewritten\n',
      })
      expect(bridge.clientFiles.get(bridge.ctx.fs.processPath(target))).toBe('rewritten\n')
      expect(readFileSync(file, 'utf8')).toBe('disk view\n')
    } finally {
      await fiber.dispose()
    }
  })

  it('streams a routed target from the client as one chunk', async () => {
    const bridge = await makeBridgeHarness()
    harness = bridge
    const root = workspace()
    const file = join(root, 'streamed.txt')
    writeFileSync(file, 'disk stream\n')
    await bridge.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    await bridge.client.newSession({ cwd: root, mcpServers: [] })
    const fiber = await bridge.ctx.plugin(AcpClientFileSystem, { cwd: root })
    try {
      const target = await bridge.ctx.fs.resolve(file)
      bridge.clientFiles.set(bridge.ctx.fs.processPath(target), 'client stream\n')

      const chunks: string[] = []
      for await (const chunk of await bridge.ctx.fs.streamText(target)) chunks.push(chunk)
      expect(chunks).toEqual(['client stream\n'])
    } finally {
      await fiber.dispose()
    }
  })

  it('reports a create when the client cannot serve the prior content, and keeps guards local', async () => {
    const bridge = await makeBridgeHarness()
    harness = bridge
    const root = workspace()
    await bridge.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    await bridge.client.newSession({ cwd: root, mcpServers: [] })
    const fiber = await bridge.ctx.plugin(AcpClientFileSystem, { cwd: root })
    try {
      const freshPath = join(root, 'fresh.txt')
      const fresh = await bridge.ctx.fs.resolve(freshPath)
      const created = await bridge.ctx.fs.writeText(fresh, 'created\n')
      expect(created).toMatchObject({ operation: 'create', before: null, after: 'created\n' })
      expect(bridge.clientFiles.get(bridge.ctx.fs.processPath(fresh))).toBe('created\n')

      // A guarded write needs a version token the ACP surface cannot carry, so
      // it stays with the inherited backend and never reaches the client.
      const guardedPath = join(root, 'guarded.txt')
      const guarded = await bridge.ctx.fs.resolve(guardedPath)
      const outcome = await bridge.ctx.fs.writeText(guarded, 'guarded\n', { kind: 'createIfAbsent' })
      expect(outcome.operation).toBe('create')
      expect(outcome.version).not.toMatch(/^acp:/)
      expect(bridge.clientFiles.has(bridge.ctx.fs.processPath(guarded))).toBe(false)
      expect(readFileSync(guardedPath, 'utf8')).toBe('guarded\n')
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps targets outside every tracked workspace and unadvertised capabilities local', async () => {
    const bridge = await makeBridgeHarness()
    harness = bridge
    const root = workspace()
    const outside = `${root}-outside`
    const outsideFile = join(outside, 'outside.txt')
    const fiber = await bridge.ctx.plugin(AcpClientFileSystem, { cwd: root })
    try {
      mkdirSync(outside, { recursive: true })
      await bridge.client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      })
      await bridge.client.newSession({ cwd: root, mcpServers: [] })
      writeFileSync(outsideFile, 'outside disk\n')
      bridge.clientFiles.set(outsideFile, 'outside client\n')
      const outsideTarget = await bridge.ctx.fs.resolve(outsideFile)
      await expect(bridge.ctx.fs.readText(outsideTarget)).resolves.toBe('outside disk\n')

      // A client that advertises no text method leaves the inherited read.
      await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const insideFile = join(root, 'inside.txt')
      writeFileSync(insideFile, 'inside disk\n')
      bridge.clientFiles.set(insideFile, 'inside client\n')
      const insideTarget = await bridge.ctx.fs.resolve(insideFile)
      await expect(bridge.ctx.fs.readText(insideTarget)).resolves.toBe('inside disk\n')
    } finally {
      await fiber.dispose()
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('ACP client terminal delegation', () => {
  /** Volatile config for the bash executor this provider extends. */
  function bashConfig(root: string): BashConfig {
    return {
      cwd: { get: () => root },
      timeoutMs: { get: () => 5_000 },
      maxTimeoutMs: { get: () => 5_000 },
      maxOutputBytes: { get: () => 64_000 },
      maxSpillBytes: { get: () => 64_000 },
      graceMs: { get: () => 200 },
    }
  }

  /** Mount the provider for the harness context and return the wired executor. */
  function mountShell(bridge: BridgeHarness, root: string): AcpClientShellExecutor {
    return new AcpClientShellExecutor(bridge.ctx, bashConfig(root))
  }

  it('runs a routed command in the client terminal and reports its captured exit facts', async () => {
    const bridge = await makeBridgeHarness()
    harness = bridge
    const root = workspace()
    const executor = mountShell(bridge, root)
    await bridge.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    })
    const { sessionId } = await bridge.client.newSession({ cwd: root, mcpServers: [] })
    const spec = executor.resolve({ command: 'echo hi', dshEnv: { DSH_SESSION_ID: sessionId } })

    const execution = await executor.execute(spec)
    const terminal = bridge.terminals[0]
    expect(bridge.terminals).toHaveLength(1)
    expect(terminal).toMatchObject({ command: 'bash', args: ['-c', 'echo hi'], cwd: root })
    expect(terminal?.env).toContainEqual({ name: 'DSH_SESSION_ID', value: sessionId })
    expect(terminal?.env).toContainEqual({ name: 'NO_COLOR', value: '1' })

    if (terminal === undefined) throw new Error('the client created no terminal')
    terminal.output = 'hi\n'
    bridge.finishTerminal(terminal, { exitCode: 0 })

    const result = await execution.result()
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, aborted: false })
    expect(result.stdout).toEqual({ text: 'hi\n', truncated: false })
    expect(execution.status).toBe('completed')
    expect(terminal.released).toBe(true)
    expect(execution.readOutput()).toEqual({ delta: 'hi\n', lossy: false })
  })

  it('kills through the client terminal and keeps the observed stream addressable', async () => {
    const bridge = await makeBridgeHarness()
    harness = bridge
    const root = workspace()
    const executor = mountShell(bridge, root)
    await bridge.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    })
    const { sessionId } = await bridge.client.newSession({ cwd: root, mcpServers: [] })
    const execution = await executor.execute(executor.resolve({
      command: 'sleep 30',
      dshEnv: { DSH_SESSION_ID: sessionId },
    }))

    expect(execution.kill()).toBe(true)
    expect(execution.kill()).toBe(false)
    const terminal = bridge.terminals[0]
    if (terminal === undefined) throw new Error('the client created no terminal')
    terminal.output = 'partial\n'

    const result = await execution.result()
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: false, aborted: false })
    expect(execution.status).toBe('killed')
    expect(terminal.killed).toBe(true)
    // The offset reader and the consuming cursor both see the final view.
    expect(execution.observed.stdout.readFrom(0)).toEqual({ text: 'partial\n', lossy: false, nextOffset: 8 })
  })

  it('leaves a command with no routed session to the inherited executor', async () => {
    const bridge = await makeBridgeHarness()
    harness = bridge
    const root = workspace()
    const executor = mountShell(bridge, root)
    await bridge.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    })
    await bridge.client.newSession({ cwd: root, mcpServers: [] })

    // No `DSH_SESSION_ID` in the managed snapshot: the call is unroutable, so
    // it never reaches the client. The inherited bash executor then has no
    // subprocess service composed in this harness, which is the local path.
    const unrouted = await executor.execute(executor.resolve({ command: 'echo local' }))
    await expect(unrouted.result()).rejects.toThrow()
    expect(bridge.terminals).toHaveLength(0)
    expect(unrouted.status).toBe('killed')
  })
})
