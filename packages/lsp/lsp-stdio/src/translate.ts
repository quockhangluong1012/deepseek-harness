/**
 * Pure protocol translation for the local host: what the server's capabilities allow, and how its
 * `Location`/`LocationLink`/`Hover`/`Diagnostic` payloads normalize into the seam's closed result
 * unions. No I/O or process state — every function here is a pure transform, which the fake-stdio
 * tests pin exactly.
 * @module @deepseek-ai/dsh-lsp-stdio/translate
 */

import type {
  LspDiagnostic,
  LspDiagnosticSeverity,
  LspHover,
  LspLocation,
  LspOperation,
  LspRange,
} from '@deepseek-ai/dsh-lsp'
import { LspError } from '@deepseek-ai/dsh-lsp'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  WireDiagnosticSeverity,
  WireHover,
  WireLocation,
  WireLocationLink,
  WireMarkedString,
  WireProviderCapability,
  WireRange,
  WireServerCapabilities,
  WireTextDocumentSyncKind,
} from './protocol.ts'

/**
 * The `textDocument/*` request method for each cursor-based LSP operation (`diagnostics` uses no
 * request; it is a push notification the connection subscribes to).
 * @param operation - the LSP operation to map.
 * @returns the LSP request method name.
 */
export function requestMethod(operation: Exclude<LspOperation, 'diagnostics'>): string {
  switch (operation) {
    case 'goToDefinition': return 'textDocument/definition'
    case 'findReferences': return 'textDocument/references'
    case 'goToImplementation': return 'textDocument/implementation'
    case 'hover': return 'textDocument/hover'
    /* v8 ignore next -- exhaustive over the closed operation union; unreachable. */
    default: return assertNever(operation, 'requestMethod')
  }
}

/** The `ServerCapabilities` provider field backing each cursor-based operation. */
function capabilityValue(capabilities: WireServerCapabilities, operation: Exclude<LspOperation, 'diagnostics'>): WireProviderCapability {
  switch (operation) {
    case 'goToDefinition': return capabilities.definitionProvider
    case 'findReferences': return capabilities.referencesProvider
    case 'goToImplementation': return capabilities.implementationProvider
    case 'hover': return capabilities.hoverProvider
    /* v8 ignore next -- exhaustive over the closed operation union; unreachable. */
    default: return assertNever(operation, 'capabilityValue')
  }
}

/** A provider capability is present when the server sent `true` or an options object (not `false`/absent). */
function supportsCapability(value: WireProviderCapability): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return true
}

/**
 * Whether the server advertises the requested operation. `diagnostics` is always considered
 * supported: it rides `textDocument/publishDiagnostics`, a push notification the protocol does not
 * gate behind a `ServerCapabilities` provider field — a server that never publishes anything for a
 * file legitimately means "no diagnostics", not "unsupported".
 * @param capabilities - the server's `initialize` capabilities.
 * @param operation - the LSP operation to check.
 * @returns true when the corresponding provider capability is present.
 */
export function supportsOperation(capabilities: WireServerCapabilities, operation: LspOperation): boolean {
  if (operation === 'diagnostics') return true
  return supportsCapability(capabilityValue(capabilities, operation))
}

/**
 * Whether a `textDocumentSync` value permits the transient `didOpen`/`didClose` this host relies on.
 * The legacy enum form implies open/close for `Full`/`Incremental`; the options form requires an
 * explicit `openClose: true`, because the protocol defaults an omitted `openClose` to false.
 * @param sync - the server's advertised `textDocumentSync` capability.
 * @returns true when transient open/close is supported.
 */
export function supportsTransientOpen(sync: WireServerCapabilities['textDocumentSync']): boolean {
  if (sync === undefined) return false
  if (typeof sync === 'number') return isOpenCloseKind(sync)
  return sync.openClose === true
}

/** Legacy enum: `Full` (1) or `Incremental` (2) imply open/close support; `None` (0) does not. */
function isOpenCloseKind(kind: WireTextDocumentSyncKind): boolean {
  return kind === 1 || kind === 2
}

