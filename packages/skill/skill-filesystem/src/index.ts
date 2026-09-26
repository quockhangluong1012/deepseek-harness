/**
 * Local filesystem skill provider.
 *
 * This package is one implementation of the `ctx.skills` provider registry. It
 * discovers directory-bundle and flat Markdown skills from project, custom, and
 * user roots, parses YAML frontmatter, and loads bodies through `ctx.fs` when a
 * filesystem service is present.
 *
 * @module @deepseek-ai/dsh-skill-filesystem
 */

import { access, lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { unwatchFile, watchFile, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-questions'
import chokidar from 'chokidar'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  BUNDLED_SKILL_RANK,
  isSkillName,
  type SkillBlueprint,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
  type SkillProviderObservation,
  type SkillSource,
} from '@deepseek-ai/dsh-skill'

const PROJECT_DSH_RANK = 100
const PROJECT_HERMES_RANK = 150
const PROJECT_AGENTS_RANK = 200
const PROJECT_CLAUDE_RANK = 250
const CUSTOM_RANK = 300
const USER_DSH_RANK = 400
const USER_AGENTS_RANK = 500
const USER_CLAUDE_RANK = 550
const DEFAULT_WATCH_STABILITY_THRESHOLD_MS = 200
const DEFAULT_WATCH_POLL_INTERVAL_MS = 100
const DEFAULT_WATCH_MAX_PROJECTS = 128

/** Question id the project-trust answer is keyed by. */
const PROJECT_TRUST_QUESTION_ID = 'project-skills-trust'
/** Option label that accepts a project root; every other answer declines it. */
const PROJECT_TRUST_LABEL = 'Trust this folder'
/** Option label that declines a project root. */
const PROJECT_TRUST_DECLINE_LABEL = 'Skip'

export const name = 'skill-filesystem'
export const inject = ['skills']

/** Local filesystem skill provider configuration. */
export interface Config {
  /** Unique provider name. Defaults to `filesystem`. */
  providerName?: string
  /** Whether project and user roots are included around custom roots. */
  includeDefaultRoots?: boolean
  /** DeepSeek Harness config root. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Shared agent config root. Defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  agentsHome?: string
  /** Claude Code config root, scanned for its `.claude/skills` project/user compatibility roots. Defaults to `~/.claude`. */
  claudeHome?: string
  /** Additional skill roots scanned after project roots and before user roots. */
  customSkillDirs?: string[]
  /**
   * Absolute project roots whose `.dsh/skills`, `.hermes/skills`, `.agents/skills`,
   * and `.claude/skills` index; others are skipped. Volatile, so the project-trust
   * answer records an accepted root here through the settings service and a recorded
   * answer reaches the running provider without a remount.
   */
  trustedProjectDirs: Volatile<string[]>
  /** Whether any project roots index; false disables project discovery entirely. */
  projectDiscovery?: boolean
  /** Whether host-local skill roots are watched for catalog changes. */
  watch?: boolean
  /** Whether Chokidar uses polling instead of native filesystem events. */
  watchUsePolling?: boolean
  /** Milliseconds a changed skill entry must remain stable before it is observed. */
  watchStabilityThresholdMs?: number
  /** Milliseconds between Chokidar stability or polling probes. */
  watchPollIntervalMs?: number
  /** Maximum distinct project roots whose skill directories remain watched. */
  watchMaxProjects?: number
  /** Whether watched symbolic links follow their target files. */
  watchFollowSymlinks?: boolean
  /** Bundled skill root; defaults to `$DSH_BUNDLED_SKILL_DIR` when default roots are included, otherwise mounts none. */
  bundledSkillDir?: string
}

/**
 * Configuration a composition supplies for one provider instance. The loader
 * resolves `trustedProjectDirs` into a live reference before {@link apply} runs,
 * so this input type carries the plain list a profile writes.
 */
export type ConfigInput = Omit<Config, 'trustedProjectDirs'> & { trustedProjectDirs?: string[] }

export const Config: Schema<ConfigInput, Config> = z.object({
  providerName: z.string().min(1).default('filesystem'),
  includeDefaultRoots: z.boolean().default(true),
  dshHome: z.string(),
  agentsHome: z.string(),
  claudeHome: z.string(),
  customSkillDirs: z.array(z.string()).default([]),
  trustedProjectDirs: z.array(z.string()).default([]).volatile(),
  projectDiscovery: z.boolean().default(true),
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchStabilityThresholdMs: z.number().default(DEFAULT_WATCH_STABILITY_THRESHOLD_MS),
  watchPollIntervalMs: z.number().default(DEFAULT_WATCH_POLL_INTERVAL_MS),
  watchMaxProjects: z.number().default(DEFAULT_WATCH_MAX_PROJECTS),
  watchFollowSymlinks: z.boolean().default(true),
  bundledSkillDir: z.string(),
})

interface SkillRoot {
  path: string
  source: SkillSource
  rank: number
  skipSystem?: boolean
  projectRoot?: string
  trustedHost?: boolean
}

interface SkillRootEntry {
  name: string
  type: 'directory' | 'file' | 'other'
  path: string
}

interface SkillText {
  path: string
  content: string
}

interface ParsedSkill extends SkillText {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  metadata?: Record<string, unknown>
  /** Sandbox environment variable names from frontmatter `required_env`, dropped when malformed. */
  requiredEnv?: readonly string[]
  /** Non-secret configuration from frontmatter `config`; scalar values are stored as strings. */
  config?: Readonly<Record<string, string>>
  /** Frontmatter `platforms`: the skill is hidden unless one entry names the running platform. */
  platforms?: readonly string[]
  /** Frontmatter `requires_tools`: every named tool must be mounted for the skill to appear. */
  requiresTools?: readonly string[]
  /** Frontmatter `requires_toolsets`: every named toolset must be mounted for the skill to appear. */
  requiresToolsets?: readonly string[]
  /** Frontmatter `fallback_for_tools`: the skill hides while any named tool is mounted. */
  fallbackForTools?: readonly string[]
  /** Frontmatter `fallback_for_toolsets`: the skill hides while any named toolset is mounted. */
  fallbackForToolsets?: readonly string[]
  /** Frontmatter `requires`: prerequisite skill names that must route alongside this one. */
  requires?: readonly string[]
  /**
   * Frontmatter `conflicts_with`: skill names this skill must not be selected
   * alongside. The relation is symmetric — one side declaring it excludes the
   * pair — and carried like `requires`, never gating discovery.
   */
  conflictsWith?: readonly string[]
  /** Frontmatter `compatible_with`: allowlist of skills this one may load beside. */
  compatibleWith?: readonly string[]
  /** Frontmatter `composable_with`: allowlist of skills this one may be synthesized with. */
  composableWith?: readonly string[]
  /** Frontmatter `capabilities`: capability names the skill needs; carried like `requires`, never gating. */
  capabilities?: readonly string[]
  /** Frontmatter `inputs`: data names the skill consumes; carried like `requires`, never gating. */
  inputs?: readonly string[]
  /** Frontmatter `outputs`: data names the skill produces, satisfying another skill's `requires`. */
  outputs?: readonly string[]
  /** Frontmatter `derived_from`: skills this body was synthesized from; carried like `requires`. */
  derivedFrom?: readonly string[]
  /** Frontmatter `version`: free-form version label, dropped when malformed. */
  version?: string
  /** Frontmatter `testScenarios`: scenario names usable by the scorer/optimizer; carried like `requires`. */
  testScenarios?: readonly string[]
  /** Frontmatter `blueprint`, dropped when malformed. */
  blueprint?: SkillBlueprint
}

/** One finding from the project-skill security scan. */
export interface SkillScanFinding {
  /** Stable rule id, safe to repeat in host logs. */
  readonly rule: string
  /** What the matched pattern does, repeated in the quarantine warning. */
  readonly detail: string
}

/** One rule of the project-skill security scan. */
interface ProjectSkillScanRule {
  readonly rule: string
  /** Every pattern must match somewhere in the scanned text. */
  readonly patterns: readonly RegExp[]
  readonly detail: string
}

interface LocalLocator {
  path: string
  directory: string
}

interface ResolvedWatchConfig {
  enabled: boolean
  usePolling: boolean
  stabilityThresholdMs: number
  pollIntervalMs: number
  maxProjects: number
  followSymlinks: boolean
}

/** Register the local filesystem skill provider on `ctx.skills`. */
export function apply(ctx: Context, config: Config): void {
  let provider!: FileSystemSkillProvider
  ctx.skills.registerProvider((control) => {
    provider = new FileSystemSkillProvider(ctx, control, config)
    return provider
  })
  ctx.effect(function* () {
    yield async () => { await provider.dispose() }
  }, 'skill-filesystem watcher')
  ctx.on('fs/observed', (target, _observation, actor) => {
    if (mutationToolName(actor) === undefined) return
    provider.observeHostMutation(target.displayPath)
  })
}

/** Provider that maps local project/user skill roots into `ctx.skills`. */
export class FileSystemSkillProvider implements SkillProvider {
  readonly name: string
  private readonly includeDefaultRoots: boolean
  private readonly dshHome: string
  private readonly agentsHome: string
  private readonly claudeHome: string
  private readonly customSkillDirs: string[]
  private readonly trustedProjectDirs: Volatile<string[]>
  /** Project roots this provider's own answers trusted, resolved like configured entries. */
  private readonly sessionTrustedProjectDirs = new Set<string>()
  /** Outstanding per-root trust questions, so one discovery asks and concurrent callers await the same answer. */
  private readonly trustQuestions = new Map<string, Promise<boolean>>()
  private readonly projectDiscovery: boolean
  private readonly warnedUntrusted = new Set<string>()
  /** Project-skill scan verdicts, keyed by resolved path and stamped with the modification time. */
  private readonly scanVerdicts = new Map<string, ProjectSkillScanRecord>()
  private readonly watchManager: SkillWatchManager
  private readonly bundledSkillDir: string | undefined
  private disposal: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    control: SkillProviderControl,
    config: Config,
  ) {
    this.name = config.providerName ?? 'filesystem'
    this.includeDefaultRoots = config.includeDefaultRoots ?? true
    this.dshHome = resolveDshHome(config.dshHome)
    this.agentsHome = resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
    this.claudeHome = resolve(config.claudeHome ?? join(homedir(), '.claude'))
    this.customSkillDirs = (config.customSkillDirs ?? []).map(root => resolve(root))
    this.trustedProjectDirs = config.trustedProjectDirs
    // Fail loud at load on a relative entry; a live settings edit is re-validated on the next discovery.
    for (const root of config.trustedProjectDirs.get()) resolveTrustedRoot(root)
    this.projectDiscovery = config.projectDiscovery ?? true
    this.watchManager = new SkillWatchManager(ctx, control.invalidate, resolveWatchConfig(config))
    control.signal.addEventListener('abort', () => { void this.dispose() }, { once: true })
    // The environment bundled root is a default root: an isolated provider
    // must see only its explicit roots, or every such provider would
    // re-discover the app's bundled skills under its own provider name.
    const bundledSkillDir = config.bundledSkillDir
      ?? (this.includeDefaultRoots ? process.env.DSH_BUNDLED_SKILL_DIR : undefined)
    this.bundledSkillDir = bundledSkillDir === undefined ? undefined : resolve(bundledSkillDir)
  }

  /**
   * Discover local skill summaries for a cwd-sensitive workspace.
   * @param options - lookup options; `cwd` selects the project roots to scan.
   * @returns local provider candidates with stable root ranks; watcher startup
   *   failure returns readable candidates as an incomplete observation, and a
   *   quarantined project skill is skipped and counted on that observation.
   */
  async list(options: SkillLookupOptions): Promise<SkillCandidate[] | SkillProviderObservation> {
    const roots = await this.roots(options)
    let complete = true
    try {
      await this.watchManager.observeRoots(roots)
    } catch (error) {
      if (this.disposal !== undefined) throw error
      complete = false
    }
    const candidates: SkillCandidate[] = []
    const gate = new MountedToolGate(this.ctx.get('tools'))
    let quarantinedCount = 0
    for (const root of roots) {
      const found = await discoverRoot(root, this.ctx, this.name, {
        gate,
        ...root.projectRoot === undefined ? {} : { quarantine: this.quarantineProjectSkill },
      })
      quarantinedCount += found.quarantined
      candidates.push(...found.candidates)
    }
    return complete && quarantinedCount === 0
      ? candidates
      : { candidates, complete, quarantinedCount }
  }

  /**
   * Load a complete local skill body from the candidate's file locator.
   * @param candidate - the winning candidate returned by this provider.
   * @param options - lookup options whose signal cancels filesystem reads.
   * @returns the full local skill, or `undefined` if the file disappeared or a
   *   project skill is quarantined by the security scan.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as LocalLocator
    const raw = await readSkillText(this.ctx, locator.path, options.signal, candidate.source === 'bundled')
    options.signal?.throwIfAborted()
    if (raw === undefined) return undefined
    if (candidate.source.startsWith('project-') && await this.quarantineProjectSkill(raw.path, raw.content)) return undefined
    const parsed = parseSkillText(raw, this.ctx)
    if (parsed === undefined) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: parsed.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: parsed.path,
      ...parsed.metadata !== undefined ? { metadata: parsed.metadata } : {},
      ...parsed.requiredEnv !== undefined ? { requiredEnv: parsed.requiredEnv } : {},
      ...parsed.requires !== undefined ? { requires: parsed.requires } : {},
      ...parsed.conflictsWith !== undefined ? { conflictsWith: parsed.conflictsWith } : {},
      ...parsed.compatibleWith !== undefined ? { compatibleWith: parsed.compatibleWith } : {},
      ...parsed.composableWith !== undefined ? { composableWith: parsed.composableWith } : {},
      ...parsed.capabilities !== undefined ? { capabilities: parsed.capabilities } : {},
      ...parsed.inputs !== undefined ? { inputs: parsed.inputs } : {},
      ...parsed.outputs !== undefined ? { outputs: parsed.outputs } : {},
      ...parsed.derivedFrom !== undefined ? { derivedFrom: parsed.derivedFrom } : {},
      ...parsed.version !== undefined ? { version: parsed.version } : {},
      ...parsed.testScenarios !== undefined ? { testScenarios: parsed.testScenarios } : {},
      ...parsed.config !== undefined ? { config: parsed.config } : {},
      blueprint: parsed.blueprint,
      content: parsed.content,
    }
  }

  /**
   * Invalidate this provider synchronously after a first-party filesystem mutation.
   * @param path - host display path observed after a model-facing write or edit.
   */
  observeHostMutation(path: string): void {
    this.watchManager.observeHostMutation(path)
  }

  /**
   * Apply the security scan to one project skill file. Dangerous content is
   * quarantined: the skill is skipped and named in the host log, never in the
   * model catalog.
   * @param path - resolved absolute path of the file that was read.
   * @param content - the raw file text, frontmatter included.
   * @returns whether the skill is quarantined and must not be indexed.
   */
  private readonly quarantineProjectSkill = async (path: string, content: string): Promise<boolean> => {
    const findings = await this.scanVerdict(path, content)
    if (findings.length === 0) return false
    const reasons = findings.map(finding => `${finding.rule} (${finding.detail})`).join('; ')
    this.ctx.logger.warn(`skill file ${path} quarantined: dangerous content matched ${reasons}`)
    return true
  }

  /**
   * Scan one project skill's text, reusing the verdict cached for an unchanged
   * file. The cache key is the resolved path plus the host modification time,
   * so a rewritten file is scanned again on the next discovery.
   * @param path - resolved absolute path of the skill file.
   * @param content - the raw file text, frontmatter included.
   * @returns the matched scan findings, empty for a clean skill.
   */
  private async scanVerdict(path: string, content: string): Promise<readonly SkillScanFinding[]> {
    const mtimeMs = await hostModificationTime(path)
    const cached = this.scanVerdicts.get(path)
    if (mtimeMs !== undefined && cached?.mtimeMs === mtimeMs) return cached.findings
    const findings = scanProjectSkill(content)
    if (mtimeMs !== undefined) this.scanVerdicts.set(path, { mtimeMs, findings })
    return findings
  }

  /**
   * Close every host watcher and contain late filesystem callbacks.
   * @returns a shared promise that settles when every watcher reaches quiescence.
   */
  dispose(): Promise<void> {
    this.disposal ??= this.watchManager.dispose()
    return this.disposal
  }

  private async roots(options: SkillLookupOptions): Promise<SkillRoot[]> {
    const roots: SkillRoot[] = []
    const cwd = options.cwd
    if (this.includeDefaultRoots && cwd !== undefined && this.projectDiscovery) {
      const projectRoot = await findProjectRoot(resolve(cwd), optionalFileSystem(this.ctx))
      // A trusted root contributes its project roots; an untrusted one asks the
      // human once and keeps the fail-closed skip when the answer is no, absent,
      // or unreachable. projectTrust records why on every refusal.
      const trusted = this.trustedRoots().some(root => sameAbsolutePath(root, projectRoot))
      if (trusted || await this.projectTrust(projectRoot, options)) {
        roots.push(
          { path: join(projectRoot, '.dsh/skills'), source: 'project-dsh', rank: PROJECT_DSH_RANK, projectRoot },
          { path: join(projectRoot, '.hermes/skills'), source: 'project-hermes', rank: PROJECT_HERMES_RANK, projectRoot },
          { path: join(projectRoot, '.agents/skills'), source: 'project-agents', rank: PROJECT_AGENTS_RANK, projectRoot },
          { path: join(projectRoot, '.claude/skills'), source: 'project-claude', rank: PROJECT_CLAUDE_RANK, projectRoot },
        )
      }
    }
    roots.push(...this.customSkillDirs.map(path => ({ path, source: 'custom' as const, rank: CUSTOM_RANK })))
    if (this.includeDefaultRoots) {
      roots.push(
        { path: join(this.dshHome, 'skills'), source: 'user-dsh', rank: USER_DSH_RANK, skipSystem: true },
        { path: join(this.agentsHome, 'skills'), source: 'user-agents', rank: USER_AGENTS_RANK },
        { path: join(this.claudeHome, 'skills'), source: 'user-claude', rank: USER_CLAUDE_RANK },
      )
    }
    if (this.bundledSkillDir !== undefined) {
      roots.push({ path: this.bundledSkillDir, source: 'bundled', rank: BUNDLED_SKILL_RANK, trustedHost: true })
    }
    return roots
  }

  /**
   * The roots that may contribute project skills now: the volatile configuration
   * list plus the roots this provider's own answers trusted. Both are re-read on
   * every discovery, so a live settings edit and a recorded answer both apply.
   * Comparison runs on resolved absolute paths — symlinked aliases match only
   * when listed as resolved, and Windows compares case-insensitively, matching
   * the filesystem.
   * @returns resolved absolute roots, configuration first.
   * @throws when a configured entry is not an absolute path.
   */
  private trustedRoots(): string[] {
    return [
      ...this.trustedProjectDirs.get().map(root => resolveTrustedRoot(root)),
      ...this.sessionTrustedProjectDirs,
    ]
  }

  /**
   * Ask once per project root whether its skills may load. Concurrent callers
   * await the same question; a declined, unanswered, or unanswerable question
   * returns false, which keeps the root's skills unloaded for this provider.
   * @param projectRoot - resolved project root to question.
   * @param options - lookup options supplying the waiting lifetime.
   * @returns whether the root may contribute skills.
   */
  private projectTrust(projectRoot: string, options: SkillLookupOptions): Promise<boolean> {
    const answered = this.trustQuestions.get(projectRoot)
    if (answered !== undefined) return answered
    const asking = this.askProjectTrust(projectRoot, options)
    this.trustQuestions.set(projectRoot, asking)
    return asking
  }

  /**
   * Put the project-trust question to the calling agent's human and record an
   * accepted root, so the answer survives this session.
   * @param projectRoot - resolved project root to question.
   * @param options - lookup options supplying the calling agent's waiting lifetime.
   * @returns whether the human trusted the root.
   */
  private async askProjectTrust(projectRoot: string, options: SkillLookupOptions): Promise<boolean> {
    const questions = this.ctx.get('userQuestions')
    const agent = this.ctx.get('agents')?.currentInitiator()
    if (questions === undefined || agent === undefined) {
      this.warnUntrustedProjectRoot(projectRoot, 'no answerer is available to ask for trust')
      return false
    }
    let answer
    try {
      answer = await questions.ask({
        questions: [{
          id: PROJECT_TRUST_QUESTION_ID,
          header: 'Project skills',
          question: 'Trust this folder?',
          detail: `${projectRoot} can contribute skills from its .dsh/skills, .hermes/skills, `
            + '.agents/skills, and .claude/skills directories. Trusting it records this folder as a '
            + 'trusted project root; skipping it leaves those skills unloaded.',
          options: [
            { label: PROJECT_TRUST_LABEL, description: 'Index this folder\'s project skills, now and in later sessions.' },
            { label: PROJECT_TRUST_DECLINE_LABEL, description: 'Keep this folder\'s project skills unloaded.' },
          ],
        }],
        agent,
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      this.warnUntrustedProjectRoot(projectRoot, `the trust question went unanswered: ${errorMessage(error)}`)
      return false
    }
    const item = answer.answers.find(entry => entry.id === PROJECT_TRUST_QUESTION_ID)
    if (item === undefined || item.selected.length !== 1 || item.selected[0] !== PROJECT_TRUST_LABEL || item.custom !== undefined) {
      this.warnUntrustedProjectRoot(projectRoot, 'the folder was not trusted')
      return false
    }
    this.sessionTrustedProjectDirs.add(projectRoot)
    await this.rememberProjectTrust(projectRoot)
    return true
  }

  /**
   * Record an accepted project root in this plugin's own `trustedProjectDirs`
   * through the settings service, which persists it in the active profile's
   * patch. The running config reference is committed by the loader, so no
   * remount is needed. A missing or refusing settings service leaves the
   * session's answer in place and logs that it is not durable.
   * @param projectRoot - accepted resolved project root.
   */
  private async rememberProjectTrust(projectRoot: string): Promise<void> {
    const settings = this.ctx.get('settings')
    const namespace = this.ctx.fiber.entry?.options.id
    if (settings === undefined || namespace === undefined) {
      const missing = settings === undefined ? 'no settings service' : 'no profile entry'
      this.ctx.logger.warn(`skill file discovery trusts ${projectRoot} for this session only: ${missing} can record the answer`)
      return
    }
    try {
      await settings.mutate(namespace, [{ op: 'set', path: ['trustedProjectDirs'], value: this.trustedRoots() }])
    } catch (error) {
      this.ctx.logger.warn(`skill file discovery could not record trust for ${projectRoot}: ${errorMessage(error)}`)
    }
  }

  /**
   * Warn once per project root about skipped project skills, so an untrusted
   * checkout explains itself without spamming every discovery.
   * @param projectRoot - skipped project root.
   * @param reason - why the root stayed untrusted.
   */
  private warnUntrustedProjectRoot(projectRoot: string, reason: string): void {
    if (this.warnedUntrusted.has(projectRoot)) return
    this.warnedUntrusted.add(projectRoot)
    this.ctx.logger.warn(`skill file discovery skips untrusted project root ${projectRoot}: ${reason}`)
  }
}

type SkillWatchEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'

type RootWatchMode =
  | { kind: 'root'; anchor: string }
  | { kind: 'ancestor'; anchor: string; nextPath: string }

interface RootWatchState {
  root: SkillRoot
  owners: Set<string>
  watcher: WatchHandle | undefined
  opening: Promise<void> | undefined
  unhealthy: boolean
}

interface WatchHandle {
  mode: RootWatchMode
  close(): Promise<void> | void
}

/** Owns bounded host watchers while discovery and reads remain on the filesystem service. */
class SkillWatchManager {
  private readonly roots = new Map<string, RootWatchState>()
  private readonly projects = new Map<string, Set<string>>()
  private readonly lifecycle = new AbortController()
  private closing = false
  private invalidationQueued = false

  constructor(
    private readonly ctx: Context,
    private readonly invalidate: () => void,
    private readonly config: ResolvedWatchConfig,
  ) {}

  async observeRoots(roots: readonly SkillRoot[]): Promise<void> {
    if (this.closing) return
    const projectRoots = new Map<string, SkillRoot[]>()
    const pending: Promise<void>[] = []
    for (const root of roots) {
      if (root.projectRoot === undefined) {
        pending.push(this.retainRoot(root, `shared:${root.path}`))
        continue
      }
      const grouped = projectRoots.get(root.projectRoot) ?? []
      grouped.push(root)
      projectRoots.set(root.projectRoot, grouped)
    }
    for (const [projectRoot, grouped] of projectRoots) {
      const owner = `project:${projectRoot}`
      this.projects.delete(projectRoot)
      const paths = new Set(grouped.map(root => root.path))
      this.projects.set(projectRoot, paths)
      for (const root of grouped) pending.push(this.retainRoot(root, owner))
    }
    let evictedProject = false
    while (this.projects.size > this.config.maxProjects) {
      const oldest = this.projects.entries().next()
      /* v8 ignore next -- the loop condition proves one project exists. */
      if (oldest.done) break
      const [projectRoot, paths] = oldest.value
      this.projects.delete(projectRoot)
      const owner = `project:${projectRoot}`
      for (const path of paths) pending.push(this.releaseRoot(path, owner))
      evictedProject = true
    }
    await Promise.all(pending)
    if (evictedProject) this.invalidate()
  }

  observeHostMutation(path: string): void {
    if (this.closing) return
    const normalized = resolve(path)
    if (![...this.roots.values()].some(state => isPotentialSkillPath(state.root, normalized))) return
    this.invalidate()
  }

  async dispose(): Promise<void> {
    this.closing = true
    this.lifecycle.abort(new Error('skill-filesystem watcher disposed'))
    const states = [...this.roots.values()]
    this.roots.clear()
    this.projects.clear()
    await Promise.all(states.map(async (state) => {
      await settleWatcherOpening(state.opening)
      const watcher = state.watcher
      state.watcher = undefined
      if (watcher !== undefined) await this.closeWatcher(watcher)
    }))
  }

  private async retainRoot(root: SkillRoot, owner: string): Promise<void> {
    let state = this.roots.get(root.path)
    if (state === undefined) {
      state = { root, owners: new Set(), watcher: undefined, opening: undefined, unhealthy: true }
      this.roots.set(root.path, state)
    }
    state.owners.add(owner)
    if (this.config.enabled) await this.ensureWatcher(state)
  }

  private async releaseRoot(path: string, owner: string): Promise<void> {
    const state = this.roots.get(path)
    /* v8 ignore next -- Concurrent cwd observations can evict the same shared root before this release settles. */
    if (state === undefined) return
    state.owners.delete(owner)
    if (state.owners.size > 0) return
    this.roots.delete(path)
    await settleWatcherOpening(state.opening)
    const watcher = state.watcher
    state.watcher = undefined
    if (watcher !== undefined) await this.closeWatcher(watcher)
  }

  private ensureWatcher(state: RootWatchState): Promise<void> {
    /* v8 ignore next -- A scheduled rewatch can reach this guard only when teardown wins its await. */
    if (this.closing || !this.config.enabled) return Promise.resolve()
    if (state.opening !== undefined) return state.opening
    const opening = this.ensureCurrentWatcher(state)
    state.opening = opening
    void opening.then(
      () => {
        state.opening = undefined
      },
      () => {
        state.opening = undefined
      },
    )
    return opening
  }

  private async ensureCurrentWatcher(state: RootWatchState): Promise<void> {
    const watcher = state.watcher
    // Health is read once for the retained-handle guard and again after the
    // probe: a watcher error can flip the field while the probe is awaited.
    const healthy = !state.unhealthy
    if (watcher !== undefined && healthy) {
      const current = await resolveRootWatchMode(state.root.path, this.config.followSymlinks)
      // A child unlink can publish an empty catalog before root unlinkDir arrives.
      // Discovery therefore revalidates the retained handle independently.
      if (!state.unhealthy && sameWatchMode(watcher.mode, current)) return
    }
    await this.replaceWatcher(state)
  }

  private async replaceWatcher(state: RootWatchState): Promise<void> {
    const previous = state.watcher
    state.watcher = undefined
    if (previous !== undefined) await this.closeWatcher(previous)
    const tornDown = this.closing || state.owners.size === 0
    /* v8 ignore next -- Teardown can win while an unhealthy watcher is still closing. */
    if (tornDown) return
    try {
      const watcher = await this.openStableWatcher(state)
      /* v8 ignore next -- The loop returns no handle only when teardown wins between awaited probes. */
      if (watcher === undefined) return
      /* v8 ignore start -- Post-open teardown is timing-dependent; the disposal race has an explicit integration test. */
      if (this.closing || state.owners.size === 0) {
        await this.closeWatcher(watcher)
        return
      }
      /* v8 ignore stop */
      state.watcher = watcher
      state.unhealthy = false
    } catch (error) {
      if (!this.closing) {
        state.unhealthy = true
        this.ctx.logger.warn(`skill-filesystem: failed to watch ${state.root.path}: ${errorMessage(error)}`)
      }
      throw error
    }
  }

  // TODO(file-watch-service): Extract Chokidar and missing-root observation below into a Cordis
  // service; keep skill filtering and invalidation here.
  private async openStableWatcher(state: RootWatchState): Promise<WatchHandle | undefined> {
    while (!this.closing && state.owners.size > 0) {
      const mode = await resolveRootWatchMode(state.root.path, this.config.followSymlinks)
      const watcher = mode.kind === 'ancestor'
        ? this.openAncestorWatcher(state, mode)
        : await this.openRootWatcher(state, mode)
      const current = await resolveRootWatchMode(state.root.path, this.config.followSymlinks)
      /* v8 ignore else -- A host path transition between the two probes is timing-dependent. */
      if (sameWatchMode(mode, current)) return watcher
      /* v8 ignore next -- Covered by the same host path transition guard. */
      await this.closeWatcher(watcher)
    }
    /* v8 ignore next -- The loop exits only when teardown wins between awaited probes. */
    return undefined
  }

  private openAncestorWatcher(state: RootWatchState, mode: Extract<RootWatchMode, { kind: 'ancestor' }>): WatchHandle {
    const listener = (_current: Stats, _previous: Stats): void => {
      void this.handleAncestorWatchEvent(state, mode)
    }
    watchFile(mode.nextPath, {
      persistent: false,
      interval: this.config.pollIntervalMs,
    }, listener)
    return {
      mode,
      close() {
        unwatchFile(mode.nextPath, listener)
      },
    }
  }

  private async handleAncestorWatchEvent(
    state: RootWatchState,
    mode: Extract<RootWatchMode, { kind: 'ancestor' }>,
  ): Promise<void> {
    let current: RootWatchMode
    try {
      current = await resolveRootWatchMode(state.root.path, this.config.followSymlinks)
    } catch (error) {
      /* v8 ignore start -- Non-absence stat failures need a platform permission or I/O fault. */
      if (!this.closing && state.owners.size > 0) this.handleWatcherError(state, error)
      return
      /* v8 ignore stop */
    }
    if (this.closing || state.owners.size === 0 || sameWatchMode(mode, current)) return
    this.queueInvalidation()
    state.unhealthy = true
    this.scheduleRewatch(state)
  }

  private async openRootWatcher(state: RootWatchState, mode: Extract<RootWatchMode, { kind: 'root' }>): Promise<WatchHandle> {
    const watcher = chokidar.watch(mode.anchor, {
      // Chokidar owns late native fs.watch errors only for persistent watchers;
      // this provider's effect explicitly closes every handle at teardown.
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      followSymlinks: this.config.followSymlinks,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.stabilityThresholdMs,
        pollInterval: this.config.pollIntervalMs,
      },
      usePolling: this.config.usePolling,
      interval: this.config.pollIntervalMs,
    })
    const handle: WatchHandle = {
      mode,
      close: () => watcher.close(),
    }
    let ready = false
    const readiness = Promise.withResolvers<undefined>()
    const signal = this.lifecycle.signal
    if (signal.aborted) {
      await this.closeWatcher(handle)
      signal.throwIfAborted()
    }
    const onAbort = (): void => { readiness.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    const onError = (error: unknown): void => {
      if (!ready) {
        readiness.reject(error)
        return
      }
      this.handleWatcherError(state, error)
    }
    watcher.on('error', onError)
    watcher.once('ready', () => {
      ready = true
      readiness.resolve(undefined)
    })
    for (const event of ['add', 'addDir', 'change', 'unlink', 'unlinkDir'] as const) {
      watcher.on(event, (path) => { this.handleWatchEvent(state, mode, event, path) })
    }
    try {
      await readiness.promise
    } catch (error) {
      await this.closeWatcher(handle)
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    return handle
  }

  private handleWatchEvent(
    state: RootWatchState,
    mode: Extract<RootWatchMode, { kind: 'root' }>,
    event: SkillWatchEvent,
    path: string,
  ): void {
    const target = resolve(path)
    if (this.closing || !isRelevantWatchEvent({ ...state.root, path: mode.anchor }, event, target)) return
    this.queueInvalidation()
    if (target === mode.anchor && event === 'unlinkDir') {
      state.unhealthy = true
      this.scheduleRewatch(state)
    }
  }

  private handleWatcherError(state: RootWatchState, error: unknown): void {
    if (this.closing) return
    this.ctx.logger.warn(`skill-filesystem: watcher for ${state.root.path} failed: ${errorMessage(error)}`)
    state.unhealthy = true
    this.queueInvalidation()
    this.scheduleRewatch(state)
  }

  private scheduleRewatch(state: RootWatchState): void {
    const currentOpening = state.opening ?? Promise.resolve()
    void (async () => {
      await settleWatcherOpening(currentOpening)
      try {
        await this.ensureWatcher(state)
      } catch {
        // Watch startup logged the retry failure; the next incomplete discovery retries it again.
        return
      }
      this.queueInvalidation()
    })()
  }

  private queueInvalidation(): void {
    if (this.closing || this.invalidationQueued) return
    this.invalidationQueued = true
    queueMicrotask(() => {
      this.invalidationQueued = false
      /* v8 ignore next -- Effect teardown can win this queued microtask before provider disposal emits. */
      if (this.closing) return
      this.invalidate()
    })
  }

  private async closeWatcher(watcher: WatchHandle): Promise<void> {
    try {
      await watcher.close()
    } catch (error) {
      this.ctx.logger.warn(`skill-filesystem: failed to close watcher: ${errorMessage(error)}`)
    }
  }
}

async function settleWatcherOpening(opening: Promise<void> | undefined): Promise<void> {
  if (opening === undefined) return
  try {
    await opening
  } catch {
    // Watch startup already logged the underlying failure; teardown only contains it.
  }
}

function resolveWatchConfig(config: Config): ResolvedWatchConfig {
  const stabilityThresholdMs = config.watchStabilityThresholdMs ?? DEFAULT_WATCH_STABILITY_THRESHOLD_MS
  const pollIntervalMs = config.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS
  const maxProjects = config.watchMaxProjects ?? DEFAULT_WATCH_MAX_PROJECTS
  assertPositiveInteger('watchStabilityThresholdMs', stabilityThresholdMs)
  assertPositiveInteger('watchPollIntervalMs', pollIntervalMs)
  assertPositiveInteger('watchMaxProjects', maxProjects)
  return {
    enabled: config.watch ?? true,
    usePolling: config.watchUsePolling ?? false,
    stabilityThresholdMs,
    pollIntervalMs,
    maxProjects,
    followSymlinks: config.watchFollowSymlinks ?? true,
  }
}

async function resolveRootWatchMode(root: string, followSymlinks: boolean): Promise<RootWatchMode> {
  let candidate = root
  while (true) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) {
        const preserveRootLink = candidate === root
          && !followSymlinks
          && (await lstat(candidate)).isSymbolicLink()
        const anchor = preserveRootLink ? resolve(candidate) : await canonicalizeWatchPath(candidate)
        if (candidate === root) return { kind: 'root', anchor }
        const firstSegment = relative(candidate, root).split(sep)[0]
        /* v8 ignore next -- candidate is a strict ancestor of root. */
        if (firstSegment === undefined || firstSegment.length === 0) return { kind: 'root', anchor }
        return { kind: 'ancestor', anchor, nextPath: join(anchor, firstSegment) }
      }
    } catch (error) {
      /* v8 ignore next -- Non-absence stat failures are platform/permission-specific and propagate as incomplete discovery. */
      if (!isAbsentPathError(error)) throw error
    }
    const parent = dirname(candidate)
    /* v8 ignore next -- Traversal reaches the existing filesystem root before this fallback. */
    if (parent === candidate) return { kind: 'ancestor', anchor: candidate, nextPath: root }
    candidate = parent
  }
}

