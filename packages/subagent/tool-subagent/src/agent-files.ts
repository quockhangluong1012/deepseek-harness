/**
 * File-defined agent roles: discovery of `*.md` definitions under project and
 * user agent directories and their compilation into one delegation request's
 * child tool restriction and LLM options.
 *
 * Project roots win over user roots, and inside one layer the earlier root
 * wins. A file without a frontmatter block still defines an agent, named after
 * the file. A definition the loader cannot use is skipped with a diagnostic, so
 * one malformed file never fails another agent's delegation.
 *
 * Accepted frontmatter, all fields optional:
 *
 * ```
 * name: code-reviewer            identity; defaults to the file name
 * role: reviewer                 policy role for `allowedRoles`; defaults to `name`
 * description: Reviews a diff    one plain value
 * model: provider/model-id       or a bare model id, or `inherit`
 * tools: read, grep, bash        or [read, grep], or an indented tool: true|false map
 * permission:                    indented tool: allow|ask|deny map
 *   edit: deny
 * budget:                        indented map of this role's child ceilings
 *   maxTokens: 50000
 *   maxCostUsd: 1.5
 * maxTurns: 8                    turns the child may open
 * outputSchema: reviewer.json    path, relative to this file, of the object-rooted
 *                                JSON Schema the child must satisfy
 * ```
 *
 * A `tools` or `permission` tool name is a harness global tool name; Claude
 * Code's capitalized spellings map mechanically (`WebFetch` → `web_fetch`).
 *
 * A role's memory scope is deliberately not declarable: the harness exposes no
 * per-child memory-scope control, and a declared-but-ignored field would read
 * as a control the deployment does not have.
 *
 * @module @deepseek-ai/dsh-tool-subagent/agent-files
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'

/** Definition file extension this loader reads. */
const DEFINITION_EXTENSION = '.md'

/** Frontmatter fields this loader consumes; every other field is reported and ignored. */
const CONSUMED_FIELDS: Readonly<Record<string, true>> = {
  name: true,
  role: true,
  description: true,
  model: true,
  tools: true,
  permission: true,
  budget: true,
  maxTurns: true,
  outputSchema: true,
}

/** Frontmatter `model` value that keeps the deployment's route for the child. */
const INHERIT_MODEL = 'inherit'

/** Frontmatter field name. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

/** One frontmatter field value: a scalar, an inline scalar list, or a one-level scalar mapping. */
type FieldValue = string | string[] | Record<string, string>

/** Roots searched for agent definition files, in precedence order. */
export interface AgentRoots {
  /**
   * Project-layer roots. A relative root resolves against the nearest ancestor
   * of the calling Session's working directory that holds a `.git` entry.
   */
  readonly project: readonly string[]
  /**
   * User-layer roots. A leading `~` or `~/` expands to the home directory, and
   * any other relative root resolves against it.
   */
  readonly user: readonly string[]
}

/** Decision one `permission` entry declares for its tool. */
export type AgentPermission = 'allow' | 'ask' | 'deny'

/** Ceilings one file-defined role declares for its child, as that child's own worker limits. */
export interface RoleWorkerLimits {
  /** Turns the child may open; a step of a later turn is refused. */
  readonly maxTurns?: number
  /** Billed tokens the child may spend. */
  readonly maxTokens?: number
  /**
   * Priced USD the child may spend. The child compares it against the token
   * price the delegation deployment declares, which the child's worker limits
   * carry beside this ceiling.
   */
  readonly maxCostUsd?: number
}

/** One file-defined agent compiled into delegation request fields. */
export interface FileAgent {
  /** Identity the tool's `agent` parameter selects. */
  readonly name: string
  /**
   * Policy role this definition declares. A spawn is admitted against
   * `DelegationPolicy.allowedRoles` by this role, so one role name admits every
   * definition that declares it; a definition that declares none is admitted
   * by its {@link name}.
   */
  readonly role?: string
  /** `description` frontmatter, absent when the file declares none. */
  readonly description?: string
  /** Absolute path of the definition file. */
  readonly path: string
  /**
   * Child tool restriction compiled from `tools` and the `deny` entries of
   * `permission`; absent when the file restricts nothing.
   */
  readonly toolFilter?: ToolRestriction
  /** Child LLM options compiled from `model`; absent when the file inherits the child route. */
  readonly agentOptions?: AgentOptions
  /**
   * Every `permission` declaration, retained for the delegation policy that
   * enforces decisions beyond tool access.
   */
  readonly permission?: Readonly<Record<string, AgentPermission>>
  /** Ceilings compiled from `budget` and `maxTurns`; absent when the file declares none. */
  readonly workerLimits?: RoleWorkerLimits
  /**
   * Path this definition names for its child's output schema, relative to the
   * definition file. {@link discoverFileAgents} resolves and validates it into
   * {@link outputSchema}.
   */
  readonly outputSchemaPath?: string
  /**
   * Object-rooted JSON Schema the child must satisfy, read from
   * {@link outputSchemaPath}. Absent on the parse result and on a definition
   * that names no schema; discovery fills it, so a caller reading a definition
   * directly resolves the path itself.
   */
  readonly outputSchema?: ObjectJsonSchema
}

