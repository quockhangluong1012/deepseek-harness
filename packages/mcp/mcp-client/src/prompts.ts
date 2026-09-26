/**
 * MCP prompt templates as human commands: the `prompts/list` result of one
 * server registers on the existing `ctx.commands` registry, one
 * server-qualified command per prompt.
 *
 * A command's settled text is the rendered template. It is never submitted to
 * the model on the server's behalf — the command registry records it in the
 * human command plane and the model sees no message — so a server's prompt
 * text cannot become model context through this path.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import { createHash } from 'node:crypto'
import type { Client, ContentBlock, GetPromptResult, Prompt } from '@modelcontextprotocol/client'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { publicToolName } from './tools.ts'

/** Hex characters of the identity hash appended when case-folding changes a command name. */
const IDENTITY_HASH_LENGTH = 12

/** Resolved options for prompt registration. */
export interface PromptBridgeOptions {
  /** Local namespace qualifying every command name. */
  serverName: string
  /** Timeout for one `prompts/get` request in milliseconds. */
  toolCallTimeoutMs: number
}

/** State for one prompt generation: the live command registrations keyed by command name. */
export type PromptDisposers = Map<string, () => void>

/**
 * One argument-parsing outcome: the exact `prompts/get` arguments, or the reason
 * the human's input does not fit the prompt's declared arguments.
 */
type PromptArguments =
  | { readonly ok: true; readonly arguments: Record<string, string> }
  | { readonly ok: false; readonly message: string }

/**
 * Derive the command name for one MCP prompt. Commands are lowercase
 * (`^[a-z][a-z0-9_-]*$`), so a name that is not already lowercase is
 * case-folded and tagged with a digest of the identity — two servers whose
 * names differ only by case never claim one command name.
 *
 * @param serverName - stable namespace from plugin config.
 * @param rawName - the MCP server's own prompt name.
 * @returns the command name without the leading slash.
 */
export function publicPromptCommandName(serverName: string, rawName: string): string {
  const name = publicToolName(serverName, rawName)
  if (name === name.toLowerCase()) return name
  const digest = createHash('sha256').update(`prompt\0${serverName}\0${rawName}`).digest('hex').slice(0, IDENTITY_HASH_LENGTH)
  return `${name.toLowerCase()}_${digest}`
}

/**
 * Fill one prompt's declared arguments from the invocation's raw input.
 *
 * A prompt declaring no argument takes none. One declaring exactly one takes
 * the whole (trimmed) input, separator spaces included. One declaring more
 * takes whitespace-separated values in declaration order; any other count is
 * refused rather than guessed at, and the server still decides whether a
 * declared argument is required.
 *
 * @param declared - the prompt's declared argument names, in order.
 * @param rawInput - verbatim text following the command name.
 * @returns the `prompts/get` arguments, or the refusal message.
 */
function promptArguments(declared: readonly string[], rawInput: string): PromptArguments {
  const input = rawInput.trim()
  if (declared.length === 0) {
    return input === ''
      ? { ok: true, arguments: {} }
      : { ok: false, message: 'this prompt takes no arguments' }
  }
  if (declared.length === 1) {
    const single: Record<string, string> = {}
    for (const name of declared) single[name] = input
    return { ok: true, arguments: single }
  }
  const parts = input === '' ? [] : input.split(/\s+/)
  const filled: Record<string, string> = {}
  for (const [index, name] of declared.entries()) {
    const value = parts[index]
    if (value === undefined) {
      return { ok: false, message: `this prompt expects ${declared.length} arguments (${declared.join(' ')}) but got ${parts.length}` }
    }
    filled[name] = value
  }
  if (parts.length > declared.length) {
    return { ok: false, message: `this prompt expects ${declared.length} arguments (${declared.join(' ')}) but got ${parts.length}` }
  }
  return { ok: true, arguments: filled }
}

/** Render one content block that is not text as a bounded description. */
function describeBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text
    case 'image':
    case 'audio': return `[${block.type}: ${block.mimeType}]`
    case 'resource_link': return `[resource link: ${block.uri}]`
    case 'resource': return `[embedded resource: ${block.resource.uri}]`
    /* v8 ignore next 2 -- SDK content is a closed union today; a future member renders as a description */
    default: return '[unsupported prompt content]'
  }
}

/** Render one `prompts/get` result as the command's text. */
function renderPrompt(result: GetPromptResult): string {
  return result.messages
    .map((message) => {
      const blocks = Array.isArray(message.content) ? message.content : [message.content]
      return `${message.role}: ${blocks.map((block: ContentBlock) => describeBlock(block)).join('\n')}`
    })
    .join('\n')
}

/**
 * Sync one MCP server's prompt list into the harness command registry.
 *
 * The registry is optional: with no `ctx.commands` mounted this is a no-op. A
 * discovery failure keeps the previous generation registered, and one command
 * the registry refuses (a name a sibling already owns) leaves the rest of this
 * server's prompts registered — a prompt is a human convenience and never
 * fails the connection that owns the tools.
 *
 * @param client - connected MCP client used to list and get prompts.
 * @param ctx - context providing the command registry and logger.
 * @param opts - server namespace and per-request timeout.
 * @param previous - disposer map from the prior generation.
 * @returns the disposers of the live generation, keyed by command name.
 */
export async function syncPrompts(
  client: Client,
  ctx: Context,
  opts: PromptBridgeOptions,
  previous: PromptDisposers,
): Promise<PromptDisposers> {
  const commands = ctx.get('commands')
  if (commands === undefined) return previous
  const label = `mcp-client(${opts.serverName})`
  let prompts: readonly Prompt[]
  try {
    prompts = client.getServerCapabilities()?.prompts === undefined
      ? []
      : (await client.listPrompts(undefined, { cacheMode: 'refresh' })).prompts
  } catch (error) {
    ctx.logger.error(`${label}: prompt discovery failed: ${String(error)}`)
    return previous
  }

  const definitions = new Map<string, CommandDefinition>()
  for (const prompt of prompts) {
    const name = publicPromptCommandName(opts.serverName, prompt.name)
    if (definitions.has(name)) {
      ctx.logger.error(`${label}: server listed prompt "${prompt.name}" more than once — the duplicate is skipped`)
      continue
    }
    const declared = (prompt.arguments ?? []).map(argument => argument.name)
    definitions.set(name, {
      name,
      description: prompt.description ?? `MCP prompt from server "${opts.serverName}"`,
      ...declared.length === 0 ? {} : { input: { hint: declared.map(argument => `<${argument}>`).join(' ') } },
      handler: async ({ rawInput, signal }) => {
        const parsed = promptArguments(declared, rawInput)
        if (!parsed.ok) return { kind: 'error', text: `${label}: prompt "${prompt.name}": ${parsed.message}` }
        try {
          const result = await client.getPrompt(
            { name: prompt.name, arguments: parsed.arguments },
            { signal, timeout: opts.toolCallTimeoutMs },
          )
          return { kind: 'success', text: renderPrompt(result) }
        } catch (error) {
          return { kind: 'error', text: `${label}: prompt "${prompt.name}" failed: ${String(error)}` }
        }
      },
    })
  }

  for (const dispose of previous.values()) dispose()
  const disposers: PromptDisposers = new Map()
  for (const [name, definition] of definitions) {
    try {
      disposers.set(name, commands.register(definition))
    } catch (error) {
      ctx.logger.error(`${label}: prompt command "${name}" was not registered: ${String(error)}`)
    }
  }
  return disposers
}
