/**
 * Mounts the MCP server management service: it discovers `mcpServers`
 * declarations from a project `.mcp.json` and a user-level config file, runs
 * one `dsh-mcp-client` instance per accepted server, and serves the Desktop
 * management surface (`list`, `upsert`, `remove`) that reads those files, adds
 * or replaces declarations, and deletes them under the approval seam. A
 * project entry overrides a user entry of the same normalized name. Neither
 * file existing is the common case and mounts nothing; a malformed file or
 * entry is skipped with one warning rather than failing boot.
 *
 * @module @deepseek-ai/dsh-mcp-project-config
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { McpServers } from './mcp-servers.ts'
import type { McpApprovalChannel } from './mcp-servers.ts'
// Side-effect type imports: declaration-merge `ctx.approval` (the ask a
// reach-extending write makes) and `ctx.agents` (the live agent it addresses).
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-agent'
// Side-effect type import: declaration-merges `ctx.tools` onto Context, required by McpClient.
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'mcp-project-config'

/** Plugin config: where the project and user `.mcp.json` files live. */
export interface Config {
  /**
   * Project MCP config path, resolved against the process launch cwd (matching the
   * `hooks-claude-code`/`hooks-codex` `configPath` convention). Defaults to `./.mcp.json`.
   */
  configPath?: string
  /** User-level MCP config path. Defaults to `$DSH_HOME/mcp.json`. */
  userConfigPath?: string
  /**
   * Fail this plugin's activation when a configured server's initial connection or tool
   * synchronization fails. Default `false`: an unreachable server is logged and left to its own
   * reconnect policy rather than blocking every other configured server and the profile.
   */
  failOnStartupError?: boolean
}

export const Config: Schema<Config> = z.object({
  configPath: z.string().default('./.mcp.json'),
  userConfigPath: z.string(),
  failOnStartupError: z.boolean().default(false),
})

/**
 * The approval channel a reach-extending write asks through. It resolves the
 * ask's session to the live agent `user-approval` asks on behalf of, and
 * rejects when this composition has no approval seam or no live agent holds
 * that session — the write is then refused rather than applied unreviewed.
 * @param ctx - plugin context carrying the approval and agent services.
 * @returns the channel, or undefined when either service is absent.
 */
function approvalChannel(ctx: Context): McpApprovalChannel | undefined {
  const agents = ctx.get('agents')
  const approval = ctx.get('approval')
  if (agents === undefined || approval === undefined) return undefined
  return {
    request: async (ask) => {
      const agent = agents.get(ask.sessionId)
      if (agent === undefined) throw new Error(`no live agent holds session "${ask.sessionId}"`)
      return await approval.request({
        agent,
        toolName: ask.toolName,
        ...ask.reason === undefined ? {} : { reason: ask.reason },
      })
    },
  }
}

/**
 * Mount the management service for this profile.
 * @param ctx - plugin context whose fiber owns the service and its client instances.
 * @param config - the two config file paths and the startup-failure stance.
 * @returns after every configured server's mount attempt settled.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const servers = new McpServers(ctx, {
    projectPath: resolve(config.configPath ?? './.mcp.json'),
    userPath: resolve(config.userConfigPath ?? dshHomePath('mcp.json')),
    failOnStartupError: config.failOnStartupError ?? false,
    approval: approvalChannel(ctx),
  })
  await servers.start()
}
