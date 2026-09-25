import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseMcpProjectConfig } from '../src/parse.ts'

describe('parseMcpProjectConfig', () => {
  it('accepts a stdio server with defaulted args and env', () => {
    const { servers, skipped } = parseMcpProjectConfig({
      mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { TOKEN: 'x' } } },
    })
    expect(skipped).toEqual([])
    expect(servers.get('github')).toEqual({
      transport: 'stdio',
      serverName: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { TOKEN: 'x' },
    })
  })

  it('defaults an omitted command entry to stdio, and defaults args/env when absent', () => {
    const { servers } = parseMcpProjectConfig({ mcpServers: { bare: { command: 'my-server' } } })
    expect(servers.get('bare')).toEqual({ transport: 'stdio', serverName: 'bare', command: 'my-server', args: [], env: {} })
  })

  it('accepts an http server and validates its URL scheme', () => {
    const { servers, skipped } = parseMcpProjectConfig({
      mcpServers: {
        remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
        badScheme: { type: 'http', url: 'ftp://example.com/mcp' },
      },
    })
    expect(servers.get('remote')).toEqual({
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    })
    expect(servers.has('badScheme')).toBe(false)
    expect(skipped).toEqual([{ rawName: 'badScheme', reason: '"url" must be an absolute http(s) URL' }])
  })

  it('normalizes a server name outside the tool-name pattern and disambiguates by content hash', () => {
    const { servers } = parseMcpProjectConfig({ mcpServers: { 'My Server!': { command: 'run' } } })
    const [serverName] = [...servers.keys()]
    expect(serverName).toMatch(/^My_Server_[0-9a-f]{8}$/)
  })

  it('skips an entry missing a required field without dropping its siblings', () => {
    const { servers, skipped } = parseMcpProjectConfig({
      mcpServers: {
        broken: { command: '' },
        ok: { command: 'run' },
      },
    })
    expect(servers.has('broken')).toBe(false)
    expect(servers.get('ok')).toBeDefined()
    expect(skipped).toEqual([{ rawName: 'broken', reason: 'stdio entry requires a non-empty "command"' }])
  })

  it('skips an entry with malformed args or env instead of throwing', () => {
    const { skipped: argsSkipped } = parseMcpProjectConfig({ mcpServers: { bad: { command: 'run', args: 'not-an-array' } } })
    expect(argsSkipped).toEqual([{ rawName: 'bad', reason: '"args" must be an array of strings' }])

    const { skipped: envSkipped } = parseMcpProjectConfig({ mcpServers: { bad: { command: 'run', env: { KEY: 1 } } } })
    expect(envSkipped).toEqual([{ rawName: 'bad', reason: '"env" must be a map of strings' }])
  })

  it('skips an entry with an unsupported or missing type', () => {
    const { skipped } = parseMcpProjectConfig({
      mcpServers: { sse: { type: 'sse', url: 'https://example.com/mcp' }, empty: {} },
    })
    expect(skipped).toEqual([
      { rawName: 'sse', reason: 'unsupported or missing type "sse"' },
      { rawName: 'empty', reason: 'unsupported or missing type undefined' },
    ])
  })

  it('skips a non-object entry', () => {
    const { skipped } = parseMcpProjectConfig({ mcpServers: { bad: 'not-an-object' } })
    expect(skipped).toEqual([{ rawName: 'bad', reason: 'entry is not an object' }])
  })

  it('rejects a normalized-name collision between two distinct raw keys, keeping the first', () => {
    // Force a real collision: the second raw key is a literal, already-valid
    // name equal to what the first (invalid) raw key normalizes to, so no
    // brute-force hash search is needed.
    const firstRawName = 'weird name!'
    const digest = createHash('sha256').update(firstRawName).digest('hex').slice(0, 8)
    const collidingValidName = `weird_name_${digest}`
    const { servers, skipped } = parseMcpProjectConfig({
      mcpServers: { [firstRawName]: { command: 'first' }, [collidingValidName]: { command: 'second' } },
    })
    expect(servers.size).toBe(1)
    expect(servers.get(collidingValidName)).toMatchObject({ command: 'first' })
    expect(skipped).toEqual([{ rawName: collidingValidName, reason: `normalized name collides with another entry: ${collidingValidName}` }])
  })

  it('returns empty results for a document with no mcpServers key, a non-object root, or a non-object mcpServers value', () => {
    expect(parseMcpProjectConfig({}).servers.size).toBe(0)
    expect(parseMcpProjectConfig(null).servers.size).toBe(0)
    expect(parseMcpProjectConfig('not json').servers.size).toBe(0)
    expect(parseMcpProjectConfig({ mcpServers: [] }).servers.size).toBe(0)
  })
})
