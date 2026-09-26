/**
 * Decode hook process outcomes for both dialects. Exit 0 may carry structured
 * JSON or plain stdout; exit 2 blocks with stderr as the reason; every other
 * exit is a non-blocking error. Bridges decide which recognized fields apply.
 * @module @deepseek-ai/dsh-hook-protocol/codec
 */

import type { HookOutput, HookRequestPatch } from './types.ts'

/** The exit code a hook uses to signal a blocking error (stderr → model). */
const BLOCKING_EXIT_CODE = 2

/** Read a string field from a parsed object, or `undefined` if absent/wrong type. */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

/** Read a boolean field, or `undefined` if absent/wrong type. */
function bool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key]
  return typeof v === 'boolean' ? v : undefined
}

/** A plain (non-null, non-array) object, or `undefined`. */
function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The legacy TOP-LEVEL `decision` is only `approve`/`block` in both reference
 * schemas — `allow`/`deny`/`ask` are reserved for `hookSpecificOutput.
 * permissionDecision`. So an out-of-band `{"decision":"deny"}` is invalid and
 * ignored here (it must not become a real blocking decision).
 */
function topLevelDecisionOf(value: string | undefined): HookOutput['decision'] {
  return value === 'approve' || value === 'block' ? value : undefined
}

/** A `hookSpecificOutput.permissionDecision` is `allow`/`deny`/`ask` only. */
function permissionDecisionOf(value: string | undefined): HookOutput['decision'] {
  return value === 'allow' || value === 'deny' || value === 'ask' ? value : undefined
}

/**
 * Decode process output into a dialect-neutral hook outcome. This function is
 * total: malformed JSON remains plain stdout. When `expectedEventName` is set,
 * a missing or different `hookSpecificOutput.hookEventName` discards only its
 * event-scoped fields; top-level fields and the claimed discriminator remain.
 * Omitting the guard applies the block as-is.
 * @param exitCode - process exit, or `undefined` when spawn failed.
 * @param stdout - output parsed as structured JSON only on exit 0.
 * @param stderr - the captured stderr stream; becomes the blocking `reason` on exit 2.
 * @param expectedEventName - firing event used to guard hook-specific fields; omit to disable the guard.
 * @returns the dialect-neutral decoded outcome.
 */
export function parseHookOutput(exitCode: number | undefined, stdout: string, stderr: string, expectedEventName?: string): HookOutput {
  const trimmedErr = stderr.trim()
  const trimmedOut = stdout.trim()
  // Plain stdout remains available even when it is not JSON.
  const output: HookOutput = { exitCode, stderr: trimmedErr, stdout: trimmedOut }

  // Both dialects treat exit 2 as a block with stderr as its reason.
  if (exitCode === BLOCKING_EXIT_CODE) {
    output.decision = 'block'
    if (trimmedErr.length > 0) output.reason = trimmedErr
  }

  // Structured stdout is valid only for a clean exit.
  if (exitCode === 0) decodeStructured(output, trimmedOut, expectedEventName)

  return output
}

/**
 * Decode a hook TRANSPORT's clean response body — an HTTP hook's response body,
 * which has no process exit code. The body follows the same rules as a
 * command hook's clean-exit stdout: JSON when it looks like an object, plain
 * text otherwise.
 * @param body - the response body text.
 * @param expectedEventName - firing event used to guard hook-specific fields; omit to disable the guard.
 * @returns the decoded outcome with no exit code and empty stderr.
 */
export function parseHookBody(body: string, expectedEventName?: string): HookOutput {
  const trimmed = body.trim()
  const output: HookOutput = { exitCode: undefined, stderr: '', stdout: trimmed }
  decodeStructured(output, trimmed, expectedEventName)
  return output
}

/**
 * Fold a clean-exit stdout (or clean HTTP response body) into `output`: JSON
 * only when the text looks like an object, so other stdout stays plain text.
 */