/** One definition file compiled into an agent, or the reason it is unusable. */
export type AgentFileParse =
  | {
    readonly ok: true
    /** The compiled agent. */
    readonly agent: FileAgent
    /** Conditions the file declares that this loader records or ignores. */
    readonly notices: readonly string[]
  }
  | {
    readonly ok: false
    /** Why the file cannot define an agent. */
    readonly problem: string
  }

/** Declared agents and the directories searched for them. */
export interface FileAgentCatalog {
  /** Declared agents by name; the first declaration of a name wins. */
  readonly agents: ReadonlyMap<string, FileAgent>
  /** Absolute searched directories, in precedence order and without duplicates. */
  readonly roots: readonly string[]
}

/**
 * Search every configured root for agent definitions.
 * @param roots - project and user root layers, in precedence order.
 * @param options - calling Session working directory, home directory, and diagnostic sink.
 * @returns declared agents by name plus the directories the search covered.
 */
export async function discoverFileAgents(
  roots: AgentRoots,
  options: { readonly cwd: string; readonly home: string; readonly warn: (message: string) => void },
): Promise<FileAgentCatalog> {
  const projectRoot = await projectRootOf(options.cwd)
  const searched = new Set<string>()
  const agents = new Map<string, FileAgent>()
  for (const directory of [
    ...roots.project.map(root => isAbsolute(root) ? root : resolve(projectRoot, root)),
    ...roots.user.map(root => resolveUserRoot(root, options.home)),
  ]) {
    if (searched.has(directory)) continue
    searched.add(directory)
    for (const name of await definitionNames(directory)) {
      const path = join(directory, name)
      const source = await readDefinition(path, options.warn)
      if (source === undefined) continue
      const parsed = parseAgentFile(source, path)
      if (!parsed.ok) {
        options.warn(`agent definition ${path} skipped: ${parsed.problem}`)
        continue
      }
      for (const notice of parsed.notices) options.warn(`agent definition ${path}: ${notice}`)
      if (agents.has(parsed.agent.name)) continue
      const declaredSchema = parsed.agent.outputSchemaPath
      if (declaredSchema === undefined) {
        agents.set(parsed.agent.name, parsed.agent)
        continue
      }
      const schemaPath = isAbsolute(declaredSchema) ? declaredSchema : resolve(dirname(path), declaredSchema)
      try {
        agents.set(parsed.agent.name, { ...parsed.agent, outputSchema: await readOutputSchema(schemaPath) })
      } catch (error: unknown) {
        options.warn(`agent definition ${path} skipped: ${String(error)}`)
      }
    }
  }
  return { agents, roots: [...searched] }
}

/**
 * Read one definition's declared output schema.
 * @param path - absolute path of the schema file.
 * @returns the validated object-rooted JSON Schema.
 * @throws when the file cannot be read, is not JSON, or is outside the enforced schema subset.
 */
async function readOutputSchema(path: string): Promise<ObjectJsonSchema> {
  const source = await readFile(path, 'utf8')
  const parsed: unknown = JSON.parse(source)
  assertObjectJsonSchema(parsed)
  return parsed
}

/**
 * Compile one definition file into a file-defined agent.
 * @param source - the whole file text.
 * @param path - absolute path the text was read from; its basename names an agent that declares no `name`.
 * @returns the compiled agent with its notices, or the reason the file is unusable.
 */
