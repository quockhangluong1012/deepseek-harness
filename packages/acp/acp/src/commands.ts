/**
 * Command advertisement and dispatch: the live command registry projected into
 * the ACP `available_commands_update` session update one agent's client sees,
 * and the interception that turns one submitted prompt line into a command
 * execution.
 *
 * The registry is read opportunistically (`ctx.get('commands')`) rather than
 * injected: an ACP host without the command surface still serves sessions, and
 * it simply advertises nothing. The projection is per agent because scoped
 * commands shadow globals for exactly one agent.
 *
 * @module @deepseek-ai/dsh-acp/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AvailableCommand, ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: declares `ctx.commands` and the registry's events without
// loading the registry, which an ACP host without the command surface omits.
import type {} from '@deepseek-ai/dsh-commands'

/**
 * The line form the command registry admits: a leading slash, a lowercase name
 * of letters, digits, `_` or `-`, then end-of-input or whitespace. A chat
 * prompt that merely starts with a path (`/tmp/x is broken`) is not a command.
 *
 * The registry owns this grammar (`parseCommand`); the expression is repeated
 * here because this module must load without the optional registry package.
 */
const COMMAND_LINE = /^\/[a-z][a-z0-9_-]*(?=$|[\t\n\r ])/u

/**
 * Build the client's complete command view for one agent.
 * @param ctx - bridge context that may carry the command registry.
 * @param agent - the exact session agent whose scope resolves the commands.
 * @returns the replacement update, or undefined when no registry is composed.
 */
export function availableCommandsUpdate(ctx: Context, agent: Agent): SessionUpdate | undefined {
  const commands = ctx.get('commands')
  if (commands === undefined) return undefined
  const availableCommands: AvailableCommand[] = commands.list(agent).map(descriptor => ({
    name: descriptor.name,
    description: descriptor.description,
    ...descriptor.input === undefined ? {} : { input: { hint: descriptor.input.hint } },
  }))
  return { sessionUpdate: 'available_commands_update', availableCommands }
}

/**
 * The command line one ACP prompt carries, when it carries one.
 *
 * ACP submits a human request as prompt content, so the bridge makes the
 * decision a composer makes elsewhere. Only a single text block qualifies: a
 * media prompt is never a command invocation, because command handlers receive
 * attachments through the receipt-bearing submit channel of the dispatching UI,
 * which an ACP prompt does not carry.
 *
 * @param prompt - untrusted ACP prompt blocks in wire order.
 * @returns the exact command line, or `undefined` when the prompt is not one.
 */
export function commandLine(prompt: readonly ContentBlock[]): string | undefined {
  const block = prompt[0]
  if (prompt.length !== 1 || block === undefined || block.type !== 'text') return undefined
  return COMMAND_LINE.test(block.text) ? block.text : undefined
}
