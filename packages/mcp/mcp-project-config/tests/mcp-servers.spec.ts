/**
 * The management service's behavior: the merged view with trust labels and
 * live state, and the writes it performs or refuses.
 *
 * The bench supplies a context double that captures the client mounts this
 * package decides (connection behavior is `dsh-mcp-client`'s own tested
 * responsibility) and an approval channel per test, so a refusal is exercised
 * without an interactive answerer.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { McpServers } from '../src/mcp-servers.ts'
import type { McpApprovalAsk, McpApprovalChannel } from '../src/mcp-servers.ts'
import type { McpServersOptions } from '../src/mcp-servers.ts'

/** Session id the tests address their approval asks to. */
const SESSION = 'session-1' as SessionId

/** The listenable status callback the service registers with the double. */
type StatusListener = (change: { serverName: string; status: string; attempt: number; maxAttempts: number }) => void

/** One captured mount, with the disposal the service may call on it. */
interface Mounted {
  readonly config: McpClient.Config
  disposed: boolean
}

/** The context double: captured mounts, one warn sink, and the status listener. */
interface BenchContext {
  ctx: Context
  mounts: Mounted[]
  warn: ReturnType<typeof vi.fn>
  status: (change: Parameters<StatusListener>[0]) => void
}

function benchContext(): BenchContext {
  const mounts: Mounted[] = []
  const warn = vi.fn()
  let listener: StatusListener | undefined
  const double = {
    plugin: (_plugin: unknown, config: McpClient.Config) => {
      const mounted: Mounted = { config, disposed: false }
      mounts.push(mounted)
      return Promise.resolve({
        dispose: async () => {
          mounted.disposed = true
        },
      })
    },
    logger: { warn },
    reflect: { provide: () => () => {} },
    effect: (run: () => unknown) => {
      run()
      return () => {}
    },
    on: (_name: string, registered: StatusListener) => {
      listener = registered
      return () => {}
    },
  }
  return {
    ctx: double as unknown as Context,
    mounts,
    warn,
    status: (change) => { listener?.(change) },
  }
}

/** An approval channel that answers one outcome, or rejects as a missing channel does. */
function approvalOf(answer: ApprovalOutcome | 'reject'): { channel: McpApprovalChannel; asks: McpApprovalAsk[] } {
  const asks: McpApprovalAsk[] = []
  return {
    asks,
    channel: {
      request: async (ask) => {
        asks.push(ask)
        if (answer === 'reject') throw new Error('approval.request() outside an open turn')
        return answer
      },
    },
  }
}

/** Write one config document, creating parents. */
async function writeDoc(path: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ mcpServers: servers }, null, 2))
}

/** Read one config document back. */
async function readDoc(path: string): Promise<{ mcpServers: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await readFile(path, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }
}

let workspace: string
let projectPath: string
let userPath: string
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-mcp-servers-'))
  projectPath = join(workspace, 'project', '.mcp.json')
  userPath = join(workspace, 'user', 'mcp.json')
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

/** Start one service over the current files. */
async function start(options: Partial<McpServersOptions> = {}): Promise<{
  servers: McpServers
  mounts: Mounted[]
  warn: ReturnType<typeof vi.fn>
  status: (change: Parameters<StatusListener>[0]) => void
}> {
  const bench = benchContext()
  const servers = new McpServers(bench.ctx, {
    projectPath,
    userPath,
    failOnStartupError: false,
    approval: undefined,
    ...options,
  })
  await servers.start()
  return { servers, mounts: bench.mounts, warn: bench.warn, status: bench.status }
}