export function parseAgentFile(source: string, path: string): AgentFileParse {
  const fields = parseFrontmatter(source)
  if (typeof fields === 'string') return { ok: false, problem: fields }
  const notices = Object.keys(fields)
    .filter(field => CONSUMED_FIELDS[field] !== true)
    .map(field => `ignored unknown field "${field}"`)
  const declaredName = fields.name
  if (declaredName !== undefined && typeof declaredName !== 'string') {
    return { ok: false, problem: '`name` must be one plain value' }
  }
  const name = (declaredName ?? basename(path, DEFINITION_EXTENSION)).trim()
  if (name === '') return { ok: false, problem: 'the agent name is empty' }
  const description = fields.description
  if (description !== undefined && typeof description !== 'string') {
    return { ok: false, problem: '`description` must be one plain value' }
  }
  const model = fields.model
  if (model !== undefined && typeof model !== 'string') {
    return { ok: false, problem: '`model` must be one plain value' }
  }
  const role = fields.role
  if (role !== undefined && typeof role !== 'string') {
    return { ok: false, problem: '`role` must be one plain value' }
  }
  const declaredRole = role?.trim()
  if (role !== undefined && declaredRole === '') return { ok: false, problem: '`role` must name a role' }
  const outputSchema = fields.outputSchema
  if (outputSchema !== undefined && typeof outputSchema !== 'string') {
    return { ok: false, problem: '`outputSchema` must be one path' }
  }
  const declaredSchema = outputSchema?.trim()
  if (outputSchema !== undefined && declaredSchema === '') {
    return { ok: false, problem: '`outputSchema` must name a schema file' }
  }
  const budget = compileBudget(fields.budget)
  if (typeof budget === 'string') return { ok: false, problem: budget }
  const maxTurns = parseCount('maxTurns', fields.maxTurns)
  if (typeof maxTurns === 'string') return { ok: false, problem: maxTurns }
  const permission = compilePermission(fields.permission, notices)
  if (typeof permission === 'string') return { ok: false, problem: permission }
  const declaredTools = compileTools(fields.tools)
  if (typeof declaredTools === 'string') return { ok: false, problem: declaredTools }
  const denials = Object.entries(permission)
    .filter(([, decision]) => decision === 'deny')
    .map(([tool]) => tool)
  const toolFilter = mergeToolFilters(declaredTools, denials.length === 0 ? undefined : { deny: denials })
  const agentOptions = compileModel(model)
  if (typeof agentOptions === 'string') return { ok: false, problem: agentOptions }
  const workerLimits = budget === undefined && maxTurns === undefined
    ? undefined
    : { ...budget, ...maxTurns === undefined ? {} : { maxTurns } }
  return {
    ok: true,
    notices,
    agent: {
      name,
      path,
      ...description === undefined ? {} : { description },
      ...declaredRole === undefined ? {} : { role: declaredRole },
      ...toolFilter === undefined ? {} : { toolFilter },
      ...agentOptions === undefined ? {} : { agentOptions },
      ...Object.keys(permission).length === 0 ? {} : { permission },
      ...workerLimits === undefined ? {} : { workerLimits },
      ...declaredSchema === undefined ? {} : { outputSchemaPath: declaredSchema },
    },
  }
}

/**
 * Harness global tool name for one declared tool name. Claude Code's capitalized
 * spellings map mechanically (`WebFetch` → `web_fetch`); every other spelling is
 * used as declared.
 * @param name - tool name as a definition file spells it.
 * @returns the harness global tool name.
 */
export function normalizeToolName(name: string): string {
  return name.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/**
 * Combine two child tool restrictions. Both apply to the same child, so an
 * `allow` list becomes their intersection and a `deny` list their union,
 * matching how the tools registry combines restrictions.
 * @param base - restriction from the tool instance, or undefined.
 * @param extra - restriction a file-defined agent adds, or undefined.
 * @returns one restriction carrying both, or undefined when neither restricts.
 */
export function mergeToolFilters(
  base: ToolRestriction | undefined,
  extra: ToolRestriction | undefined,
): ToolRestriction | undefined {
  const baseAllow = base?.allow
  const extraAllow = extra?.allow
  const allow = baseAllow === undefined || extraAllow === undefined
    ? baseAllow ?? extraAllow
    : baseAllow.filter(name => extraAllow.includes(name))
  const baseDeny = base?.deny
  const extraDeny = extra?.deny
  const deny = baseDeny === undefined || extraDeny === undefined
    ? baseDeny ?? extraDeny
    : [...new Set([...baseDeny, ...extraDeny])]
  if (allow === undefined && deny === undefined) return undefined
  return { ...allow === undefined ? {} : { allow }, ...deny === undefined ? {} : { deny } }
}

/** Nearest ancestor of one working directory that holds a `.git` entry, or that directory itself. */
async function projectRootOf(cwd: string): Promise<string> {
  const start = resolve(cwd)
  let current = start
  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/** Whether one path exists, following the host filesystem's link semantics. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    // A missing path and an unreadable ancestor both mean "no project marker here".
    return false
  }
}

/** Definition file names in one root, in directory order. */
async function definitionNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.name.endsWith(DEFINITION_EXTENSION))
      .map(entry => entry.name)
  } catch {
    // A root that is absent or unreadable declares no agents.
    return []
  }
}

