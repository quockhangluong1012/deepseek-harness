/**
 * Read and rewrite one `.mcp.json`-shaped document. Reading tolerates an
 * absent file; writing keeps every key the management surface does not own and
 * refuses a document that is not a JSON object, so a hand edit is never
 * discarded silently.
 *
 * @module @deepseek-ai/dsh-mcp-project-config/config-file
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One config file's parsed content. */
export interface McpConfigDocument {
  /** Whether the file exists; an absent file reads empty and starts a fresh document on write. */
  readonly present: boolean
  /** The document's top-level keys, preserved by a write. */
  readonly root: Record<string, unknown>
  /** The `mcpServers` map; an absent or non-object value reads as empty. */
  readonly mcpServers: Record<string, unknown>
}

/** Raised when a config file exists but cannot be read as a JSON object. */
export class McpConfigFileError extends Error {
  /**
   * @param message - why the document is unusable, without the path.
   * @param path - absolute path of the document.
   */
  constructor(message: string, readonly path: string) {
    super(message)
  }
}

/** A plain (non-null, non-array) object, else undefined. */
function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Read one config file.
 * @param path - absolute path of the file.
 * @returns the parsed document; `present: false` with empty maps when the file does not exist.
 * @throws {McpConfigFileError} when the file cannot be read or does not hold a JSON object.
 */
export async function readConfigDocument(path: string): Promise<McpConfigDocument> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, root: {}, mcpServers: {} }
    throw new McpConfigFileError(`could not be read: ${String(error)}`, path)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new McpConfigFileError(`not valid JSON: ${String(error)}`, path)
  }
  const root = asPlainObject(parsed)
  if (root === undefined) throw new McpConfigFileError('must hold a JSON object', path)
  return { present: true, root, mcpServers: asPlainObject(root.mcpServers) ?? {} }
}

/**
 * Add, replace, or delete one `mcpServers` entry, leaving every other key of
 * the document intact. The file is rewritten as two-space indented JSON.
 * @param path - absolute path of the file.
 * @param name - the `mcpServers` key to write.
 * @param entry - the declaration to write, or `null` to delete the key.
 * @returns the path written.
 * @throws {McpConfigFileError} when the existing document cannot be read or the write fails.
 */
export async function writeServerEntry(
  path: string,
  name: string,
  entry: Record<string, unknown> | null,
): Promise<string> {
  const document = await readConfigDocument(path)
  // The entry is written by rebuilding the map: `delete` on a computed key
  // drops the object into dictionary mode, and rebuilding also leaves every
  // untouched key in the position the document already had it.
  const entries = Object.entries(document.mcpServers)
  const servers: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    if (key !== name) servers[key] = value
    else if (entry !== null) servers[key] = entry
  }
  if (entry !== null && !entries.some(([key]) => key === name)) servers[name] = entry
  const root = { ...document.root, mcpServers: servers }
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
  } catch (error: unknown) {
    throw new McpConfigFileError(`could not be written: ${String(error)}`, path)
  }
  return path
}
