/**
 * Human inspection commands that report what this deployment has mounted:
 * `/help` over the command catalog, `/doctor` over the deployment checks and
 * environment facts, and `/mcp`, `/agents`, and `/hooks` over the configured
 * capability surfaces.
 *
 * Every command is read-only, answers in the UI command plane, and appends no
 * session event.
 *
 * @module @deepseek-ai/dsh-command-inspect
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { CommandDescriptor, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-fs'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { groupMcpServers, renderDoctorReport, runDoctorChecks } from './doctor.ts'

export const name = 'command-inspect'
/** Services the inspection commands read; every optional one is resolved with `ctx.get`. */
export const inject = ['commands', 'llm', 'tools']

/** Argument grammar for `/help`; anything else reports usage. */
const HELP_USAGE = 'Usage: /help'
/** Argument grammar for `/doctor`; anything else reports usage. */
const DOCTOR_USAGE = 'Usage: /doctor'
/** Argument grammar for `/mcp`; anything else reports usage. */
const MCP_USAGE = 'Usage: /mcp'
/** Argument grammar for `/agents`; anything else reports usage. */
const AGENTS_USAGE = 'Usage: /agents'
/** Argument grammar for `/hooks`; anything else reports usage. */
const HOOKS_USAGE = 'Usage: /hooks'

/** Loader module-name prefixes that identify the hook bridges. */
const HOOK_BRIDGE_PREFIXES = ['@deepseek-ai/dsh-hooks-'] as const

/** Reject any argument for a command that takes none. */
function rejectsArguments(invocation: CommandInvocation, usage: string): CommandResult | undefined {
  return invocation.rawInput.trim().length === 0 ? undefined : { kind: 'error', text: usage }
}

/** One command line: its invoked spelling, argument hint, and summary. */
function formatCommand(descriptor: CommandDescriptor): string {
  const hint = descriptor.input?.hint
  const invocation = hint === undefined ? `/${descriptor.name}` : `/${descriptor.name} ${hint}`
  return `- ${invocation} — ${descriptor.description}`
}

/** List every command the invoking agent can reach. */
function executeHelp(ctx: Context, invocation: CommandInvocation): CommandResult {
  const usage = rejectsArguments(invocation, HELP_USAGE)
  if (usage !== undefined) return usage
  const descriptors = ctx.commands.list(invocation.agent)
  if (descriptors.length === 0) return { kind: 'success', text: 'No commands are registered.' }
  return {
    kind: 'success',
    text: `${String(descriptors.length)} command(s):\n${descriptors.map(formatCommand).join('\n')}`,
  }
}

/** Provider routes with the model count each adapter advertises. */
async function providerLines(ctx: Context, signal: AbortSignal): Promise<string[]> {
  const lines: string[] = []
  for (const provider of ctx.llm.listProviders()) {
    signal.throwIfAborted()
    let detail = 'models unknown'
    try {
      detail = `${String((await ctx.llm.listModels(provider.id)).length)} model(s)`
    } catch {
      signal.throwIfAborted()
      // A dormant or unreachable provider is reported, not treated as fatal:
      // the doctor's job is to say what is wrong, not to fail with it.
      detail = 'models unavailable'
    }
    lines.push(`- ${provider.id} (${provider.name}): ${detail}`)
  }
  return lines
}

/**
 * Report the doctor's checks — sandbox, provider keys, MCP, LSP, and disk —
 * followed by the environment facts this deployment can observe: provider
 * routes, callable tools, mounted hook bridges, and the optional filesystem
 * and storage capabilities.
 */
async function executeDoctor(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const usage = rejectsArguments(invocation, DOCTOR_USAGE)
  if (usage !== undefined) return usage
  const lines = [renderDoctorReport(await runDoctorChecks(ctx, invocation.agent.session))]
  const providers = await providerLines(ctx, invocation.signal)
  lines.push(providers.length === 0 ? 'Providers: none registered' : `Providers: ${String(providers.length)}`)
  lines.push(...providers)
  lines.push(`Tools: ${String(visibleTools(ctx).length)} callable`)
  lines.push(`Filesystem provider: ${ctx.get('fs') === undefined ? 'absent' : 'mounted'}`)
  lines.push(`Storage domain: ${ctx.get('storageDomain') === undefined ? 'absent' : 'mounted'}`)
  const hooks = ctx.get('loader') === undefined ? undefined : await mountedHooks(ctx)
  lines.push(hooks === undefined ? 'Hook bridges: unknown (no Loader)' : `Hook bridges: ${describeHooks(hooks)}`)
  return { kind: 'success', text: `Doctor report:\n${lines.join('\n')}` }
}

