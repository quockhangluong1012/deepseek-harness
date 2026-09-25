/**
 * Discovers `mcpServers` declarations from a project `.mcp.json` and a user-level config file,
 * and mounts one `dsh-mcp-client` instance per accepted server. A project entry overrides a
 * user entry of the same normalized name. Neither file existing is the common case and mounts
 * nothing; a malformed file or entry is skipped with one warning rather than failing boot.
 *
 * @module @deepseek-ai/dsh-mcp-project-config
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parseMcpProjectConfig, type ParsedMcpConfig, type ParsedServer } from './parse.ts'
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
 * Read and parse one `.mcp.json`-shaped file. A missing file is the ordinary "nothing configured
 * here" case and produces no warning; any other read or parse failure warns and is treated as
 * empty so one broken file cannot block the other configured layer.
 * @param ctx - plugin context used only for its logger.
 * @param path - absolute path to the config file.
 * @returns the parsed servers and skipped entries, empty when the file is absent or broken.
 */
async function readConfigFile(ctx: Context, path: string): Promise<ParsedMcpConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.logger.warn(`mcp-project-config: could not load "${path}": ${String(error)} — no servers from this file`)
    }
    return { servers: new Map(), skipped: [] }
  }
  return parseMcpProjectConfig(raw)
}

/** Build the `dsh-mcp-client` config input for one parsed server. */
function clientConfigFor(server: ParsedServer, failOnStartupError: boolean): McpClient.Config {
  return server.transport === 'stdio'
    ? McpClient.Config({
        transport: 'stdio',
        serverName: server.serverName,
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: process.cwd(),
        failOnStartupError,
      })
    : McpClient.Config({
        transport: 'streamable-http',
        serverName: server.serverName,
        url: server.url,
        headers: server.headers,
        failOnStartupError,
      })
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const projectPath = resolve(config.configPath ?? './.mcp.json')
  const userPath = resolve(config.userConfigPath ?? dshHomePath('mcp.json'))
  const [project, user] = projectPath === userPath
    ? [await readConfigFile(ctx, projectPath), { servers: new Map<string, ParsedServer>(), skipped: [] }]
    : await Promise.all([readConfigFile(ctx, projectPath), readConfigFile(ctx, userPath)])

  for (const skippedEntry of [...user.skipped, ...project.skipped]) {
    ctx.logger.warn(`mcp-project-config: skipping "${skippedEntry.rawName}": ${skippedEntry.reason}`)
  }

  // The project file is more specific to the current work than the user-level
  // file, so its declaration wins a normalized-name collision.
  const merged = new Map(user.servers)
  for (const [serverName, server] of project.servers) merged.set(serverName, server)

  const failOnStartupError = config.failOnStartupError ?? false
  // Sequential, matching the ACP bridge's mountAcpMcpServers: each mcp-client
  // instance blocks its own apply() on the initial connection attempt.
  for (const server of merged.values()) await ctx.plugin(McpClient, clientConfigFor(server, failOnStartupError))
}
