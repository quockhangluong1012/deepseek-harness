/**
 * Parses the Claude-Code-compatible `.mcp.json` schema
 * (`{ "mcpServers": { "<name>": { command/args/env | type: "http", url, headers } } }`)
 * into `dsh-mcp-client` config inputs. Pure and side-effect free: reading the file is the
 * caller's job so this module stays independently testable.
 * @module @deepseek-ai/dsh-mcp-project-config/parse
 */

import { createHash } from 'node:crypto'

/** One entry this parser rejected, with enough detail for a single log line. */
export interface SkippedServer {
  /** The raw (pre-normalization) key from `mcpServers`. */
  readonly rawName: string
  /** Why the entry was skipped. */
  readonly reason: string
}

/** One accepted server declaration, normalized to a `dsh-mcp-client` config input. */
export type ParsedServer =
  | { readonly transport: 'stdio'; readonly serverName: string; readonly command: string; readonly args: string[]; readonly env: Record<string, string> }
  | { readonly transport: 'streamable-http'; readonly serverName: string; readonly url: string; readonly headers: Record<string, string> }

/** The outcome of parsing one `.mcp.json` document. */
export interface ParsedMcpConfig {
  /** Accepted servers keyed by their normalized `serverName`. */
  readonly servers: ReadonlyMap<string, ParsedServer>
  /** Rejected entries, in declaration order. */
  readonly skipped: readonly SkippedServer[]
}

const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const SUPPORTED_TYPES = new Set(['stdio', 'http'])

/** A plain (non-null, non-array) object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Derive a stable, budget-safe `serverName` from a `.mcp.json` key. Keys already matching the
 * `dsh-mcp-client` pattern pass through; anything else (spaces, unicode, punctuation) is
 * transliterated and disambiguated with a content hash, mirroring the ACP bridge's normalization
 * so both origins produce the same tool-name shape for the same human-readable server name.
 * @param rawName - the JSON key naming the server.
 * @returns a `serverName` matching `^[A-Za-z0-9_-]{1,32}$`.
 */
function normalizeServerName(rawName: string): string {
  if (VALID_SERVER_NAME.test(rawName)) return rawName
  const slug = rawName.normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'server'
  const digest = createHash('sha256').update(rawName).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

/** Every value in a record must be a string, else the caller's field is malformed. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  const object = asObject(value)
  if (object === undefined) return undefined
  const result: Record<string, string> = {}
  for (const [key, entryValue] of Object.entries(object)) {
    if (typeof entryValue !== 'string') return undefined
    result[key] = entryValue
  }
  return result
}

/**
 * Parse one already-JSON-decoded `.mcp.json` document (or a bare `mcpServers` map).
 * Malformed entries are skipped with a reason rather than failing the whole document — one bad
 * server declaration must not silently drop every sibling.
 * @param raw - the parsed JSON value.
 * @returns accepted servers keyed by normalized name, plus every skipped entry.
 */
export function parseMcpProjectConfig(raw: unknown): ParsedMcpConfig {
  const servers = new Map<string, ParsedServer>()
  const skipped: SkippedServer[] = []
  const root = asObject(raw)
  const mcpServers = root === undefined ? undefined : asObject(root.mcpServers)
  if (mcpServers === undefined) return { servers, skipped }

  for (const [rawName, rawEntry] of Object.entries(mcpServers)) {
    const entry = asObject(rawEntry)
    if (entry === undefined) { skipped.push({ rawName, reason: 'entry is not an object' }); continue }
    const type = typeof entry.type === 'string' ? entry.type : (typeof entry.command === 'string' ? 'stdio' : undefined)
    if (type === undefined || !SUPPORTED_TYPES.has(type)) {
      skipped.push({ rawName, reason: `unsupported or missing type ${JSON.stringify(entry.type)}` })
      continue
    }
    const serverName = normalizeServerName(rawName)
    if (servers.has(serverName)) { skipped.push({ rawName, reason: `normalized name collides with another entry: ${serverName}` }); continue }

    if (type === 'stdio') {
      if (typeof entry.command !== 'string' || entry.command.length === 0) {
        skipped.push({ rawName, reason: 'stdio entry requires a non-empty "command"' })
        continue
      }
      const args = entry.args === undefined ? [] : Array.isArray(entry.args) && entry.args.every(a => typeof a === 'string') ? entry.args as string[] : undefined
      if (args === undefined) { skipped.push({ rawName, reason: '"args" must be an array of strings' }); continue }
      const env = entry.env === undefined ? {} : stringRecord(entry.env)
      if (env === undefined) { skipped.push({ rawName, reason: '"env" must be a map of strings' }); continue }
      servers.set(serverName, { transport: 'stdio', serverName, command: entry.command, args, env })
      continue
    }

    // type === 'http'
    if (typeof entry.url !== 'string' || entry.url.length === 0) {
      skipped.push({ rawName, reason: 'http entry requires a non-empty "url"' })
      continue
    }
    try {
      const parsedUrl = new URL(entry.url)
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('unsupported protocol')
    } catch {
      skipped.push({ rawName, reason: '"url" must be an absolute http(s) URL' })
      continue
    }
    const headers = entry.headers === undefined ? {} : stringRecord(entry.headers)
    if (headers === undefined) { skipped.push({ rawName, reason: '"headers" must be a map of strings' }); continue }
    servers.set(serverName, { transport: 'streamable-http', serverName, url: entry.url, headers })
  }

  return { servers, skipped }
}