/** Read one definition file, reporting a failure the rest of the delegation survives. */
async function readDefinition(path: string, warn: (message: string) => void): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    warn(`agent definition ${path} could not be read: ${String(error)}`)
    return undefined
  }
}

/** Resolve one user-layer root against the home directory. */
function resolveUserRoot(configured: string, home: string): string {
  const separator = configured.charAt(1)
  const expanded = configured.charAt(0) === '~' && (configured.length === 1 || separator === '/' || separator === '\\')
    ? join(home, configured.slice(2))
    : configured
  return isAbsolute(expanded) ? expanded : resolve(home, expanded)
}

/** Parse one file's frontmatter block into its fields. */
function parseFrontmatter(source: string): Record<string, FieldValue> | string {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== '---') return {}
  const closing = lines.indexOf('---', 1)
  if (closing < 0) return 'the frontmatter block has no closing "---"'
  return parseFields(lines.slice(1, closing), 2)
}

/**
 * Parse one frontmatter block's lines into scalar fields, lists, and one-level mappings.
 * @param lines - the block's lines, in file order.
 * @param startLine - one-based file line of the first block line, for diagnostics.
 * @returns the parsed fields, or the first entry that is not part of the accepted subset.
 */
function parseFields(lines: readonly string[], startLine: number): Record<string, FieldValue> | string {
  const fields: Record<string, FieldValue> = {}
  let openMapping: Record<string, string> | undefined
  for (const [index, line] of lines.entries()) {
    const content = line.trim()
    if (content === '' || content.startsWith('#')) continue
    const at = `frontmatter line ${String(index + startLine)}`
    const colon = content.indexOf(':')
    if (colon < 1) return `${at} is not a "field: value" entry`
    const field = content.slice(0, colon).trim()
    if (!FIELD_NAME.test(field)) return `${at} has an invalid field name "${field}"`
    const value = content.slice(colon + 1).trim()
    if (/^[ \t]/.test(line)) {
      if (openMapping === undefined) return `${at} is indented but no mapping is open`
      const entry = parseScalar(value)
      if (entry === undefined) return `${at} declares no mapping value`
      openMapping[field] = entry
      continue
    }
    openMapping = undefined
    if (value === '') {
      const mapping: Record<string, string> = {}
      fields[field] = mapping
      openMapping = mapping
      continue
    }
    if (value.startsWith('[')) {
      const list = parseInlineList(value)
      if (list === undefined) return `${at} has an unterminated inline list`
      fields[field] = list
      continue
    }
    const scalar = parseScalar(value)
    if (scalar === undefined) return `${at} declares no value`
    fields[field] = scalar
  }
  return fields
}

/** One field value without a trailing ` # comment`. */
function withoutComment(value: string): string {
  const comment = value.indexOf(' #')
  return (comment < 0 ? value : value.slice(0, comment)).trim()
}

/** One scalar field value, with matching quotes stripped. */
function parseScalar(value: string): string | undefined {
  const text = withoutComment(value)
  // A value that begins with `#` is YAML's own spelling for "no value here".
  if (text === '' || text.startsWith('#')) return undefined
  const quote = text.charAt(0)
  return text.length > 1 && (quote === '"' || quote === "'") && text.endsWith(quote)
    ? text.slice(1, -1)
    : text
}

/** One inline scalar list, or undefined when the brackets do not close. */
function parseInlineList(value: string): string[] | undefined {
  const text = withoutComment(value)
  if (!text.endsWith(']')) return undefined
  return text.slice(1, -1).split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

/**
 * One declared count: a whole, non-negative number written as a scalar.
 * @param field - the frontmatter field name, for the diagnostic.
 * @param value - the parsed field value.
 * @returns the count, undefined when the field is absent, or the reason the declaration is unusable.
 */
function parseCount(field: string, value: FieldValue | undefined): number | string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return `\`${field}\` must be one number`
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) return `\`${field}\` must be a non-negative whole number`
  return count
}