function sameWatchMode(left: RootWatchMode, right: RootWatchMode): boolean {
  return left.kind === right.kind
    && left.anchor === right.anchor
    && (left.kind === 'root' || (right.kind === 'ancestor' && left.nextPath === right.nextPath))
}

function isRelevantWatchEvent(
  root: SkillRoot,
  event: SkillWatchEvent,
  path: string,
): boolean {
  const segments = containedSegments(root.path, path)
  if (segments === undefined) return false
  if (segments.length === 0) return event === 'addDir' || event === 'unlinkDir'
  if (root.skipSystem === true && segments[0] === '.system') return false
  if (segments.length === 1) {
    if (event === 'addDir' || event === 'unlinkDir') return true
    return segments[0]?.endsWith('.md') === true
  }
  return segments.length === 2
    && segments[1] === 'SKILL.md'
    && event !== 'addDir'
    && event !== 'unlinkDir'
}

function isPotentialSkillPath(root: SkillRoot, path: string): boolean {
  const segments = containedSegments(root.path, path)
  if (segments === undefined || segments.length === 0 || segments.length > 2) return false
  if (root.skipSystem === true && segments[0] === '.system') return false
  return segments.length === 1
    ? segments[0]?.endsWith('.md') === true
    : segments[1] === 'SKILL.md'
}

