/**
 * File-defined slash commands: Markdown files with YAML frontmatter discovered
 * from project and user command roots and registered on the shared
 * `ctx.commands` registry.
 *
 * Roots are layered: the project `.dsh/commands` and `.claude/commands`
 * directories (resolved against the process launch cwd) outrank the user's
 * `<dshHome>/commands` and `<claudeHome>/commands`, and the first root that
 * provides a name owns it. A missing directory contributes nothing; a file that
 * cannot be read, parsed, or validated is skipped with one warning naming the
 * file and the reason, so a broken file never fails the load.
 *
 * A loaded command submits its body as one ordinary user message when
 * dispatched: `$ARGUMENTS` is replaced by the invocation's trimmed input, or the
 * input is appended as its own paragraph when the body has no placeholder.
 * `allowed-tools` masks the receiving agent's tools through
 * `ctx.tools.restrict()` for the run the submission starts, and `model` replaces
 * the model half of the receiving agent's route for that same run. Both
 * overrides are lifted when the agent parks.
 *
 * @module @deepseek-ai/dsh-commands/file-commands
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Side-effect type import: declaration-merges `ctx.tools`, reached through the
// receiving agent's scoped context for the `allowed-tools` restriction.
import type {} from '@deepseek-ai/dsh-tools'
// Side-effect type import: declaration-merges the `system-prompt/assemble`
// waterfall the `model` override joins.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { CommandDefinition, CommandInvocation } from './index.ts'
import type { CommandResult } from './types.ts'

export const name = 'file-commands'
export const inject = ['commands']

const DEFAULT_PROJECT_DSH_COMMANDS = './.dsh/commands'
const DEFAULT_PROJECT_CLAUDE_COMMANDS = './.claude/commands'
const DEFAULT_MAX_COMMAND_BYTES = 65_536
const COMMAND_FILE_SUFFIX = '.md'
const FRONTMATTER_DELIMITER = '---'
/** Placeholder a command body replaces with the invocation's exact input. */
const ARGUMENTS_PLACEHOLDER = '$ARGUMENTS'

/** Frontmatter keys this loader consumes; every other key is reported once per file. */
const FRONTMATTER_KEYS: Readonly<Record<string, true>> = {
  description: true,
  'argument-hint': true,
  'allowed-tools': true,
  model: true,
}

/** File-defined command discovery. */
export interface Config {
  /**
   * Project `.dsh` command directory, resolved against the process launch cwd;
   * an empty string disables this root. Defaults to `./.dsh/commands`.
   */
  projectDshCommands?: string
  /**
   * Project `.claude` command directory, resolved against the process launch
   * cwd; an empty string disables this root. Defaults to `./.claude/commands`.
   */
  projectClaudeCommands?: string
  /** Harness home whose `commands` directory holds user commands. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Claude Code home whose `commands` directory holds user commands; an empty string disables this root. Defaults to `~/.claude`. */
  claudeHome?: string
  /** Maximum bytes accepted for one command file; a larger file is skipped with a diagnostic. Defaults to 65536. */
  maxCommandBytes?: number
}

export const Config: Schema<Config> = z.object({
  projectDshCommands: z.string().default(DEFAULT_PROJECT_DSH_COMMANDS),
  projectClaudeCommands: z.string().default(DEFAULT_PROJECT_CLAUDE_COMMANDS),
  dshHome: z.string(),
  claudeHome: z.string(),
  maxCommandBytes: z.number().step(1).min(1).default(DEFAULT_MAX_COMMAND_BYTES),
})

/** One command file's consumed frontmatter plus its body. */
interface CommandFrontmatter {
  readonly data: Record<string, unknown>
  readonly body: string
}

/** One accepted command file, before registry normalization. */
interface LoadedCommand {
  /** Command name derived from the file name without its `.md` suffix. */
  readonly name: string
  readonly description: string
  /** Frontmatter `argument-hint`, advertised as the command's input hint. */
  readonly hint?: string
  /** Frontmatter `allowed-tools`: the tool names the command's run may use. */
  readonly allowedTools?: readonly string[]
  /** Frontmatter `model`: the model half of the route the command's run uses. */
  readonly model?: string
  readonly body: string
  readonly path: string
}