describe('McpServers list', () => {
  it('merges the project layer over the user layer with declared trust labels', async () => {
    await writeDoc(userPath, {
      shared: { command: 'user-server', trust: 'unknown' },
      'user only': { type: 'http', url: 'https://user.example/mcp' },
    })
    await writeDoc(projectPath, {
      shared: { command: 'project-server', args: ['--a'], trust: 'trusted' },
    })

    const { servers, mounts } = await start()
    const view = servers.list()

    expect(view.servers.map(server => [server.name, server.layer, server.trust])).toEqual([
      ['shared', 'project', 'trusted'],
      ['user only', 'user', 'untrusted'],
    ])
    expect(view.servers[0]?.endpoint).toEqual({ transport: 'stdio', command: 'project-server', args: ['--a'], envKeys: [] })
    expect(view.servers[1]?.serverName).toMatch(/^user_only_/)
    expect(view.servers[1]?.endpoint).toEqual({ transport: 'http', url: 'https://user.example/mcp', headerNames: [] })
    expect(mounts.map(mount => mount.config.serverName)[0]).toBe('shared')
    expect(mounts.map(mount => mount.config.serverName)[1]).toMatch(/^user_only_/)
  })

  it('reports rejected declarations with their reason and never their secret values', async () => {
    await writeDoc(projectPath, {
      broken: { type: 'websocket', url: 'wss://example.com' },
      good: { command: 'server', env: { API_TOKEN: 'super-secret-value' }, headers: { Authorization: 'Bearer hidden' } },
    })

    const { servers } = await start()
    const view = servers.list()

    expect(view.servers[0]?.endpoint).toEqual({ transport: 'stdio', command: 'server', args: [], envKeys: ['API_TOKEN'] })
    expect(view.servers[1]?.endpoint).toBeNull()
    expect(view.servers[1]?.state.kind === 'not-mounted' && view.servers[1]?.state.reason).toMatch(/unsupported or missing type/)
    expect(JSON.stringify(view)).not.toContain('super-secret-value')
    expect(JSON.stringify(view)).not.toContain('Bearer hidden')
  })

  it('reports the state each mounted client announces', async () => {
    await writeDoc(projectPath, { server: { command: 'server' } })
    const { servers, status } = await start()

    expect(servers.list().servers[0]?.state).toEqual({ kind: 'not-mounted', reason: 'the mounted client has reported no state yet' })

    status({ serverName: 'server', status: 'reconnecting', attempt: 2, maxAttempts: 5 })
    expect(servers.list().servers[0]?.state).toEqual({ kind: 'mounted', status: 'reconnecting', attempt: 2, maxAttempts: 5 })

    status({ serverName: 'server', status: 'connected', attempt: 0, maxAttempts: 5 })
    expect(servers.list().servers[0]?.state).toEqual({ kind: 'mounted', status: 'connected', attempt: 0, maxAttempts: 5 })
  })

  it('warns about a config file that is not JSON and still reads the other layer', async () => {
    await mkdir(join(projectPath, '..'), { recursive: true })
    await writeFile(projectPath, '{ not json')
    await writeDoc(userPath, { user: { command: 'user-server' } })

    const { servers, warn } = await start()
    expect(servers.list().servers.map(server => server.name)).toEqual(['user'])
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('McpServers upsert', () => {
  it('writes a declaration and mounts it once the approval grants', async () => {
    const { channel, asks } = approvalOf('allowed-once')
    const { servers, mounts } = await start({ approval: channel })

    const outcome = await servers.upsert({
      name: 'github',
      layer: 'project',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'written-secret' },
      trust: 'trusted',
      sessionId: SESSION,
    })

    expect(outcome.ok).toBe(true)
    expect(asks).toEqual([expect.objectContaining({ sessionId: SESSION, toolName: 'mcp_server_config' })])
    expect(await readDoc(projectPath)).toEqual({
      mcpServers: { github: { type: 'stdio', trust: 'trusted', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'written-secret' } } },
    })
    expect(mounts.map(mount => mount.config.serverName)).toEqual(['github'])
    expect(outcome.view.servers[0]?.endpoint).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'server'], envKeys: ['TOKEN'] })
    expect(JSON.stringify(outcome.view)).not.toContain('written-secret')
  })

  it('writes nothing when the approval is withheld', async () => {
    const { channel } = approvalOf('rejected')
    const { servers, mounts } = await start({ approval: channel })

    const outcome = await servers.upsert({ name: 'github', layer: 'project', transport: 'stdio', command: 'npx', sessionId: SESSION })

    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('approval-refused')
    expect(outcome.view.servers).toEqual([])
    expect(mounts).toEqual([])
  })

  it('writes nothing when no approval channel can answer', async () => {
    const { servers, mounts } = await start()

    const outcome = await servers.upsert({ name: 'github', layer: 'project', transport: 'stdio', command: 'npx', sessionId: SESSION })

    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('approval-required')
    expect(mounts).toEqual([])
  })

  it('refuses a declaration the client could not mount', async () => {
    const { channel, asks } = approvalOf('allowed-once')
    const { servers } = await start({ approval: channel })

    const outcome = await servers.upsert({ name: 'remote', layer: 'user', transport: 'http', url: 'ftp://example.com', sessionId: SESSION })

    expect(outcome.refusal).toBe('invalid-declaration')
    expect(asks).toEqual([])
  })

  it('remounts a changed declaration and disposes the instance it replaces', async () => {
    const { channel } = approvalOf('allowed-once')
    const { servers, mounts } = await start({ approval: channel })

    await servers.upsert({ name: 'server', layer: 'project', transport: 'stdio', command: 'first', sessionId: SESSION })
    await servers.upsert({ name: 'server', layer: 'project', transport: 'stdio', command: 'second', sessionId: SESSION })

    expect(mounts).toHaveLength(2)
    expect(mounts[0]?.disposed).toBe(true)
    expect(mounts[1]?.disposed).toBe(false)
  })

  it('keeps stored secret values when the request asks for them', async () => {
    await writeDoc(projectPath, { server: { command: 'server', env: { KEEP: 'stored', OLD: 'old' } } })
    const { channel } = approvalOf('allowed-once')
    const { servers } = await start({ approval: channel })

    const outcome = await servers.upsert({
      name: 'server',
      layer: 'project',
      transport: 'stdio',
      command: 'server',
      env: { OLD: 'replaced' },
      keepStoredSecrets: true,
      sessionId: SESSION,
    })

    expect(outcome.ok).toBe(true)
    const written = await readDoc(projectPath)
    expect(written.mcpServers.server?.env).toEqual({ KEEP: 'stored', OLD: 'replaced' })
  })
})

