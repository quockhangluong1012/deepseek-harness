/**
 * Tests for the mcp-project-config plugin's `apply` entry point. A `ctx.plugin` stand-in
 * captures the validated `dsh-mcp-client` configs without opening real or mocked MCP transports —
 * this package's job is discovery, parsing, and the mounting decision; connection behavior is
 * `dsh-mcp-client`'s own tested responsibility (mirrors the ACP bridge's `mcp.spec.ts`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as McpProjectConfig from '../src/index.ts'

/** Context stand-in that captures validated MCP configs without opening transports. */
function captureContext(): { ctx: Context; configs: McpClient.Config[]; warn: ReturnType<typeof vi.fn> } {
  const configs: McpClient.Config[] = []
  const warn = vi.fn()
  const plugin = vi.fn((_plugin: unknown, config: McpClient.Config) => {
    configs.push(config)
    return Promise.resolve(undefined)
  })
  return { ctx: { plugin, logger: { warn } } as unknown as Context, configs, warn }
}

async function writeMcpJson(path: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ mcpServers: servers }))
}

let workspace: string
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-mcp-project-config-'))
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('mcp-project-config plugin module exports', () => {
  it('exports name and Config', () => {
    expect(McpProjectConfig.name).toBe('mcp-project-config')
    expect(McpProjectConfig.Config).toBeDefined()
  })
})

describe('mcp-project-config apply', () => {
  it('mounts nothing when neither file exists', async () => {
    const { ctx, configs } = captureContext()
    await McpProjectConfig.apply(ctx, {
      configPath: join(workspace, 'missing-project.mcp.json'),
      userConfigPath: join(workspace, 'missing-user.mcp.json'),
    })
    expect(configs).toEqual([])
  })

  it('mounts a server declared in the project file with the resolved dsh-mcp-client config', async () => {
    const projectPath = join(workspace, '.mcp.json')
    await writeMcpJson(projectPath, { github: { command: 'my-mcp-server', args: ['--flag'], env: { TOKEN: 'x' } } })
    const { ctx, configs } = captureContext()
    await McpProjectConfig.apply(ctx, { configPath: projectPath, userConfigPath: join(workspace, 'no-user.json') })

    expect(configs).toEqual([{
      transport: 'stdio',
      serverName: 'github',
      command: 'my-mcp-server',
      args: ['--flag'],
      env: { TOKEN: 'x' },
      cwd: process.cwd(),
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      maxInstructionBytes: 32_768,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    }])
  })

  it('mounts an http server with the resolved dsh-mcp-client config', async () => {
    const projectPath = join(workspace, '.mcp.json')
    await writeMcpJson(projectPath, { remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } } })
    const { ctx, configs } = captureContext()
    await McpProjectConfig.apply(ctx, { configPath: projectPath, userConfigPath: join(workspace, 'no-user.json') })

    expect(configs).toEqual([{
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      maxInstructionBytes: 32_768,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    }])
  })

  it('mounts servers from both the project and user files', async () => {
    const projectPath = join(workspace, 'project.mcp.json')
    const userPath = join(workspace, 'user.mcp.json')
    await writeMcpJson(projectPath, { github: { command: 'project-server' } })
    await writeMcpJson(userPath, { notion: { command: 'user-server' } })
    const { ctx, configs } = captureContext()
    await McpProjectConfig.apply(ctx, { configPath: projectPath, userConfigPath: userPath })

    expect(configs.map(config => config.serverName).sort()).toEqual(['github', 'notion'])
  })

  it('lets a project entry override a user entry of the same normalized name', async () => {
    const projectPath = join(workspace, 'project.mcp.json')
    const userPath = join(workspace, 'user.mcp.json')
    await writeMcpJson(projectPath, { shared: { command: 'project-wins' } })
    await writeMcpJson(userPath, { shared: { command: 'user-loses' } })
    const { ctx, configs } = captureContext()
    await McpProjectConfig.apply(ctx, { configPath: projectPath, userConfigPath: userPath })

    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({ serverName: 'shared', command: 'project-wins' })
  })

  it('warns and skips a malformed entry without dropping its valid sibling', async () => {
    const projectPath = join(workspace, '.mcp.json')
    await writeMcpJson(projectPath, {
      broken: { command: '' },
      ok: { command: 'my-mcp-server' },
    })
    const { ctx, configs, warn } = captureContext()
    await McpProjectConfig.apply(ctx, { configPath: projectPath, userConfigPath: join(workspace, 'no-user.json') })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping "broken"'))
    expect(configs.map(config => config.serverName)).toEqual(['ok'])
  })

  it('warns and mounts nothing when a config file is unreadable JSON, without throwing', async () => {
    const projectPath = join(workspace, '.mcp.json')
    await writeFile(projectPath, '{ not valid json')
    const { ctx, configs, warn } = captureContext()
    await McpProjectConfig.apply(ctx, { configPath: projectPath, userConfigPath: join(workspace, 'no-user.json') })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`could not load "${projectPath}"`))
    expect(configs).toEqual([])
  })

  it('mounts once, not twice, when configPath and userConfigPath resolve to the same file', async () => {
    const projectPath = join(workspace, '.mcp.json')
    await writeMcpJson(projectPath, { github: { command: 'my-mcp-server' } })
    const { ctx, configs } = captureContext()
    await McpProjectConfig.apply(ctx, { configPath: projectPath, userConfigPath: projectPath })

    expect(configs).toHaveLength(1)
  })

  it('passes failOnStartupError through to every mounted server', async () => {
    const projectPath = join(workspace, '.mcp.json')
    await writeMcpJson(projectPath, { github: { command: 'my-mcp-server' } })
    const { ctx, configs } = captureContext()
    await McpProjectConfig.apply(ctx, { configPath: projectPath, userConfigPath: join(workspace, 'no-user.json'), failOnStartupError: true })

    expect(configs[0]).toMatchObject({ failOnStartupError: true })
  })
})