/**
 * Discover and register file-defined commands.
 * @param ctx - plugin context; every registration disposes with its fiber.
 * @param config - root locations and the per-file byte cap.
 * @returns after every readable command file has been offered to the registry.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const maxBytes = config.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError(`file-commands: maxCommandBytes must be a positive integer, got ${String(maxBytes)}`)
  }
  const claimed = new Map<string, string>()
  for (const root of commandRoots(config)) {
    for (const fileName of await commandFileNames(ctx, root)) {
      if (!fileName.toLowerCase().endsWith(COMMAND_FILE_SUFFIX)) continue
      const name = fileName.slice(0, -COMMAND_FILE_SUFFIX.length)
      const path = join(root, fileName)
      const loaded = await loadCommandFile(ctx, name, path, maxBytes)
      if (loaded === undefined) continue
      const owner = claimed.get(loaded.name)
      if (owner !== undefined) {
        ctx.logger.warn(`command file ${path} ignored: "${loaded.name}" is already provided by ${owner}`)
        continue
      }
      if (registerCommand(ctx, loaded)) claimed.set(loaded.name, path)
    }
  }
}

/**
 * Resolve the configured command roots in precedence order: project `.dsh`,
 * project `.claude`, user `<dshHome>`, then user `<claudeHome>`.
 * @param config - user-facing plugin configuration.
 * @returns absolute directories, highest precedence first.
 */
function commandRoots(config: Config): string[] {
  const roots: string[] = []
  const projectDsh = config.projectDshCommands ?? DEFAULT_PROJECT_DSH_COMMANDS
  if (projectDsh.length > 0) roots.push(resolve(projectDsh))
  const projectClaude = config.projectClaudeCommands ?? DEFAULT_PROJECT_CLAUDE_COMMANDS
  if (projectClaude.length > 0) roots.push(resolve(projectClaude))
  roots.push(join(resolveDshHome(config.dshHome), 'commands'))
  const claudeHome = config.claudeHome ?? join(homedir(), '.claude')
  if (claudeHome.length > 0) roots.push(join(resolve(claudeHome), 'commands'))
  return roots
}

/**
 * List one root's candidate file names in a stable order.
 * @param ctx - plugin context used only for its logger.
 * @param root - absolute command directory.
 * @returns sorted non-directory entry names; empty when the directory is absent
 *   and empty after one diagnostic for any other read failure.
 */
async function commandFileNames(ctx: Context, root: string): Promise<string[]> {
  try {
    if (!(await stat(root)).isDirectory()) return []
  } catch {
    // An absent root is the ordinary "nothing configured here" case.
    return []
  }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error: unknown) {
    /* v8 ignore start -- Reaching this needs the directory to become unreadable after the stat above. */
    ctx.logger.warn(`command directory ${root} ignored: ${String(error)}`)
    return []
    /* v8 ignore stop */
  }
  return entries.filter(entry => !entry.isDirectory()).map(entry => entry.name).sort()
}

/**
 * Read and validate one candidate command file.
 * @param ctx - plugin context used only for its logger.
 * @param name - command name derived from the file name.
 * @param path - absolute command file path.
 * @param maxBytes - maximum bytes accepted for the whole file.
 * @returns the loaded command, or `undefined` after one diagnostic when the
 *   file is not a loadable command file.
 */
async function loadCommandFile(
  ctx: Context,
  name: string,
  path: string,
  maxBytes: number,
): Promise<LoadedCommand | undefined> {
  let info
  try {
    info = await stat(path)
  } catch (error: unknown) {
    /* v8 ignore start -- Reaching this needs a stat fault on a path the scan just listed: a removal race or a permission fault. */
    ctx.logger.warn(`command file ${path} ignored: ${String(error)}`)
    return undefined
    /* v8 ignore stop */
  }
  if (!info.isFile()) {
    ctx.logger.warn(`command file ${path} ignored: not a regular file`)
    return undefined
  }
  if (info.size > maxBytes) {
    ctx.logger.warn(`command file ${path} ignored: ${String(info.size)} bytes exceeds maxCommandBytes (${String(maxBytes)})`)
    return undefined
  }
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error: unknown) {
    /* v8 ignore start -- A read failure needs a platform permission or I/O fault; the size cap and the regular-file check already ran. */
    ctx.logger.warn(`command file ${path} ignored: ${String(error)}`)
    return undefined
    /* v8 ignore stop */
  }
  const parsed = parseCommandFile(ctx, path, content)
  if (parsed === undefined) return undefined
  return { name, path, ...parsed }
}