function containedSegments(root: string, path: string): string[] | undefined {
  const child = relative(root, path)
  if (child.length === 0) return []
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined
  return child.split(sep)
}

function mutationToolName(actor: object | undefined): 'edit' | 'write' | undefined {
  if (actor === undefined || !('name' in actor)) return undefined
  const value = actor.name
  return value === 'edit' || value === 'write' ? value : undefined
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`skill-filesystem: ${field} must be a positive integer`)
  }
}

/**
 * Resolve one `trustedProjectDirs` entry.
 * @param root - raw configured or recorded project root.
 * @returns the resolved absolute path.
 * @throws when the entry is not an absolute path.
 */
function resolveTrustedRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new Error(`skill-filesystem: trustedProjectDirs entries must be absolute paths, got ${JSON.stringify(root)}`)
  }
  return resolve(root)
}

function isAbsentPathError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')
}

function isAbsentSkillPathError(error: unknown): boolean {
  return isAbsentPathError(error)
    || hasErrorCode(error, 'FS_NOT_FOUND')
    || hasErrorCode(error, 'FS_NOT_DIRECTORY')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/**
 * High-signal dangerous automation patterns the project-skill security scan
 * looks for. The scan is deliberately conservative: a rule matches only text
 * that downloads or decodes code into a shell, wipes a filesystem root, or
 * pairs a credential store with network egress, so an ordinary project skill
 * is never quarantined on a passing mention alone.
 */
const PROJECT_SKILL_SCAN_RULES: readonly ProjectSkillScanRule[] = [
  {
    rule: 'pipe-to-shell',
    patterns: [/\b(?:curl|wget)\b[^\n|]*\|[^\n|]*\b(?:ba|z|k)?sh\b/i],
    detail: 'pipes a network download into a shell',
  },
  {
    rule: 'encoded-shell',
    patterns: [/\bbase64\s+(?:-d|--decode)\b[^\n|]*\|[^\n|]*\b(?:ba|z|k)?sh\b/i],
    detail: 'decodes an encoded payload into a shell',
  },
  {
    rule: 'root-delete',
    patterns: [/\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\s+(?:\/(?:\s|$|\*)|~(?:\/|\s|$)|\$(?:HOME|\{HOME\}))/i],
    detail: 'recursively deletes a filesystem root or the home directory',
  },
  {
    rule: 'credential-exfiltration',
    patterns: [
      /(?:~\/\.ssh\b|id_rsa\b|\.aws\/credentials\b|\.config\/gh\/hosts\.yml\b|\/etc\/shadow\b)/i,
      /\b(?:curl|wget|nc|netcat|fetch)\b/i,
    ],
    detail: 'reads a credential store and also makes a network request',
  },
]

/**
 * Scan one skill file's raw text for the dangerous patterns above.
 * @param content - the raw file text, frontmatter included.
 * @returns one finding per matched rule, in rule order; empty for a clean skill.
 */
export function scanProjectSkill(content: string): SkillScanFinding[] {
  return PROJECT_SKILL_SCAN_RULES
    .filter(rule => rule.patterns.every(pattern => pattern.test(content)))
    .map(rule => ({ rule: rule.rule, detail: rule.detail }))
}

/** One cached project-skill scan verdict. */
interface ProjectSkillScanRecord {
  /** Host modification time the findings were computed from. */
  mtimeMs: number
  findings: readonly SkillScanFinding[]
}

/**
 * Modification time of one skill file on the host filesystem. A path the host
 * cannot stat — a backend path from a remote workspace — yields `undefined`,
 * and the file is then scanned without a cache entry.
 * @param path - resolved absolute path of the skill file.
 * @returns the modification time in milliseconds, or `undefined`.
 */
async function hostModificationTime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/** Platform spellings accepted in frontmatter `platforms`, keyed by `process.platform`. */
const PLATFORM_ALIASES: Readonly<Record<string, string>> = { darwin: 'macos', win32: 'windows' }

/**
 * Whether the running platform satisfies a skill's `platforms` allowlist.
 * Matching accepts the `process.platform` spelling and the agentskills.io
 * alias for it (`darwin`/`macos`, `win32`/`windows`), case-insensitively.
 * @param skill - the parsed skill carrying an optional platform allowlist.
 * @returns whether the skill may appear on this host.
 */
function supportsCurrentPlatform(skill: ParsedSkill): boolean {
  if (skill.platforms === undefined) return true
  const current = process.platform
  const alias = PLATFORM_ALIASES[current]
  return skill.platforms.some((platform) => {
    const normalized = platform.toLowerCase()
    return normalized === current || (alias !== undefined && normalized === alias)
  })
}

/** The mounted tool registry as skill gating reads it. */
interface MountedToolRegistry {
  get(name: string): unknown
  schemas(): readonly { readonly name: string }[]
}

/**
 * Tool availability for skill gating. A toolset is addressed by the name
 * prefix its tools share (`web` → `web_search`), so the mounted names are
 * enumerated at most once per gate.
 */
class MountedToolGate {
  private names: Set<string> | undefined

  constructor(private readonly registry: MountedToolRegistry | undefined) {}

  /**
   * Whether one exact tool name resolves in the mounted registry.
   * @param name - the tool name a skill requires.
   * @returns whether the tool is available.
   */
  hasTool(name: string): boolean {
    return this.registry?.get(name) !== undefined
  }

  /**
   * Whether any mounted tool belongs to the named toolset.
   * @param name - the toolset name a skill requires or falls back for.
   * @returns whether the toolset has at least one mounted tool.
   */
  hasToolset(name: string): boolean {
    if (this.registry === undefined) return false
    const names = this.names ??= new Set(this.registry.schemas().map(schema => schema.name))
    const prefix = `${name}_`
    for (const toolName of names) {
      if (toolName.startsWith(prefix)) return true
    }
    return false
  }
}

/**
 * Whether a parsed skill may enter the catalog on this host: `platforms` must
 * name the running platform, every `requires_tools`/`requires_toolsets` entry
 * must be mounted, and a `fallback_for_*` skill hides while the tool or
 * toolset it substitutes for is available.
 * @param skill - the parsed skill to gate.
 * @param gate - mounted-tool availability for this discovery.
 * @returns whether the skill is offered to consumers.
 */
function isSkillOffered(skill: ParsedSkill, gate: MountedToolGate): boolean {
  if (!supportsCurrentPlatform(skill)) return false
  if (!(skill.requiresTools ?? []).every(tool => gate.hasTool(tool))) return false
  if (!(skill.requiresToolsets ?? []).every(toolset => gate.hasToolset(toolset))) return false
  if ((skill.fallbackForTools ?? []).some(tool => gate.hasTool(tool))) return false
  if ((skill.fallbackForToolsets ?? []).some(toolset => gate.hasToolset(toolset))) return false
  return true
}

/** One root's discovery result: the candidates it contributes and how many project skills quarantine removed. */
interface RootDiscovery {
  candidates: SkillCandidate[]
  quarantined: number
}

/**
 * Project-skill quarantine decision: `true` skips the skill and counts it.
 * Absent for roots the harness owns.
 */
type ProjectSkillQuarantine = (path: string, content: string) => Promise<boolean>

/** Per-discovery inputs shared by every root scan. */
interface DiscoveryOptions {
  /** Platform and mounted-tool gate. */
  readonly gate: MountedToolGate
  /** Security scan applied to project-owned roots only. */
  readonly quarantine?: ProjectSkillQuarantine
}

async function discoverRoot(root: SkillRoot, ctx: Context, provider: string, options: DiscoveryOptions): Promise<RootDiscovery> {
  const candidates: SkillCandidate[] = []
  let quarantined = 0
  const entries = await listSkillRootEntries(root, ctx)
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem && entry.name === '.system') continue
    const locator = entry.type === 'directory'
      ? { path: join(entry.path, 'SKILL.md'), directory: entry.path }
      : entry.type === 'file' && entry.name.endsWith('.md')
        ? { path: entry.path, directory: root.path }
        : undefined
    if (locator === undefined) continue
    const raw = await readSkillText(ctx, locator.path, undefined, root.trustedHost === true)
    if (raw === undefined) continue
    const parsed = parseSkillText(raw, ctx)
    if (parsed === undefined) continue
    if (!isSkillOffered(parsed, options.gate)) continue
    if (options.quarantine !== undefined && await options.quarantine(raw.path, raw.content)) {
      quarantined += 1
      continue
    }
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      ...parsed.requires !== undefined ? { requires: parsed.requires } : {},
      ...parsed.conflictsWith !== undefined ? { conflictsWith: parsed.conflictsWith } : {},
      ...parsed.compatibleWith !== undefined ? { compatibleWith: parsed.compatibleWith } : {},
      ...parsed.composableWith !== undefined ? { composableWith: parsed.composableWith } : {},
      ...parsed.capabilities !== undefined ? { capabilities: parsed.capabilities } : {},
      ...parsed.inputs !== undefined ? { inputs: parsed.inputs } : {},
      ...parsed.outputs !== undefined ? { outputs: parsed.outputs } : {},
      ...parsed.derivedFrom !== undefined ? { derivedFrom: parsed.derivedFrom } : {},
      ...parsed.version !== undefined ? { version: parsed.version } : {},
      ...parsed.testScenarios !== undefined ? { testScenarios: parsed.testScenarios } : {},
      invocation: parsed.invocation,
      provider,
      source: root.source,
      rank: root.rank,
      locator,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: parsed.path,
      ...parsed.metadata !== undefined ? { metadata: parsed.metadata } : {},
    })
  }
  return { candidates, quarantined }
}