describe('McpServers remove', () => {
  it('deletes a declaration that hides nothing without asking for approval', async () => {
    await writeDoc(projectPath, { server: { command: 'server' } })
    const { channel, asks } = approvalOf('allowed-once')
    const { servers, mounts } = await start({ approval: channel })

    const outcome = await servers.remove({ name: 'server', layer: 'project', sessionId: SESSION })

    expect(outcome.ok).toBe(true)
    expect(outcome.refusal).toBeNull()
    expect(outcome.detail).toBeNull()
    expect(outcome.view.servers).toEqual([])
    expect(asks).toEqual([])
    expect((await readDoc(projectPath)).mcpServers).toEqual({})
    expect(mounts[0]?.disposed).toBe(true)
  })

  it('asks before deleting a project declaration that unmasks the user layer', async () => {
    await writeDoc(projectPath, { shared: { command: 'project-server' } })
    await writeDoc(userPath, { shared: { command: 'user-server' } })
    const { channel, asks } = approvalOf('rejected')
    const { servers } = await start({ approval: channel })

    const outcome = await servers.remove({ name: 'shared', layer: 'project', sessionId: SESSION })

    expect(outcome.refusal).toBe('approval-refused')
    expect(asks).toHaveLength(1)
    expect((await readDoc(projectPath)).mcpServers).toHaveProperty('shared')
  })

  it('refuses a name the layer does not declare', async () => {
    const { channel } = approvalOf('allowed-once')
    const { servers } = await start({ approval: channel })

    const outcome = await servers.remove({ name: 'missing', layer: 'user', sessionId: SESSION })

    expect(outcome.refusal).toBe('unknown-server')
  })
})
