/**
 * Load-time skill environment: the declared `required_env` names forwarded from
 * the host environment, `skills.config` values injected over the skill's own
 * declared defaults, and opt-in inline shell expansion.
 *
 * Every value a skill needs at execution time is resolved here, before the
 * shared `renderSkillContent` wrapper frames the body, so both loader paths —
 * the `skill` tool and the user-explicit `/name` injection — see one resolved
 * body and one resolved execution environment.
 *
 * @module @deepseek-ai/dsh-tool-skill/load
 */

import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { expandSkillTemplates } from './template.ts'

/** Inline shell timeout used when `metadata.shellTimeoutMs` is absent. */
export const DEFAULT_SHELL_TIMEOUT_MS = 10_000

/** Maximum characters one inline shell expansion contributes to a skill body. */
export const MAX_SHELL_OUTPUT_CHARS = 4_000

/** Deployment-side per-skill configuration: `skills.config.<skill>.<key>`. */
export type SkillConfigMap = Readonly<Record<string, Readonly<Record<string, string>>>>

/** Inputs load-time resolution reads for one skill. */
export interface SkillLoadRequest {
  /** The skill about to be loaded. */
  readonly skill: SkillDefinition
  /** Deployment-side values from `skills.config`, keyed by skill name. */
  readonly skillsConfig?: SkillConfigMap | undefined
  /** Host environment the declared `required_env` names are read from. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** Deployment shell budgets; skill metadata wins when it declares a timeout. */
  readonly shellDefaults?: { timeoutMs: number; outputMaxChars: number } | undefined
}

/** Resolved load-time facts for one skill. */
export interface SkillLoadSpec {
  /** The skill this spec was resolved for. */
  readonly skill: SkillDefinition
  /** Environment entries for the skill's execution commands. */
  readonly env: Readonly<Record<string, string>>
  /** Configuration values injected into the body and execution environment. */
  readonly config: Readonly<Record<string, string>>
  /** Resolved inline shell expansion state. */
  readonly shell: { readonly enabled: boolean; readonly timeoutMs: number; readonly outputMaxChars: number }
}

/** Resolution outcome: a usable spec, or the explanatory misconfiguration load error. */
export type SkillLoadResolution =
  | { readonly ok: true; readonly spec: SkillLoadSpec }
  | { readonly ok: false; readonly error: string }

/** Inputs rendering one resolved skill body. */
export interface SkillRenderRequest {
  /** Resolved load-time facts. */
  readonly spec: SkillLoadSpec
  /** Skill directory used for `${DSH_SKILL_DIR}` and as the inline shell working directory. */
  readonly skillDir?: string | undefined
  /** Loading agent's session id used for `${DSH_SESSION_ID}`. */
  readonly sessionId?: string | undefined
  /** Mounted shell executor; absent leaves inline shell expansion unavailable. */
  readonly shell?: Pick<ShellExecutor, 'resolve' | 'run'> | undefined
  /** Cancels in-flight inline shell commands with the loading step. */
  readonly signal?: AbortSignal | undefined
  /** Host log sink for inline shell failures. */
  readonly warn: (message: string) => void
}

/** `${...}` sequence a load-time expansion may act on; an expression holds no brace. */
const PLACEHOLDER = /\$\{([^{}]*)\}/g

/**
 * Resolve the environment and configuration one skill needs before its body
 * renders. A declared `required_env` name absent from the host environment, a
 * declared config key with no value in either source, and malformed
 * `metadata.shell`/`metadata.shellTimeoutMs` values all fail here rather than
 * silently loading a skill that cannot run.
 * @param request - the skill plus the deployment-side and host value sources.
 * @returns the resolved spec, or the explanatory load error naming what is missing.
 */
export function resolveSkillLoad(request: SkillLoadRequest): SkillLoadResolution {
  const { skill } = request
  const env: Record<string, string> = {}
  for (const name of skill.requiredEnv ?? []) {
    const value = request.env?.[name]
    if (value === undefined || value === '') {
      return { ok: false, error: `skill "${skill.name}" requires environment variable "${name}", which the host environment does not set` }
    }
    env[name] = value
  }
  const deployed = request.skillsConfig?.[skill.name]
  const declared = new Set([...Object.keys(deployed ?? {}), ...Object.keys(skill.config ?? {})])
  const config: Record<string, string> = {}
  const missing: string[] = []
  for (const key of declared) {
    const deployedValue = deployed?.[key]
    const ownValue = skill.config?.[key]
    const value = declaredValue(deployedValue, ownValue)
    if (value === undefined) missing.push(key)
    else config[key] = value
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `skill "${skill.name}" requires configuration ${missing.map(key => `"${key}"`).join(', ')}, which neither skills.config nor the skill's own defaults provide`,
    }
  }
  const shell = resolveShell(skill, request.shellDefaults)
  return shell.ok
    ? { ok: true, spec: { skill, env, config, shell: shell.shell } }
    : { ok: false, error: shell.error }
}