async function listSkillRootEntries(root: SkillRoot, ctx: Context): Promise<SkillRootEntry[]> {
  const fs = optionalFileSystem(ctx)
  if (fs !== undefined && root.trustedHost !== true) return await listSkillRootEntriesFromFileSystem(root, fs)
  return await listSkillRootEntriesFromNode(root, ctx)
}

async function listSkillRootEntriesFromFileSystem(root: SkillRoot, fs: FileSystem): Promise<SkillRootEntry[]> {
  try {
    return (await fsListDir(fs, root.path)).map(entryFromFs)
  } catch (error) {
    if (isAbsentSkillPathError(error)) return []
    throw error
  }
}

async function fsListDir(fs: FileSystem, path: string): Promise<FsDirEntry[]> {
  const target = await fs.resolve(path)
  return await fs.listDir(target)
}

function entryFromFs(entry: FsDirEntry): SkillRootEntry {
  return { name: entry.name, type: entry.type, path: entry.target.displayPath }
}

async function listSkillRootEntriesFromNode(root: SkillRoot, ctx: Context): Promise<SkillRootEntry[]> {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    /* v8 ignore else -- Native non-absence directory failures are provider-dependent; the ctx.fs path pins incomplete discovery. */
    if (isAbsentSkillPathError(error)) return []
    /* v8 ignore next -- Same native error branch as above. */
    throw error
  }

  const result: SkillRootEntry[] = []
  for (const entry of entries) {
    const path = join(root.path, entry.name)
    const type = await nodeEntryKind(path, entry, ctx)
    result.push({ name: entry.name, type: type ?? 'other', path })
  }
  return result
}

