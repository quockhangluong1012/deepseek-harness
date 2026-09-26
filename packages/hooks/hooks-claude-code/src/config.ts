/**
 * Parse Claude Code's event-to-matcher-group hook format into shared {@link MatcherGroup}s.
 * Command and HTTP hooks run; other hook types are returned as skipped so the
 * bridge can warn. Plugin-root and project-directory substitutions are applied
 * to commands at parse time.
 * @module @deepseek-ai/dsh-hooks-claude-code/config
 */

import { matcherDiagnostic, type CommandHook, type HttpHook, type MatcherGroup } from '@deepseek-ai/dsh-hook-protocol'

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'PreCompact',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'BeforeModel',
  'BeforeToolSelection',
] as const

/**
 * Events with no matcher subject: a configured `matcher` on these is dropped
 * rather than matched, because there is no string to test it against.
 */
const MATCHERLESS_EVENTS: Record<string, true> = {
  UserPromptSubmit: true,
  Stop: true,
  SessionEnd: true,
  BeforeModel: true,
  BeforeToolSelection: true,
}

/** A parsed CC config: event name → its matcher groups (runnable hooks only). */
export type ClaudeCodeHookConfig = Record<string, MatcherGroup[]>

/** A skipped non-command hook, surfaced so the bridge can warn about it. */
export interface SkippedHook {
  event: string
  type: string
}

/** The outcome of parsing one config file: the runnable groups + what was skipped. */
export interface ParsedClaudeConfig {
  config: ClaudeCodeHookConfig
  skipped: SkippedHook[]
}

/** Substitution variables applied to each `command` string at parse time. */
export interface SubstitutionVars {
  /** Replaces `${CLAUDE_PLUGIN_ROOT}` — the plugin's root dir. */
  pluginRoot?: string
  /** Replaces `${CLAUDE_PROJECT_DIR}` — the project root. */
  projectDir?: string
}

/** A plain (non-null, non-array) object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Validate an HTTP hook endpoint at load. A malformed URL or a non-HTTP
 * protocol is a self-contained misconfiguration, so it rejects the whole
 * config instead of silently registering a hook that can never answer.
 */
function assertHttpUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SyntaxError(`invalid http hook url ${JSON.stringify(url)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SyntaxError(`unsupported http hook url protocol ${JSON.stringify(parsed.protocol)}`)
  }
  return url
}

/** The string-valued entries of a configured `headers` object, or undefined when none survive. */
function headersOf(value: unknown): Record<string, string> | undefined {
  const raw = asObject(value)
  if (raw === undefined) return undefined
  const headers: Record<string, string> = {}
  for (const [name, header] of Object.entries(raw)) {
    if (typeof header === 'string') headers[name] = header
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

/**
 * Apply `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substitution to a command string.
 * @param command - the raw command from config.
 * @param vars - the substitution values; a token whose variable is unset stays verbatim.
 * @returns the command with every occurrence of each set token replaced.
 */
export function substituteCommand(command: string, vars: SubstitutionVars): string {
  let out = command
  if (vars.pluginRoot !== undefined) out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot)
  if (vars.projectDir !== undefined) out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir)
  return out
}

/**
 * Parse either a settings `hooks` value or a bare `hooks.json` event map. Malformed entries are
 * ignored rather than failing boot; unsupported events are ignored before their groups are parsed,
 * non-runnable hook types (`mcp_tool`/`prompt`/`agent`) are returned in `skipped`, and
 * substitutions are applied to every surviving command. Matcher fields on
 * events without a matcher subject are discarded. A matcher-bearing supported
 * runnable group with an invalid regex, or an HTTP hook with an unusable URL,
 * throws a `SyntaxError`, allowing the bridge to reject that config layer
 * before listener registration.
 *
 * @param raw - the parsed JSON config: a settings object with a `hooks` key, or the bare
 *   event map.
 * @param vars - substitution values applied to every surviving `command` (defaults to
 *   none).
 * @returns the runnable per-event groups plus the skipped non-runnable hooks.
 */
export function parseClaudeCodeConfig(raw: unknown, vars: SubstitutionVars = {}): ParsedClaudeConfig {
  const config: ClaudeCodeHookConfig = {}
  const skipped: SkippedHook[] = []
  // Accept either `{ hooks: { … } }` (a settings file) or the bare event map.
  const root = asObject(raw)
  const hooksMap = root ? asObject(root.hooks) ?? root : undefined
  if (!hooksMap) return { config, skipped }

  for (const event of CLAUDE_EVENTS) {
    const rawGroups = hooksMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups: MatcherGroup[] = []
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      const handlers: MatcherGroup['hooks'] = []
      for (const rawHook of group.hooks) {
        const hook = asObject(rawHook)
        if (!hook) continue
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        if (type !== 'command' && type !== 'http') {
          skipped.push({ event, type })
          continue
        }
        const timeout = typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {}
        if (type === 'http') {
          if (typeof hook.url !== 'string' || hook.url.length === 0) continue
          const handler: HttpHook = { url: assertHttpUrl(hook.url), ...timeout }
          const headers = headersOf(hook.headers)
          if (headers !== undefined) handler.headers = headers
          handlers.push(handler)
          continue
        }
        if (typeof hook.command !== 'string') continue
        const command: CommandHook = { command: substituteCommand(hook.command, vars), ...timeout }
        handlers.push(command)
      }
      if (handlers.length === 0) continue
      const matcher = MATCHERLESS_EVENTS[event] === true
        ? undefined
        : typeof group.matcher === 'string' ? group.matcher : undefined
      const diagnostic = matcherDiagnostic(matcher, 'claude-code')
      if (diagnostic !== undefined) throw new SyntaxError(`${diagnostic} on event ${JSON.stringify(event)}`)
      groups.push({
        ...matcher !== undefined ? { matcher } : {},
        hooks: handlers,
      })
    }
    if (groups.length > 0) config[event] = groups
  }

  return { config, skipped }
}