function decodeStructured(output: HookOutput, trimmedOut: string, expectedEventName?: string): void {
  if (!trimmedOut.startsWith('{')) return
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = obj(JSON.parse(trimmedOut))
  } catch {
    // Malformed JSON on a clean exit = no structured output (lenient, as the
    // reference engines are). The plain stdout remains the bridge's to use.
    parsed = undefined
  }
  if (parsed) applyStructured(output, parsed, expectedEventName)
}

/**
 * Fold a parsed structured-stdout object into `output` (mutates in place).
 * `expectedEventName` (the firing event) gates the per-event `hookSpecificOutput`
 * block: a block whose `hookEventName` names a different event — OR omits it — has
 * its event-scoped fields discarded (any present `hookEventName` is still recorded).
 */
function applyStructured(output: HookOutput, parsed: Record<string, unknown>, expectedEventName?: string): void {
  const cont = bool(parsed, 'continue')
  if (cont !== undefined) output.continue = cont
  const stopReason = str(parsed, 'stopReason')
  if (stopReason !== undefined) output.stopReason = stopReason
  const sysMsg = str(parsed, 'systemMessage')
  if (sysMsg !== undefined) output.systemMessage = sysMsg

  // Top-level legacy `decision` (approve/block ONLY — allow/deny/ask there are
  // invalid per both schemas) + its `reason`.
  const topDecision = topLevelDecisionOf(str(parsed, 'decision'))
  if (topDecision !== undefined) output.decision = topDecision
  const topReason = str(parsed, 'reason')
  if (topReason !== undefined) output.reason = topReason

  // hookSpecificOutput: the per-event channel, keyed by `hookEventName`. The
  // permissionDecision (allow/deny/ask) OVERRIDES the legacy top-level decision;
  // additionalContext and updatedInput live here too.
  const hso = obj(parsed.hookSpecificOutput)
  if (hso) {
    const eventName = str(hso, 'hookEventName')
    // Always surface the discriminator (for the log/diagnostics), even on a
    // mismatch — the record should show what the malformed block claimed.
    if (eventName !== undefined) output.hookEventName = eventName
    // A missing or mismatched discriminator cannot affect the firing event.
    if (expectedEventName !== undefined && eventName !== expectedEventName) {
      return
    }
    const permission = permissionDecisionOf(str(hso, 'permissionDecision'))
    if (permission !== undefined) output.decision = permission
    const permissionReason = str(hso, 'permissionDecisionReason')
    if (permissionReason !== undefined) output.reason = permissionReason
    const addCtx = str(hso, 'additionalContext')
    if (addCtx !== undefined) output.additionalContext = addCtx
    const updated = obj(hso.updatedInput)
    if (updated !== undefined) output.updatedInput = updated
    const request = requestPatchOf(hso.request)
    if (request !== undefined) output.requestPatch = request
    const allowTools = allowToolsOf(hso.allowTools)
    if (allowTools !== undefined) output.allowTools = allowTools
  }
}

/**
 * Read the model-level `request` patch: only the declared keys with a valid
 * value are kept, so a hook cannot smuggle a field the loop does not own.
 * `unsafe` (above the allocation-safe integer range) and non-positive caps fall
 * back to the unchanged request.
 */
function requestPatchOf(value: unknown): HookRequestPatch | undefined {
  const raw = obj(value)
  if (raw === undefined) return undefined
  const patch: HookRequestPatch = {}
  const provider = str(raw, 'provider')
  if (provider !== undefined && provider.length > 0) patch.provider = provider
  const model = str(raw, 'model')
  if (model !== undefined && model.length > 0) patch.model = model
  const reasoningEffort = str(raw, 'reasoningEffort')
  if (reasoningEffort !== undefined && reasoningEffort.length > 0) patch.reasoningEffort = reasoningEffort
  const maxTokens = raw.maxTokens
  if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0) patch.maxTokens = maxTokens
  return Object.keys(patch).length > 0 ? patch : undefined
}

/** Read the tool allow-list: every entry must be a name, else the field is unusable. */
function allowToolsOf(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(name => typeof name === 'string')
    ? [...value]
    : undefined
}