/**
 * Parse one file's frontmatter and validate the fields this loader consumes.
 * @param ctx - plugin context used only for its logger.
 * @param path - absolute command file path, used in diagnostics.
 * @param content - the whole file text.
 * @returns the consumed fields and body, or `undefined` after one diagnostic.
 */
function parseCommandFile(
  ctx: Context,
  path: string,
  content: string,
): Omit<LoadedCommand, 'name' | 'path'> | undefined {
  let parsed: CommandFrontmatter | undefined
  try {
    parsed = splitFrontmatter(content)
  } catch (error: unknown) {
    ctx.logger.warn(`command file ${path} ignored: invalid YAML frontmatter: ${String(error)}`)
    return undefined
  }
  if (parsed === undefined) {
    ctx.logger.warn(`command file ${path} ignored: missing YAML frontmatter`)
    return undefined
  }
  const body = parsed.body.trim()
  if (body.length === 0) {
    ctx.logger.warn(`command file ${path} ignored: the command body is empty`)
    return undefined
  }
  const description = optionalText(parsed.data, 'description')
  if (description === undefined || description === null) {
    ctx.logger.warn(`command file ${path} ignored: frontmatter requires a non-empty description`)
    return undefined
  }
  const hint = optionalText(parsed.data, 'argument-hint')
  if (hint === null) {
    ctx.logger.warn(`command file ${path} ignored: argument-hint must be a non-empty string`)
    return undefined
  }
  const allowedTools = optionalToolNames(parsed.data['allowed-tools'])
  if (allowedTools === null) {
    ctx.logger.warn(`command file ${path} ignored: allowed-tools must be a non-empty list of tool names or a comma-separated string`)
    return undefined
  }
  const model = optionalText(parsed.data, 'model')
  if (model === null) {
    ctx.logger.warn(`command file ${path} ignored: model must be a non-empty string`)
    return undefined
  }
  const unknown = Object.keys(parsed.data).filter(key => FRONTMATTER_KEYS[key] !== true)
  if (unknown.length > 0) {
    ctx.logger.warn(`command file ${path}: frontmatter key${unknown.length > 1 ? 's' : ''} ${unknown.map(key => JSON.stringify(key)).join(', ')} ignored`)
  }
  return {
    description,
    body,
    ...hint === undefined ? {} : { hint },
    ...allowedTools === undefined ? {} : { allowedTools },
    ...model === undefined ? {} : { model },
  }
}

/**
 * Register one loaded command through the shared registry.
 * @param ctx - plugin context that owns the registration effect.
 * @param loaded - the validated command file.
 * @returns whether the registry accepted the definition; a rejected name or
 *   duplicate is recorded as a diagnostic naming the file.
 */
function registerCommand(ctx: Context, loaded: LoadedCommand): boolean {
  const definition: CommandDefinition = {
    name: loaded.name,
    description: loaded.description,
    ...loaded.hint === undefined ? {} : { input: { hint: loaded.hint } },
    ...loaded.model === undefined ? {} : { model: loaded.model },
    handler: invocation => executeFileCommand(loaded, invocation),
  }
  try {
    ctx.effect(() => ctx.commands.register(definition), `file-commands: ${loaded.path}`)
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`command file ${loaded.path} ignored: ${String(error)}`)
    return false
  }
}

/**
 * Submit one file command's prompt to the receiving agent, masking the agent's
 * tools with the file's `allowed-tools` allowlist and routing its requests to
 * the file's `model` for the run it starts.
 * @param loaded - the command file that was dispatched.
 * @param invocation - the human invocation owning the target agent.
 * @returns the command result shown to the requester.
 */