/** Parse one already-read skill file into the frontmatter fields this provider consumes. */
function parseSkillText(raw: SkillText, ctx: Context): ParsedSkill | undefined {
  const path = raw.path
  let parsed
  try {
    parsed = parseFrontmatter(raw.content)
  } catch (error) {
    ctx.logger.warn(`skill file ${path} ignored: invalid YAML frontmatter: ${errorMessage(error)}`)
    return undefined
  }
  if (!parsed) {
    ctx.logger.warn(`skill file ${path} ignored: missing YAML frontmatter`)
    return undefined
  }
  const name = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (name === undefined || description === undefined) {
    ctx.logger.warn(`skill file ${path} ignored: frontmatter requires name and description`)
    return undefined
  }
  if (!isSkillName(name)) {
    ctx.logger.warn(`skill file ${path} ignored: invalid skill name "${name}"`)
    return undefined
  }
  let invocation
  try {
    invocation = parseInvocationPolicy(parsed.data)
  } catch (error) {
    ctx.logger.warn(`skill file ${path} ignored: invalid invocation frontmatter: ${errorMessage(error)}`)
    return undefined
  }
  const config = optionalConfig(parsed.data, path, ctx)
  const blueprint = optionalBlueprint(parsed.data, path, ctx)
  const version = optionalVersion(parsed.data, path, ctx)
  warnUnknownFrontmatterKeys(parsed.data, path, ctx)
  return {
    name,
    description,
    ...optionalString(parsed.data, 'whenToUse'),
    invocation,
    ...optionalMetadata(parsed.data),
    ...stringListFields(parsed.data, path, ctx),
    ...config,
    ...blueprint,
    ...version,
    path,
    content: parsed.body.trim(),
  }
}