/**
 * Normalize the negotiated position encoding. An omitted encoding defaults to `utf-16`; any value
 * other than `utf-16` is a protocol error this host does not support.
 * @param encoding - the server's advertised `positionEncoding`, if any.
 * @returns the string `'utf-16'`.
 * @throws Error for any non-`utf-16` encoding.
 */
export function negotiatePositionEncoding(encoding: string | undefined): 'utf-16' {
  if (encoding === undefined || encoding === 'utf-16') return 'utf-16'
  throw new Error(`server negotiated unsupported position encoding "${encoding}"; this host requires utf-16`)
}

/** Convert a wire range to the seam's range (structurally identical, but re-shaped as `readonly`). */
function toRange(range: WireRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

/** Whether a record is a `LocationLink` (has `targetUri` + `targetSelectionRange`). */
function isLocationLink(value: Record<string, unknown>): boolean {
  return typeof value.targetUri === 'string' && isRange(value.targetSelectionRange)
}

/** Whether a record is a `Location` (has string `uri` + a range). */
function isLocation(value: Record<string, unknown>): boolean {
  return typeof value.uri === 'string' && isRange(value.range)
}

/** Structural range guard used by both location shapes. */
function isRange(value: unknown): value is WireRange {
  if (value === null || typeof value !== 'object') return false
  const range = value as Record<string, unknown>
  return isPosition(range.start) && isPosition(range.end)
}

/** Structural position guard. */
function isPosition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const position = value as Record<string, unknown>
  return isProtocolCoordinate(position.line) && isProtocolCoordinate(position.character)
}

/** Whether a wire coordinate is a valid nonnegative integer. */
function isProtocolCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Normalize a navigation result (`Location`, `Location[]`, `LocationLink[]`, or `null`) to the seam's
 * locations. `Location` maps directly; `LocationLink` maps `targetUri` + `targetSelectionRange`.
 * @param payload - the raw `textDocument/definition|references|implementation` result.
 * @returns the normalized locations (empty for `null`/`[]`).
 * @throws Error when an element is neither a `Location` nor a `LocationLink`.
 */
export function normalizeLocations(payload: unknown): LspLocation[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP navigation result was missing')
  const elements = Array.isArray(payload) ? payload : [payload]
  const locations: LspLocation[] = []
  for (const element of elements) {
    if (element === null || typeof element !== 'object') {
      throw malformedResponse('LSP navigation result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (isLocationLink(record)) {
      const link = record as unknown as WireLocationLink
      locations.push({ uri: link.targetUri, range: toRange(link.targetSelectionRange) })
    } else if (isLocation(record)) {
      const location = record as unknown as WireLocation
      locations.push({ uri: location.uri, range: toRange(location.range) })
    } else {
      throw malformedResponse('LSP navigation result contained neither a Location nor a LocationLink')
    }
  }
  return locations
}

/** Render one `MarkedString` (string form verbatim; object form as a language-tagged fenced block). */
function renderMarkedString(value: WireMarkedString): string {
  if (typeof value === 'string') return value
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

/**
 * Normalize a `Hover` (or `null`) to the seam's hover. `MarkupContent` uses its `value`; a string
 * `MarkedString` is verbatim; a language-tagged `MarkedString` becomes a fenced code block; an array
 * joins its rendered parts with one blank line. The model-facing tool owns the complete result cap.
 * @param payload - the raw `textDocument/hover` result.
 * @returns the normalized hover, or `null` when there is no content.
 * @throws Error when the payload is a non-null, non-object, or structurally invalid hover.
 */
export function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null) return null
  if (payload === undefined) throw malformedResponse('LSP hover result was missing')
  if (typeof payload !== 'object') throw malformedResponse('LSP hover result was not an object')
  const hover = payload as WireHover
  const contents = renderHoverContents(hover.contents)
  if (contents === '') return null
  const range = hover.range
  if (range === undefined) return { contents }
  if (!isRange(range)) throw malformedResponse('LSP hover result contained a malformed range')
  return { contents, range: toRange(range) }
}