/**
 * Render one skill body: `${DSH_SKILL_DIR}`/`${DSH_SESSION_ID}` expand first,
 * then each remaining `${...}` resolves to the skill's own config value when
 * the key is declared and to a shell command only when the skill opted in.
 * Input the skill did not declare and a body without the shell opt-in stay
 * verbatim, so an unconfigured skill renders exactly as it is written.
 * @param request - resolved spec plus directory, session id, shell executor, and warn sink.
 * @returns the body the shared `<skill_content>` wrapper frames.
 */
export async function renderSkillBody(request: SkillRenderRequest): Promise<string> {
  const expanded = expandSkillTemplates(request.spec.skill.content, {
    skillDir: request.skillDir,
    sessionId: request.sessionId,
  })
  const resolved = new Map<string, string>()
  const parts: string[] = []
  let cursor = 0
  for (const match of expanded.matchAll(PLACEHOLDER)) {
    let replacement = resolved.get(match[0])
    if (replacement === undefined) {
      replacement = await resolveExpression(match[0], request)
      resolved.set(match[0], replacement)
    }
    parts.push(expanded.slice(cursor, match.index), replacement)
    cursor = match.index + match[0].length
  }
  parts.push(expanded.slice(cursor))
  return parts.join('')
}

/** One placeholder's replacement text: config first, then opt-in inline shell. */
async function resolveExpression(expression: string, request: SkillRenderRequest): Promise<string> {
  const name = expression.slice(2, -1)
  if (name.length === 0) return expression
  const configured = request.spec.config[name]
  if (configured !== undefined) return configured
  if (!request.spec.shell.enabled) return expression
  return await runInlineShell(name, request)
}

/**
 * Run one inline shell command with the skill's execution environment, capped
 * and failed quiet: a failing, absent, or unavailable shell contributes
 * nothing to the body and warns on the host log.
 */
async function runInlineShell(command: string, request: SkillRenderRequest): Promise<string> {
  const shell = request.shell
  if (shell === undefined) {
    request.warn(`skill "${request.spec.skill.name}" inline shell is unavailable: no shell executor is mounted`)
    return ''
  }
  try {
    const spec = shell.resolve({
      command,
      ...request.skillDir !== undefined ? { workdir: request.skillDir } : {},
      timeoutMs: request.spec.shell.timeoutMs,
      stdoutMaxBytes: request.spec.shell.outputMaxChars * 4,
      ...request.signal !== undefined ? { signal: request.signal } : {},
      env: { ...request.spec.env, ...request.spec.config },
    })
    const result = await shell.run(spec)
    if (result.timedOut || result.aborted || result.exitCode !== 0) {
      request.warn(`skill "${request.spec.skill.name}" inline shell command failed: ${command}`)
      return ''
    }
    return capShellOutput(result.stdout.text.trim(), request.spec.shell.outputMaxChars)
  } catch (error) {
    request.warn(`skill "${request.spec.skill.name}" inline shell command failed: ${command}: ${String(error)}`)
    return ''
  }
}

/** Cap inline shell output at the resolved character budget without splitting a surrogate pair. */
function capShellOutput(text: string, outputMaxChars: number): string {
  if (text.length <= outputMaxChars) return text
  const capped = text.slice(0, outputMaxChars)
  const last = capped.charCodeAt(capped.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? capped.slice(0, -1) : capped
}

/** Resolve `metadata.shell` / `metadata.shellTimeoutMs`, rejecting malformed values. */
function resolveShell(
  skill: SkillDefinition,
  defaults: { timeoutMs: number; outputMaxChars: number } = {
    timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
    outputMaxChars: MAX_SHELL_OUTPUT_CHARS,
  },
): { ok: true; shell: SkillLoadSpec['shell'] } | { ok: false; error: string } {
  const metadata = skill.metadata
  const enabled = metadata?.shell
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return { ok: false, error: `skill "${skill.name}" metadata.shell must be a boolean` }
  }
  const configured = metadata?.shellTimeoutMs
  if (configured !== undefined && (typeof configured !== 'number' || !Number.isInteger(configured) || configured < 1)) {
    return { ok: false, error: `skill "${skill.name}" metadata.shellTimeoutMs must be a positive integer` }
  }
  return {
    ok: true,
    shell: { enabled: enabled === true, timeoutMs: configured ?? defaults.timeoutMs, outputMaxChars: defaults.outputMaxChars },
  }
}

/** The deployed value wins over the skill's own default; blank means no value. */
function declaredValue(deployed: string | undefined, own: string | undefined): string | undefined {
  if (deployed !== undefined && deployed.trim() !== '') return deployed
  return own !== undefined && own.trim() !== '' ? own : undefined
}