function optionalFileSystem(ctx: Context): FileSystem | undefined {
  return ctx.get('fs')
}

async function readSkillText(ctx: Context, path: string, signal?: AbortSignal, trustedHost = false): Promise<SkillText | undefined> {
  signal?.throwIfAborted()
  const fs = optionalFileSystem(ctx)
  if (fs !== undefined && !trustedHost) {
    return await readSkillTextFromFileSystem(ctx, fs, path, signal)
  }
  try {
    const resolvedPath = await realpath(path)
    return { path: resolvedPath, content: await readFile(resolvedPath, { encoding: 'utf8', signal }) }
  } catch (error) {
    signal?.throwIfAborted()
    if (isAbsentSkillPathError(error)) return undefined
    throw error
  }
}

async function readSkillTextFromFileSystem(
  ctx: Context, fs: FileSystem, path: string, signal?: AbortSignal,
): Promise<SkillText | undefined> {
  // A missing or temporarily inaccessible skill file is not fatal to discovery.
  signal?.throwIfAborted()
  let target
  try {
    target = await fs.resolve(path)
  } catch (error) {
    if (isAbsentSkillPathError(error)) return undefined
    throw error
  }
  signal?.throwIfAborted()
  let info
  try {
    info = await fs.stat(target, signal)
  } catch (error) {
    signal?.throwIfAborted()
    if (isAbsentSkillPathError(error)) return undefined
    throw error
  }
  if (info === undefined || info.type !== 'file') return undefined
  try {
    return { path: fs.processPath(target), content: await fs.readText(target, signal) }
  } catch (error) {
    signal?.throwIfAborted()
    if (isAbsentSkillPathError(error)) return undefined
    if (!hasErrorCode(error, 'FS_NOT_TEXT')) throw error
    ctx.logger.warn(`skill file ${path} ignored: ${fsReadErrorMessage(target, error)}`)
    return undefined
  }
}