/** Render the three `Hover.contents` encodings into one string (input is untrusted wire data). */
function renderHoverContents(contents: unknown): string {
  if (contents === null || contents === undefined) {
    throw malformedResponse('LSP hover result had no contents')
  }
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((value) => {
      if (isMarkedString(value)) return renderMarkedString(value)
      throw malformedResponse('LSP hover contents contained a malformed MarkedString')
    }).join('\n\n')
  }
  if (typeof contents !== 'object') {
    throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
  }
  const record = contents as Record<string, unknown>
  if (record.kind === 'markdown' || record.kind === 'plaintext') {
    if (typeof record.value !== 'string') {
      throw malformedResponse('LSP hover MarkupContent value was not a string')
    }
    return record.value
  }
  if (typeof record.language === 'string' && typeof record.value === 'string') {
    return renderMarkedString({ language: record.language, value: record.value })
  }
  throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
}

/** Whether an untrusted value is either form of `MarkedString`. */
function isMarkedString(value: unknown): value is WireMarkedString {
  if (typeof value === 'string') return true
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.language === 'string' && typeof record.value === 'string'
}

/**
 * Normalize a `textDocument/publishDiagnostics` notification's `diagnostics` array to the seam's
 * diagnostics. An absent `severity` defaults to `error`, matching the wire spec's own default.
 * @param payload - the raw `diagnostics` array from a `publishDiagnostics` notification.
 * @returns the normalized diagnostics (empty for `[]`).
 * @throws Error when the payload is not an array, or an element is not a well-formed `Diagnostic`.
 */
export function normalizeDiagnostics(payload: unknown): LspDiagnostic[] {
  if (!Array.isArray(payload)) throw malformedResponse('LSP publishDiagnostics payload was not an array')
  return payload.map((element) => {
    if (element === null || typeof element !== 'object') {
      throw malformedResponse('LSP diagnostics result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (!isRange(record.range)) throw malformedResponse('LSP diagnostic contained a malformed range')
    if (typeof record.message !== 'string') throw malformedResponse('LSP diagnostic was missing a message')
    if (record.source !== undefined && typeof record.source !== 'string') {
      throw malformedResponse('LSP diagnostic source was not a string')
    }
    if (record.code !== undefined && typeof record.code !== 'string'
      && !(typeof record.code === 'number' && Number.isInteger(record.code))) {
      throw malformedResponse('LSP diagnostic code was not a string or integer')
    }
    return {
      range: toRange(record.range),
      severity: normalizeSeverity(record.severity),
      message: record.message,
      ...typeof record.source === 'string' ? { source: record.source } : {},
      ...typeof record.code === 'string' || typeof record.code === 'number' ? { code: String(record.code) } : {},
    }
  })
}

/** Map the wire severity enum; only an omitted severity has the LSP default of `Error`. */
function normalizeSeverity(value: unknown): LspDiagnosticSeverity {
  if (value === undefined) return 'error'
  if (!isWireSeverity(value)) throw malformedResponse('LSP diagnostic severity was not an integer from 1 through 4')
  switch (value) {
    case 1: return 'error'
    case 2: return 'warning'
    case 3: return 'information'
    case 4: return 'hint'
    /* v8 ignore next -- exhaustive over the closed WireDiagnosticSeverity union; unreachable. */
    default: return assertNever(value, 'normalizeSeverity')
  }
}

/** Whether an untrusted value is a valid `DiagnosticSeverity` (1-4). */
function isWireSeverity(value: unknown): value is WireDiagnosticSeverity {
  return value === 1 || value === 2 || value === 3 || value === 4
}

/** Create the stable structured error used for malformed server result payloads. */
function malformedResponse(message: string): LspError {
  return new LspError(message, 'LSP_MALFORMED_RESPONSE')
}
