/**
 * Pure formatting and coordinate conversion for the `lsp` tool: one-based↔zero-based UTF-16 cursor
 * conversion, workspace-grouped location rendering with `file:`-URI resolution, diagnostics
 * rendering, complete-result capping, and UI presentation. No I/O — a UI may call the presenter on
 * live streaming and on replay, so it depends only on the tool arguments.
 * @module @deepseek-ai/dsh-tool-lsp/render
 */

import { ToolArgsError, type GenericCallView } from '@deepseek-ai/dsh-tools'
import type { LspDiagnostic, LspHover, LspLocation, LspOperation, LspPosition } from '@deepseek-ai/dsh-lsp'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The five operations the tool exposes, as a runtime tuple for schema enum + validation. */
export const LSP_OPERATIONS: readonly LspOperation[] = ['goToDefinition', 'findReferences', 'goToImplementation', 'hover', 'diagnostics']

/** Default cap on rendered locations before an omission marker is appended. */
export const DEFAULT_MAX_LOCATIONS = 100

/** Default cap on the complete rendered tool result, including truncation metadata. */
export const DEFAULT_MAX_RESULT_CHARS = 16_000

/**
 * Validated `lsp` arguments after coordinate checks. A discriminated union on `operation`: the four
 * cursor-based operations carry a `position`; `diagnostics` is file-scoped and carries none.
 */
export type LspToolInput =
  | { readonly operation: Exclude<LspOperation, 'diagnostics'>; readonly filePath: string; readonly position: LspPosition }
  | { readonly operation: 'diagnostics'; readonly filePath: string }

/**
 * The raw, schema-typed argument shape. `line`/`character` are optional at the schema level because
 * `diagnostics` needs neither; {@link parseLspArgs} enforces them for every other operation.
 */
export interface LspToolArgs {
  readonly operation: string
  readonly file_path: string
  readonly line?: number
  readonly character?: number
}

/**
 * Validate and convert model arguments: `operation` must be one of the five. `line`/`character` are
 * required, positive one-based integers converted to the seam's zero-based position for the four
 * cursor-based operations; `diagnostics` accepts neither. Schema validation already enforces
 * `operation`'s enum and `file_path`'s presence in the full tool pipeline before this runs; these
 * checks stay as a defense-in-depth match for direct callers (and this module's own unit tests).
 * @param args - the schema-validated raw arguments.
 * @returns the validated input with a zero-based position, or the file-scoped diagnostics input.
 * @throws ToolArgsError when the operation is unknown, or a required coordinate is missing/not a positive integer.
 */
export function parseLspArgs(args: LspToolArgs): LspToolInput {
  if (!isOperation(args.operation)) {
    throw new ToolArgsError([`operation must be one of ${LSP_OPERATIONS.join(', ')}`])
  }
  if (args.file_path.trim().length === 0) throw new ToolArgsError(['file_path must be a non-empty string'])
  if (args.operation === 'diagnostics') {
    return { operation: 'diagnostics', filePath: args.file_path }
  }
  if (args.line === undefined || args.character === undefined) {
    throw new ToolArgsError(['line and character are required for goToDefinition, findReferences, goToImplementation, and hover'])
  }
  const line = oneBased(args.line, 'line')
  const character = oneBased(args.character, 'character')
  return {
    operation: args.operation,
    filePath: args.file_path,
    // The model counts from 1; the seam (and protocol) count from 0.
    position: { line: line - 1, character: character - 1 },
  }
}

/** Whether a string is one of the five operations. */
function isOperation(value: string): value is LspOperation {
  return (LSP_OPERATIONS as readonly string[]).includes(value)
}

/** Validate a one-based coordinate is a positive integer. */
function oneBased(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ToolArgsError([`${name} must be a positive integer (one-based)`])
  }
  return value
}

/**
 * Render a locations result grouped by file, converting each zero-based location back to a one-based
 * `path:line:character` entry. A `file:` URI inside the workspace becomes a workspace-relative path;
 * outside it, a URI-derived absolute path; a non-`file:` URI is kept verbatim. Applies `maxLocations` and
 * appends an omission marker when it truncates by count, then applies the complete result cap.
 * @param locations - the seam's locations (possibly empty).
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @param maxLocations - the cap before truncation.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered text; a distinct no-result line when there are none.
 */
export function formatLocations(
  locations: readonly LspLocation[],
  workspaceUri: string,
  maxLocations: number,
  maxResultChars: number,
): string {
  if (locations.length === 0) return boundResult('No results.', maxResultChars, 'locations')
  const shown = locations.slice(0, maxLocations)
  const omitted = locations.length - shown.length
  const grouped = new Map<string, string[]>()
  for (const location of shown) {
    const path = renderUri(location.uri, workspaceUri)
    const line = location.range.start.line + 1
    const character = location.range.start.character + 1
    const entries = grouped.get(path) ?? []
    entries.push(`${path}:${line}:${character}`)
    grouped.set(path, entries)
  }
  const lines: string[] = []
  for (const entries of grouped.values()) lines.push(...entries)
  if (omitted > 0) {
    lines.push(`… ${omitted} more location${omitted === 1 ? '' : 's'} omitted (limit ${maxLocations}).`)
  }
  return boundResult(lines.join('\n'), maxResultChars, 'locations')
}