function fsReadErrorMessage(target: FsTarget, error: unknown): string {
  return `failed to read text file at ${target.displayPath}: ${errorMessage(error)}`
}

async function nodeEntryKind(fullPath: string, entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }, ctx: Context): Promise<'directory' | 'file' | undefined> {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  /* v8 ignore next -- Non-file directory entries such as FIFOs are platform-specific and intentionally skipped. */
  if (!entry.isSymbolicLink()) return undefined
  try {
    const info = await stat(fullPath)
    if (info.isDirectory()) return 'directory'
    /* v8 ignore else -- the special-file symlink branch relies on POSIX /dev/null. */
    if (info.isFile()) return 'file'
    /* v8 ignore next -- The special-file symlink fixture relies on POSIX /dev/null. */
    return undefined
  } catch (error) {
    ctx.logger.warn(`skill entry ${fullPath} ignored: failed to follow symbolic link: ${errorMessage(error)}`)
    return undefined
  }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const yaml = raw.slice(start, closing.start)
  const parsed: unknown = parseYaml(yaml)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/**
 * Compare two resolved absolute paths with the filesystem's case semantics.
 * @param left - one resolved path.
 * @param right - the other resolved path.
 * @returns whether both name the same path.
 */
function sameAbsolutePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function findProjectRoot(cwd: string, fs: FileSystem | undefined): Promise<string> {  let current = cwd
  while (true) {
    if (await pathExists(join(current, '.git'), fs)) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

async function pathExists(path: string, fs: FileSystem | undefined): Promise<boolean> {
  if (fs !== undefined) {
    return await pathExistsInFileSystem(path, fs)
  }
  return await pathExistsInNode(path)
}

async function pathExistsInFileSystem(path: string, fs: FileSystem): Promise<boolean> {
  let target
  try {
    target = await fs.resolve(path)
  } catch {
    // A backend may reject or hide this candidate; continue walking upward.
    return false
  }
  try {
    return await fs.stat(target) !== undefined
  } catch {
    // Transient stat failures make only this git-root candidate unusable.
    return false
  }
}

async function pathExistsInNode(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // Missing host paths are expected while walking toward the filesystem root.
    return false
  }
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(data: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

/** Canonical invocation frontmatter keys; `parseInvocationPolicy` reads these spellings. */
const MODEL_INVOCATION_KEY = 'disable-model-invocation'
/** Canonical key controlling whether the skill appears in human-facing commands. */
const USER_INVOCATION_KEY = 'user-invocable'

/**
 * Rejected legacy invocation spellings mapped to the canonical key replacing them.
 * `parseInvocationPolicy` rejects every entry here and reads the canonical keys above, and the
 * frontmatter allowlist derives its recognized keys from this same list, so parser and allowlist
 * cannot drift apart.
 */
const INVOCATION_FRONTMATTER_KEYS: Readonly<Record<string, string>> = {
  disableModelInvocation: MODEL_INVOCATION_KEY,
  modelInvocable: MODEL_INVOCATION_KEY,
  userInvocable: USER_INVOCATION_KEY,
}

/**
 * Every invocation spelling the allowlist must recognize: each rejected legacy spelling plus the
 * canonical key replacing it, derived from `INVOCATION_FRONTMATTER_KEYS` so the allowlist and
 * `parseInvocationPolicy` cannot drift apart.
 * @returns a lookup table marking each recognized invocation key.
 */
function invocationFrontmatterKeys(): Record<string, true> {
  return Object.fromEntries(Object.entries(INVOCATION_FRONTMATTER_KEYS)
    .flatMap(([legacy, canonical]) => [[legacy, true], [canonical, true]] as Array<[string, true]>))
}

/** `ParsedSkill` fields fed by frontmatter keys sharing the non-empty string-array shape. */
type StringListField = 'requiredEnv' | 'platforms' | 'requiresTools' | 'requiresToolsets' | 'fallbackForTools' | 'fallbackForToolsets' | 'requires' | 'conflictsWith' | 'compatibleWith' | 'composableWith' | 'capabilities' | 'inputs' | 'outputs' | 'derivedFrom' | 'testScenarios'

/**
 * Frontmatter key to `ParsedSkill` field for every non-empty string-array
 * field this provider parses. The allowlist derives these keys from this one
 * table, so parser and allowlist cannot drift apart.
 */
const STRING_LIST_FRONTMATTER_FIELDS = [
  ['required_env', 'requiredEnv'],
  ['platforms', 'platforms'],
  ['requires_tools', 'requiresTools'],
  ['requires_toolsets', 'requiresToolsets'],
  ['fallback_for_tools', 'fallbackForTools'],
  ['fallback_for_toolsets', 'fallbackForToolsets'],
  ['requires', 'requires'],
  ['conflicts_with', 'conflictsWith'],
  ['compatible_with', 'compatibleWith'],
  ['composable_with', 'composableWith'],
  ['capabilities', 'capabilities'],
  ['inputs', 'inputs'],
  ['outputs', 'outputs'],
  ['derived_from', 'derivedFrom'],
  ['testScenarios', 'testScenarios'],
] as const satisfies readonly (readonly [string, StringListField])[]

/** Top-level frontmatter keys this provider consumes; any other key warns once and is ignored. */
const RECOGNIZED_FRONTMATTER_KEYS: Readonly<Record<string, true>> = {
  name: true,
  description: true,
  whenToUse: true,
  metadata: true,
  config: true,
  blueprint: true,
  version: true,
  ...Object.fromEntries(STRING_LIST_FRONTMATTER_FIELDS.map(([key]) => [key, true])) as Record<string, true>,
  ...invocationFrontmatterKeys(),
}

function parseInvocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  for (const [legacy, canonical] of Object.entries(INVOCATION_FRONTMATTER_KEYS)) {
    rejectLegacyInvocationKey(data, legacy, canonical)
  }
  const disableModelInvocation = frontmatterBoolean(data, MODEL_INVOCATION_KEY)
  const userInvocable = frontmatterBoolean(data, USER_INVOCATION_KEY)
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

function rejectLegacyInvocationKey(data: Record<string, unknown>, legacy: string, canonical: string): void {
  if (Object.hasOwn(data, legacy)) {
    throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function optionalMetadata(data: Record<string, unknown>): { metadata?: Record<string, unknown> } {
  const value = data.metadata
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { metadata: value as Record<string, unknown> }
  }
  return {}
}

function stringListFields(data: Record<string, unknown>, path: string, ctx: Context): Pick<ParsedSkill, StringListField> {
  const fields: Pick<ParsedSkill, StringListField> = {}
  for (const [key, field] of STRING_LIST_FRONTMATTER_FIELDS) {
    if (!Object.hasOwn(data, key)) continue
    if (isNonEmptyStringArray(data[key])) {
      fields[field] = data[key]
      continue
    }
    ctx.logger.warn(`skill file ${path}: frontmatter field "${key}" ignored: expected a non-empty array of non-empty strings`)
  }
  return fields
}

function optionalBlueprint(
  data: Record<string, unknown>, path: string, ctx: Context,
): { blueprint?: SkillBlueprint } {
  if (!Object.hasOwn(data, 'blueprint')) return {}
  const blueprint = parseBlueprint(data.blueprint)
  if (blueprint !== undefined) return { blueprint }
  ctx.logger.warn(`skill file ${path}: frontmatter field "blueprint" ignored: expected a mapping with non-empty string "schedule", "deliver" of "session" or "file", and non-empty string "prompt"`)
  return {}
}

function parseBlueprint(value: unknown): SkillBlueprint | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { schedule, deliver, prompt } = value as Record<string, unknown>
  if (typeof schedule !== 'string' || schedule.length === 0) return undefined
  if (deliver !== 'session' && deliver !== 'file') return undefined
  if (typeof prompt !== 'string' || prompt.length === 0) return undefined
  return { schedule, deliver, prompt }
}

function optionalConfig(
  data: Record<string, unknown>, path: string, ctx: Context,
): { config?: Readonly<Record<string, string>> } {
  if (!Object.hasOwn(data, 'config')) return {}
  const config = scalarStringRecord(data.config)
  if (config !== undefined) return { config }
  ctx.logger.warn(`skill file ${path}: frontmatter field "config" ignored: expected a mapping of scalar values`)
  return {}
}

function optionalVersion(
  data: Record<string, unknown>, path: string, ctx: Context,
): { version?: string } {
  if (!Object.hasOwn(data, 'version')) return {}
  const value = data.version
  if (typeof value === 'string' && value.length > 0) return { version: value }
  ctx.logger.warn(`skill file ${path}: frontmatter field "version" ignored: expected a non-empty string`)
  return {}
}

function warnUnknownFrontmatterKeys(data: Record<string, unknown>, path: string, ctx: Context): void {
  for (const key of Object.keys(data)) {
    if (Object.hasOwn(RECOGNIZED_FRONTMATTER_KEYS, key)) continue
    ctx.logger.warn(`skill file ${path}: unknown frontmatter field "${key}" ignored`)
  }
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && (value as unknown[]).every(entry => typeof entry === 'string' && entry.length > 0)
}

function scalarStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.every(([, entry]) => isScalar(entry))) return undefined
  return Object.fromEntries(entries.map(([key, entry]) => [key, String(entry)]))
}

/** YAML scalars, including null; mappings and sequences are collections. */
function isScalar(value: unknown): boolean {
  return value === null || typeof value !== 'object'
}

function errorMessage(error: unknown): string {
  return String(error)
}