/**
 * One declared amount: a non-negative number written as a scalar.
 * @param field - the frontmatter field name, for the diagnostic.
 * @param value - the parsed field value.
 * @returns the amount, undefined when the field is absent, or the reason the declaration is unusable.
 */
function parseAmount(field: string, value: FieldValue | undefined): number | string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return `\`${field}\` must be one number`
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return `\`${field}\` must be a non-negative number`
  return amount
}

/**
 * Compile one `budget` mapping into the ceilings this role's child enforces on
 * itself. An axis outside the accepted pair fails the definition rather than
 * being ignored, because a ceiling a deployment writes and the harness drops
 * is a bound the deployment believes it declared.
 * @param value - the parsed field value.
 * @returns the declared ceilings, undefined when the file declares none, or the problem with the mapping.
 */
function compileBudget(value: FieldValue | undefined): RoleWorkerLimits | string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' || Array.isArray(value)) {
    return '`budget` must be an indented map of maxTokens and maxCostUsd'
  }
  const budget: { maxTokens?: number; maxCostUsd?: number } = {}
  for (const [axis, declared] of Object.entries(value)) {
    if (axis !== 'maxTokens' && axis !== 'maxCostUsd') {
      return `\`budget.${axis}\` is not a declared ceiling; declare maxTokens or maxCostUsd`
    }
    if (axis === 'maxTokens') {
      const tokens = parseCount(`budget.${axis}`, declared)
      if (typeof tokens === 'string') return tokens
      if (tokens !== undefined) budget.maxTokens = tokens
      continue
    }
    const cost = parseAmount(`budget.${axis}`, declared)
    if (typeof cost === 'string') return cost
    if (cost !== undefined) budget.maxCostUsd = cost
  }
  return Object.keys(budget).length === 0 ? undefined : budget
}

/** Compile one `tools` declaration into a child tool restriction. */
function compileTools(value: FieldValue | undefined): ToolRestriction | string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    // An inline mapping is outside the accepted subset; reading it as one
    // strange tool name would hide the declaration instead of reporting it.
    if (value.startsWith('{')) {
      return '`tools` must be a comma-separated list, an inline list, or an indented map of tool: true|false'
    }
    return allowFilter(value.split(','))
  }
  if (Array.isArray(value)) return allowFilter(value)
  const deny: string[] = []
  for (const [tool, enabled] of Object.entries(value)) {
    if (enabled !== 'true' && enabled !== 'false') return `\`tools.${tool}\` must be true or false`
    if (enabled === 'false') deny.push(normalizeToolName(tool))
  }
  return deny.length === 0 ? undefined : { deny }
}

/** Allow-list restriction from declared tool names, absent when the declaration names none. */
function allowFilter(declared: readonly string[]): ToolRestriction | undefined {
  const allow = declared.map(entry => normalizeToolName(entry)).filter(name => name !== '')
  return allow.length === 0 ? undefined : { allow }
}

/** Compile one `model` declaration into child LLM options. */
function compileModel(value: string | undefined): AgentOptions | string | undefined {
  if (value === undefined || value === INHERIT_MODEL) return undefined
  const slash = value.indexOf('/')
  if (slash < 0) return { model: value }
  const provider = value.slice(0, slash)
  const rest = value.slice(slash + 1)
  if (provider === '' || rest === '') return '`model` must be "provider/model", a bare model id, or `inherit`'
  return { provider, model: rest }
}

/**
 * Compile one `permission` mapping, reporting the decisions a delegation cannot
 * yet enforce.
 */
function compilePermission(
  value: FieldValue | undefined,
  notices: string[],
): Readonly<Record<string, AgentPermission>> | string {
  if (value === undefined) return {}
  if (typeof value === 'string' || Array.isArray(value)) {
    return '`permission` must be an indented map of tool: allow, ask, or deny'
  }
  const permission: Record<string, AgentPermission> = {}
  const deferred: string[] = []
  for (const [tool, decision] of Object.entries(value)) {
    if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') {
      return `\`permission.${tool}\` must be allow, ask, or deny`
    }
    const name = normalizeToolName(tool)
    permission[name] = decision
    if (decision !== 'deny') deferred.push(name)
  }
  if (deferred.length > 0) {
    notices.push(`\`permission\` for ${deferred.join(', ')} is recorded but not enforced; this child keeps those tools`)
  }
  return permission
}