/** MCP tools grouped by the server segment of their bridged tool name. */
function executeMcp(ctx: Context, invocation: CommandInvocation): CommandResult {
  const usage = rejectsArguments(invocation, MCP_USAGE)
  if (usage !== undefined) return usage
  const servers = groupMcpServers(visibleTools(ctx))
  if (servers.size === 0) return { kind: 'success', text: 'No MCP tools are registered.' }
  const lines = [...servers].map(([server, tools]) => `- ${server}: ${tools.join(', ')}`)
  return { kind: 'success', text: `${String(servers.size)} MCP server(s):\n${lines.join('\n')}` }
}

/** Registered agent compositions, subagent providers, and this session's children. */
async function executeAgents(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const usage = rejectsArguments(invocation, AGENTS_USAGE)
  if (usage !== undefined) return usage
  const lines: string[] = []
  const presets = ctx.get('agentPresets')
  if (presets === undefined) lines.push('Agent compositions: no preset roster mounted')
  else {
    const compositions = await presets.compositionInventory()
    invocation.signal.throwIfAborted()
    lines.push(compositions.length === 0
      ? 'Agent compositions: none'
      : `Agent compositions: ${String(compositions.length)}`)
    for (const composition of compositions) {
      lines.push(`- ${composition.id}: ${String(composition.rows.length)} plugin row(s)`)
    }
  }
  const subagents = ctx.get('subagents')
  if (subagents === undefined) lines.push('Subagent providers: none mounted')
  else {
    const providers = subagents.list()
    lines.push(providers.length === 0 ? 'Subagent providers: none' : `Subagent providers: ${providers.join(', ')}`)
    const children = await subagents.listChildren(invocation.agent.session.id, invocation.signal)
    invocation.signal.throwIfAborted()
    lines.push(children.length === 0 ? 'Children of this session: none' : 'Children of this session:')
    for (const child of children) {
      lines.push(`- ${child.label ?? String(child.id)} (${child.mode})`)
    }
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** Loader rows whose module name belongs to a hook bridge. */
async function mountedHooks(ctx: Context): Promise<{ moduleName: string; enabled: boolean }[]> {
  const inventory = await readPluginInventory(ctx)
  return inventory.entries
    .filter(entry => HOOK_BRIDGE_PREFIXES.some(prefix => entry.moduleName.startsWith(prefix)))
    .map(entry => ({ moduleName: entry.moduleName, enabled: entry.enabled }))
}

/** Render mounted hook bridges, or the explicit none. */
function describeHooks(hooks: readonly { moduleName: string; enabled: boolean }[]): string {
  if (hooks.length === 0) return 'none mounted'
  return hooks.map(hook => `${hook.moduleName} (${hook.enabled ? 'enabled' : 'disabled'})`).join(', ')
}

/** Report the mounted hook bridges; hook rules themselves live in each bridge's config. */
async function executeHooks(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const usage = rejectsArguments(invocation, HOOKS_USAGE)
  if (usage !== undefined) return usage
  if (ctx.get('loader') === undefined) {
    return { kind: 'error', text: 'This deployment has no Loader, so mounted hook bridges cannot be listed.' }
  }
  const hooks = await mountedHooks(ctx)
  invocation.signal.throwIfAborted()
  return {
    kind: 'success',
    text: hooks.length === 0
      ? 'No hook bridges are mounted. Hook rules live in each bridge\'s hooks.json configuration.'
      : `${String(hooks.length)} hook bridge(s) mounted:\n${hooks.map(hook => `- ${hook.moduleName} (${hook.enabled ? 'enabled' : 'disabled'})`).join('\n')}`,
  }
}

/** Tool schemas are read through the registry face so the count matches what the model sees. */
function visibleTools(ctx: Context): ToolSchema[] {
  return ctx.tools.schemas()
}

/**
 * Register the inspection commands for interactive command adapters.
 * @param ctx - plugin context; registrations dispose with it.
 * @returns nothing; the Cordis fiber owns the registrations.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-inspect/help'),
    name: 'help',
    description: 'List the commands this session can run',
    handler: (invocation: CommandInvocation) => executeHelp(ctx, invocation),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-inspect/doctor'),
    name: 'doctor',
    description: 'Check sandbox, provider keys, MCP, LSP, and disk, then report the mounted environment',
    handler: (invocation: CommandInvocation) => executeDoctor(ctx, invocation),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-inspect/mcp'),
    name: 'mcp',
    description: 'List the MCP tools grouped by their server',
    handler: (invocation: CommandInvocation) => executeMcp(ctx, invocation),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-inspect/agents'),
    name: 'agents',
    description: 'List agent compositions, subagent providers, and this session\'s children',
    handler: (invocation: CommandInvocation) => executeAgents(ctx, invocation),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-inspect/hooks'),
    name: 'hooks',
    description: 'List the mounted hook bridges',
    handler: (invocation: CommandInvocation) => executeHooks(ctx, invocation),
  })
}
