/**
 * Post-edit diagnostics enrichment: after a configured tool (`edit`/`write` by default) succeeds,
 * best-effort queries `ctx.lsp` for the touched file's current diagnostics and, when any exist,
 * attaches them as additional context alongside the tool's own result — the "diagnostics after every
 * edit" behavior competing harnesses ship (§30.3 D, CQ1 of the evolution spec). A missing session
 * workspace, an unrouted file extension, a provider failure or timeout, or an empty diagnostics list
 * all degrade silently: this plugin never turns a successful edit into a failure, and never floods
 * context with a "No diagnostics." line on every clean edit.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-lsp-post-edit-diagnostics
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import { DEFAULT_MAX_RESULT_CHARS, formatDiagnostics, sessionCwd } from '@deepseek-ai/dsh-tool-lsp'
import type { LspDiagnostic } from '@deepseek-ai/dsh-lsp'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'lsp-post-edit-diagnostics': { kind: 'lsp-post-edit-diagnostics' } & ContextFormed
  }
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'lsp-post-edit-diagnostics'

/** Services required by this plugin. */
export const inject = ['tools', 'lsp']

/** Plugin configuration: which tool calls trigger enrichment, and the rendered-text cap. */
export interface Config {
  /** Tool names whose successful calls trigger a diagnostics lookup. Default `['edit', 'write']`. */
  toolNames?: string[]
  /** Largest rendered diagnostics text, including truncation metadata (default 16000). */
  maxResultChars?: number
}

export const Config: z<Config> = z.object({
  toolNames: z.array(String).default(['edit', 'write']),
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
})

type ResolvedConfig = Required<Config>

const CONTEXT_SOURCE: MessageSource = { kind: 'lsp-post-edit-diagnostics' }

/**
 * Register the `tools/post-execute` listener.
 * @param ctx - the plugin context (must inject `tools`, `lsp`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)
  if (resolved.toolNames.length === 0) {
    throw new Error('lsp-post-edit-diagnostics: toolNames must be a non-empty array')
  }
  const toolNames = new Set(resolved.toolNames)

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    // Only enrich a call this plugin is configured for, whose underlying dispatch actually
    // succeeded, and that no later listener already turned into a block.
    if (decision.kind !== 'accept' || result.isError || !toolNames.has(exec.name)) return decision
    const filePath = filePathArg(exec.arguments)
    if (filePath === undefined) return decision
    const workspaceRoot = sessionCwd(exec)
    if (workspaceRoot === undefined) return decision
    const diagnostics = await queryDiagnostics(ctx, filePath, workspaceRoot, exec.signal)
    if (diagnostics === undefined || diagnostics.length === 0) return decision
    const text = `Diagnostics for ${filePath}:\n${formatDiagnostics(diagnostics, resolved.maxResultChars)}`
    return {
      ...decision,
      additionalContexts: [
        ...decision.additionalContexts ?? [],
        createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }),
      ],
    }
  })
}

/**
 * Query diagnostics for the touched file, swallowing every failure (no route for the extension, no
 * language server configured, a provider crash, or the call's own signal aborting): the edit already
 * succeeded and stands on its own, so diagnostics are a best-effort addition, never a blocker.
 */
async function queryDiagnostics(
  ctx: Context,
  filePath: string,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<readonly LspDiagnostic[] | undefined> {
  try {
    const result = await ctx.lsp.query({ operation: 'diagnostics', filePath, workspaceRoot }, signal)
    /* v8 ignore next -- the seam always returns the requested operation's result kind; defensive. */
    return result.kind === 'diagnostics' ? result.diagnostics : undefined
  } catch {
    return undefined
  }
}

/** Read `file_path` from a tool call's raw arguments, when present and a string. */
function filePathArg(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>).file_path
  return typeof value === 'string' ? value : undefined
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`lsp-post-edit-diagnostics: ${name} must be a positive integer`)
  }
}