/**
 * Render a hover result, applying `maxResultChars` last and keeping its marker within the cap.
 * @param hover - the normalized hover, or `null` for no hover.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered hover text; a distinct no-result line for `null`.
 */
export function formatHover(hover: LspHover | null, maxResultChars: number): string {
  const text = hover === null ? 'No hover information.' : hover.contents
  return boundResult(text, maxResultChars, 'hover')
}

/**
 * Render a diagnostics result: one line per diagnostic, one-based line:character, severity, the
 * server's `source` when it supplied one, its rule/error `code` when supplied, then the message.
 * @param diagnostics - the normalized diagnostics for the queried file (possibly empty).
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered diagnostics text; a distinct no-result line for an empty list.
 */
export function formatDiagnostics(diagnostics: readonly LspDiagnostic[], maxResultChars: number): string {
  if (diagnostics.length === 0) return boundResult('No diagnostics.', maxResultChars, 'diagnostics')
  const lines = diagnostics.map((diagnostic) => {
    const line = diagnostic.range.start.line + 1
    const character = diagnostic.range.start.character + 1
    const origin = diagnostic.source === undefined ? diagnostic.severity : `${diagnostic.severity} ${diagnostic.source}`
    const code = diagnostic.code === undefined ? '' : ` (${diagnostic.code})`
    return `${line}:${character} ${origin}${code}: ${diagnostic.message}`
  })
  return boundResult(lines.join('\n'), maxResultChars, 'diagnostics')
}

/** Bound a complete rendered result, including the truncation notice itself. */
function boundResult(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  const notice = `\n… ${label} truncated (limit ${maxChars} characters).`
  if (notice.length >= maxChars) return notice.slice(0, maxChars)
  return `${text.slice(0, maxChars - notice.length)}${notice}`
}

/**
 * Resolve a location URI without applying the harness host's path rules. A valid `file:` URI becomes
 * workspace-relative when it is under the provider's canonical workspace URI, or a URI-derived
 * absolute path otherwise; malformed and non-`file:` URIs remain verbatim.
 * @param uri - the target URI from the seam.
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @returns the display path or the verbatim URI.
 */
export function renderUri(uri: string, workspaceUri: string): string {
  if (!uri.startsWith('file:')) return uri
  let target: URL
  let workspace: URL
  try {
    target = new URL(uri)
    workspace = new URL(workspaceUri)
  } catch {
    return uri
  }
  if (workspace.protocol !== 'file:') return uri
  // A `file:` URI does not carry its world's OS, so a leading `/X:` segment is
  // read as a Windows drive. A POSIX workspace literally rooted at `/c:/...`
  // would mis-render (display only; edits and reads use the exact URI).
  const drivePath = /^\/[a-z](?::|%3A)/iu
  const windowsWorld = workspace.hostname.length > 0 || drivePath.test(workspace.pathname)
  const targetWindowsWorld = windowsWorld && (target.hostname.length > 0 || drivePath.test(target.pathname))
  const workspacePath = filePath(workspace, windowsWorld)
  const targetPath = filePath(target, targetWindowsWorld)
  if (workspacePath === undefined || targetPath === undefined) return uri
  if (windowsWorld !== targetWindowsWorld) return targetPath
  const path = windowsWorld ? win32 : posix
  const relative = path.relative(workspacePath, targetPath)
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  const rendered = relative === '' ? '.' : outside ? targetPath : relative
  return windowsWorld ? rendered.replaceAll('\\', '/') : rendered
}

/** Decode a file URL for its execution world while containing malformed URL failures. */
function filePath(url: URL, windows: boolean): string | undefined {
  try {
    const path = fileURLToPath(url, { windows })
    return path.includes('\0') ? undefined : path
  } catch {
    // `fileURLToPath` rejects malformed escapes, authorities, and encoded path separators.
    return undefined
  }
}

/**
 * UI presentation for a pending `lsp` call. Uses a generic search card; the title carries the
 * operation and, for a cursor-based operation, the one-based cursor — `locations` focuses the
 * queried line. `diagnostics` carries no cursor, so the title and location omit it.
 * @param args - the raw tool arguments.
 * @returns the generic call view.
 */
export function presentLspCall(args: LspToolArgs): GenericCallView {
  const cursor = args.line === undefined || args.character === undefined ? '' : `:${args.line}:${args.character}`
  return {
    card: 'generic',
    kind: 'search',
    title: `LSP ${args.operation} ${args.file_path}${cursor}`,
    locations: [{ path: args.file_path, ...args.line === undefined ? {} : { line: args.line } }],
  }
}
