/**
 * Provenance seam tests (SPEC §12.2 slice 1): every synced MCP tool definition
 * carries `origin` (namespace + transport + endpoint hash, never the raw
 * endpoint), a deterministic `serverDigest`, and an undefined `capabilities`
 * placeholder. Metadata only — no approval, taint, or transport behavior.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  computeServerDigest,
  endpointHashForHttp,
  endpointHashForStdio,
  endpointOriginForConfig,
  syncTools,
  type ToolBridgeOptions,
} from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

function createMockClient(tools: MockTool[]) {
  return {
    request: vi.fn(async (
      request: { method: string; params?: Record<string, unknown> },
    ): Promise<unknown> => {
      if (request.method === 'tools/list') return { tools, nextCursor: undefined }
      if (request.method === 'tools/call') return { content: [{ type: 'text', text: 'ok' }] }
      throw new Error(`unexpected MCP request: ${request.method}`)
    }),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const stdioOpts: ToolBridgeOptions = {
  registrationFailure: 'contain',
  serverName: 'srv',
  toolCallTimeoutMs: 60_000,
  transport: 'stdio',
  endpointHash: endpointHashForStdio('node', ['server.js']),
}

const httpOpts: ToolBridgeOptions = {
  registrationFailure: 'contain',
  serverName: 'web',
  toolCallTimeoutMs: 60_000,
  ...endpointOriginForConfig({ transport: 'streamable-http', url: 'http://localhost:3000/mcp' }),
}

describe('endpoint hashes', () => {
  it('is stable for the same stdio endpoint', () => {
    expect(endpointHashForStdio('node', ['server.js'])).toBe(endpointHashForStdio('node', ['server.js']))
  })

  it('differs across stdio commands and arguments', () => {
    const base = endpointHashForStdio('node', ['server.js'])
    expect(endpointHashForStdio('python', ['server.js'])).not.toBe(base)
    expect(endpointHashForStdio('node', ['other.js'])).not.toBe(base)
    expect(endpointHashForStdio('node', [])).not.toBe(base)
  })

  it('is stable for the same URL and differs across URLs', () => {
    expect(endpointHashForHttp('http://localhost:3000/mcp')).toBe(endpointHashForHttp('http://localhost:3000/mcp'))
    expect(endpointHashForHttp('http://localhost:3001/mcp')).not.toBe(endpointHashForHttp('http://localhost:3000/mcp'))
  })

  it('keeps stdio and http hashes apart and short', () => {
    const stdio = endpointHashForStdio('http://localhost:3000/mcp', [])
    const http = endpointHashForHttp('http://localhost:3000/mcp')
    expect(stdio).not.toBe(http)
    expect(stdio).toMatch(/^[0-9a-f]{12}$/)
    expect(http).toMatch(/^[0-9a-f]{12}$/)
  })

  it('maps config transports to origin transports', () => {
    expect(endpointOriginForConfig({ transport: 'stdio', command: 'node', args: [] }))
      .toEqual({ transport: 'stdio', endpointHash: endpointHashForStdio('node', []) })
    expect(endpointOriginForConfig({ transport: 'streamable-http', url: 'http://localhost:3000/mcp' }))
      .toEqual({ transport: 'http', endpointHash: endpointHashForHttp('http://localhost:3000/mcp') })
  })
})

describe('server digests', () => {
  it('is deterministic and order-independent', () => {
    const a = computeServerDigest(['b-tool', 'a-tool'], '1.2.3')
    expect(computeServerDigest(['a-tool', 'b-tool'], '1.2.3')).toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes with the tool list or the server version', () => {
    const base = computeServerDigest(['a-tool'], '1.2.3')
    expect(computeServerDigest(['a-tool', 'b-tool'], '1.2.3')).not.toBe(base)
    expect(computeServerDigest(['a-tool'], '2.0.0')).not.toBe(base)
    expect(computeServerDigest(['a-tool'])).not.toBe(base)
  })

  it('still yields a digest without a server version', () => {
    // Absent version feeds the empty string after the `server-version:`
    // marker, so the digest covers the sorted tool-name list alone.
    const digest = computeServerDigest(['solo'])
    expect(digest).toBe(computeServerDigest(['solo']))
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores the namespace: same tools and version digest alike', () => {
    expect(computeServerDigest(['search'], '3')).toBe(computeServerDigest(['search'], '3'))
  })
})

describe('synced definition provenance', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('populates origin, digest, and undefined capabilities on every tool', async () => {
    const client = createMockClient([
      { name: 'greet', inputSchema: { type: 'object' } },
      { name: 'add', inputSchema: { type: 'object' } },
    ])

    await syncTools(client as never, ctx, stdioOpts, new Map())

    for (const name of ['mcp__srv__greet', 'mcp__srv__add']) {
      const tool = ctx.tools.get(name)
      expect(tool?.origin).toEqual({
        serverName: 'srv',
        transport: 'stdio',
        endpointHash: endpointHashForStdio('node', ['server.js']),
      })
      expect(tool?.serverDigest).toBe(computeServerDigest(['greet', 'add']))
      expect(tool?.capabilities).toBeUndefined()
    }
  })

  it('populates http origins for Streamable HTTP servers', async () => {
    const client = createMockClient([{ name: 'fetch', inputSchema: { type: 'object' } }])

    await syncTools(client as never, ctx, httpOpts, new Map())

    expect(ctx.tools.get('mcp__web__fetch')?.origin).toEqual({
      serverName: 'web',
      transport: 'http',
      endpointHash: endpointHashForHttp('http://localhost:3000/mcp'),
    })
  })

  it('versions the digest with the reported server version', async () => {
    const client = createMockClient([{ name: 'greet', inputSchema: { type: 'object' } }])

    await syncTools(client as never, ctx, { ...stdioOpts, serverVersion: '4.5.6' }, new Map())

    expect(ctx.tools.get('mcp__srv__greet')?.serverDigest)
      .toBe(computeServerDigest(['greet'], '4.5.6'))
  })

  it('keeps provenance across re-sync and refreshes the digest with the tool list', async () => {
    const client = createMockClient([{ name: 'old_tool', inputSchema: { type: 'object' } }])
    const first = await syncTools(client as never, ctx, stdioOpts, new Map())
    const firstDigest = ctx.tools.get('mcp__srv__old_tool')?.serverDigest

    client.request.mockResolvedValue({ tools: [{ name: 'new_tool', inputSchema: { type: 'object' } }], nextCursor: undefined })
    await syncTools(client as never, ctx, stdioOpts, first)

    const tool = ctx.tools.get('mcp__srv__new_tool')
    expect(tool?.origin?.serverName).toBe('srv')
    expect(tool?.serverDigest).toBe(computeServerDigest(['new_tool']))
    expect(tool?.serverDigest).not.toBe(firstDigest)
  })

  it('shares one generation digest while namespaces stay distinct', async () => {
    const clientA = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])
    const clientB = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])

    await syncTools(clientA as never, ctx, { ...stdioOpts, serverName: 'github' }, new Map())
    await syncTools(clientB as never, ctx, { ...stdioOpts, serverName: 'web' }, new Map())

    const github = ctx.tools.get('mcp__github__search')
    const web = ctx.tools.get('mcp__web__search')
    expect(github?.origin?.serverName).toBe('github')
    expect(web?.origin?.serverName).toBe('web')
    expect(github?.serverDigest).toBe(web?.serverDigest)
  })

  it('never leaks provenance into the model-facing schemas', async () => {
    const client = createMockClient([{ name: 'greet', inputSchema: { type: 'object' } }])
    await syncTools(client as never, ctx, stdioOpts, new Map())

    const schemas = ctx.tools.schemas() as unknown as Record<string, JsonValue>[]
    expect(schemas).toHaveLength(1)
    expect(schemas[0]).not.toHaveProperty('origin')
    expect(schemas[0]).not.toHaveProperty('serverDigest')
    expect(schemas[0]).not.toHaveProperty('capabilities')
    expect(Object.keys(schemas[0] as object).sort()).toEqual(['description', 'name', 'parameters'])
  })
})