function executeFileCommand(loaded: LoadedCommand, invocation: CommandInvocation): CommandResult {
  const lifts: Array<() => void> = []
  if (loaded.allowedTools !== undefined) {
    try {
      lifts.push(invocation.agent.ctx.tools.restrict({ allow: [...loaded.allowedTools] }))
    } catch (error: unknown) {
      // An unknown or unmounted tool name, or a deployment without the tools
      // service, fails the invocation instead of running it unmasked.
      return { kind: 'error', text: `/${loaded.name}: ${String(error)}` }
    }
  }
  const route = routeCommandRun(loaded.model, invocation.agent)
  if (route !== undefined) lifts.push(route)
  try {
    invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text: renderBody(loaded.body, invocation.rawInput) }],
      source: { kind: 'user' },
    }))
  } finally {
    // The overrides cover every turn until the agent parks, including a
    // submission that never reached the inbox.
    if (lifts.length > 0) {
      const lift = (): void => {
        for (const release of lifts) release()
      }
      void invocation.agent.whenIdle().then(lift, lift)
    }
  }
  return { kind: 'success', text: `Submitted /${loaded.name} from ${loaded.path}` }
}

/**
 * Route the run one file command starts to its declared model.
 *
 * The declared value replaces the model half of whatever route the receiving
 * agent resolves for the run; the provider half, and with it the credentials and
 * catalog the run is validated against, stays the agent's own. Prompt assembly
 * and request routing are overridden together — as `installModelSelection` does
 * for an entry point's selection — so the assembled prompt never names a model
 * the request did not use. `prepend` places this override outside the agent's
 * own selection listener, which would otherwise restore that selection.
 *
 * @param model - frontmatter `model`, or `undefined` for a command that declares none.
 * @param agent - receiving agent whose scope owns the run.
 * @returns the exact disposer that restores the agent's own route, or `undefined`.
 */
function routeCommandRun(model: string | undefined, agent: Agent): (() => void) | undefined {
  if (model === undefined) return undefined
  const disposeAssembly = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return { ...assembled, variables: { ...assembled.variables, model } }
  }, { prepend: true })
  const disposeRequest = agent.ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    // An effort the previous model owned is not a choice for the declared one.
    const { reasoningEffort: _selectedEffort, ...route } = resolved
    return { ...route, model }
  }, { prepend: true })
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}

/**
 * Render one command body for one invocation.
 * @param body - the trimmed command body.
 * @param rawInput - the exact text following the command name.
 * @returns the body with `$ARGUMENTS` replaced by the trimmed input, or with
 *   the trimmed input appended as its own paragraph when no placeholder exists.
 */
function renderBody(body: string, rawInput: string): string {
  const input = rawInput.trim()
  if (body.includes(ARGUMENTS_PLACEHOLDER)) return body.replaceAll(ARGUMENTS_PLACEHOLDER, input)
  return input.length === 0 ? body : `${body}\n\n${input}`
}

/**
 * Split one Markdown command file into its YAML frontmatter mapping and body.
 * @param raw - the whole file text.
 * @returns the mapping and the text after the closing delimiter, or `undefined`
 *   when the file carries no frontmatter mapping; throws on invalid YAML.
 */
function splitFrontmatter(raw: string): CommandFrontmatter | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== FRONTMATTER_DELIMITER) return undefined
  const start = firstLineEnd + 1
  const closing = findClosingDelimiter(raw, start)
  if (closing === undefined) return undefined
  const parsed: unknown = parseYaml(raw.slice(start, closing.start))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

/**
 * Find the closing `---` delimiter line at or after `start`.
 * @param raw - the whole file text.
 * @param start - offset of the first frontmatter line.
 * @returns the delimiter's line start and the body offset, or `undefined` when
 *   the block is never closed.
 */
function findClosingDelimiter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === FRONTMATTER_DELIMITER) {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/**
 * Read one optional string frontmatter field.
 * @param data - the parsed frontmatter mapping.
 * @param key - the canonical field name.
 * @returns the trimmed value, `undefined` when the key is absent, or `null`
 *   when the key is present but is not a non-empty string.
 */
function optionalText(data: Record<string, unknown>, key: string): string | undefined | null {
  const value = data[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length === 0 ? null : text
}

/**
 * Read the `allowed-tools` field, accepting a comma- or whitespace-separated
 * string and a YAML sequence.
 * @param value - the raw frontmatter value.
 * @returns the distinct tool names in declaration order, `undefined` when the
 *   key is absent, or `null` when the value carries no valid name.
 */
function optionalToolNames(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined
  const raw = typeof value === 'string'
    ? value.split(/[\s,]+/u)
    : Array.isArray(value) ? value : undefined
  if (raw === undefined) return null
  const names = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') return null
    const trimmed = entry.trim()
    if (trimmed.length > 0) names.add(trimmed)
  }
  return names.size === 0 ? null : [...names]
}
