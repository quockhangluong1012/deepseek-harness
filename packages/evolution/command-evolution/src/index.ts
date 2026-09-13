/**
 * Human-facing evolution commands over the memory store, the reviewer, the
 * curator, the trajectory exporter, and skill telemetry: staged-write
 * governance (`/memory`, `/skills`), on-demand lessons rebuilds (`/refine`),
 * the scope's recorded activity (`/journey`), curation status (`/curator`),
 * session export (`/trajectory`), a research-and-save turn (`/learn`), and
 * blueprint-backed skill suggestions (`/suggestions`). Every command but
 * `/learn` answers directly from the seams it reads; `/learn` builds a prompt
 * and queues it as one ordinary turn.
 * @module @deepseek-ai/dsh-command-evolution
 */

import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { serializeSessionLog } from '@deepseek-ai/dsh-session-log-export'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-evolution-memory'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionScopeId as EvolutionScopeIdBrand, StagedWrite } from '@deepseek-ai/dsh-evolution-memory'
import type {} from '@deepseek-ai/dsh-evolution-reviewer'
import type {} from '@deepseek-ai/dsh-evolution-curator'
import type { EvolutionCurator, PassSummary, PurgeReport, RollbackReport } from '@deepseek-ai/dsh-evolution-curator'
import type {} from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { SkillBlueprint } from '@deepseek-ai/dsh-skill'
import { isUsageRange, type UsageRange } from '@deepseek-ai/dsh-usage-ledger'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import { strToU8, zipSync } from 'fflate'
import { renderTimeline, scopeTimeline } from './journey.ts'

export * from './journey.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'command-evolution'

/** Required host services. */
export const inject = ['commands', 'workspaceRegistry', 'evolutionMemory']

/** Plugin configuration: the scope-identity namespace. */
export interface Config {
  /** Scope-identity namespace placed before the workspace key. Required: scopes never share a default namespace. */
  profile: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  profile: z.string().required(),
})

/** Validated scope membership behind one command invocation. */
interface ScopeMembership {
  id: WorkspaceId
  title: string
  path: string
}

/** Staged-write mutation verbs shared by the executor and its failure text. */
type StagedVerb = 'approve' | 'reject'

/** Argument grammar for `/memory`; anything else reports usage. */
const MEMORY_USAGE = 'Usage: /memory pending | approve <id> | reject <id>'

/** Argument grammar for `/refine`; anything else reports usage. */
const REFINE_USAGE = 'Usage: /refine (no arguments)'

/** Argument grammar for `/journey`; a bare call reports the last seven days. */
const JOURNEY_USAGE = 'Usage: /journey [today | 7d | 30d | all]'

/** Argument grammar for `/journey export`; anything else reports usage. */
const JOURNEY_EXPORT_USAGE = 'Usage: /journey export [today | 7d | 30d | all] [--out <path>]'

/** Argument grammar for `/skills`; anything else reports usage. */
const SKILLS_USAGE = 'Usage: /skills pending | approve <id>'

/** Argument grammar for `/curator`; anything else reports usage. */
const CURATOR_USAGE = 'Usage: /curator status | run [--dry-run] | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name>'

/** Argument grammar for `/trajectory`; anything else reports usage. */
const TRAJECTORY_USAGE = 'Usage: /trajectory [--out <path>] [--all]'

/** Argument grammar for `/learn`; a bare call reports usage. */
const LEARN_USAGE = 'Usage: /learn <anything>'

/** Argument grammar for `/suggestions`; the command takes no arguments. */
const SUGGESTIONS_USAGE = 'Usage: /suggestions (no arguments)'

/** The honest empty state while background review cannot propose skills yet. */
const SKILLS_EMPTY = 'No pending skill proposals. Background review proposes skills once the reviewer fork lands; write one directly with skill_manage.'

/** The honest empty state shared by a missing catalog and a blueprint-free catalog. */
const SUGGESTIONS_EMPTY = 'No blueprint-backed skills. A skill appears here when its frontmatter declares a blueprint; this command never installs the schedule it names.'

/**
 * Validate the scope namespace loudly at load.
 * @param profile - configured namespace.
 */
function checkProfile(profile: string): void {
  if (profile.length === 0) throw new Error('command-evolution: profile must be non-empty')
  if (profile.includes(':')) {
    throw new Error(`command-evolution: profile must not contain ':', got ${JSON.stringify(profile)}`)
  }
}

/**
 * Split raw command input on whitespace runs.
 * @param rawInput - exact text following the command name.
 * @returns non-empty argument words, or empty for bare invocations.
 */
function splitArgs(rawInput: string): string[] {
  return rawInput.trim().split(/\s+/u).filter(part => part.length > 0)
}

/**
 * Resolve the session's workspace the injector way: registry session ids
 * first, falling back to a canonical-path `cwd` match. Commands are one-shot,
 * so nothing is cached.
 * @param ctx - plugin context carrying the workspace registry.
 * @param session - invoking session.
 * @returns the membership, or undefined outside any workspace.
 */
async function resolveMembership(ctx: Context, session: Session): Promise<ScopeMembership | undefined> {
  const direct = ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(session.id))
  if (direct !== undefined) return { id: direct.id, title: direct.title, path: direct.path }
  const cwd = session.header.cwd
  const canonical = cwd === undefined ? undefined : await realpath(cwd).catch(() => undefined)
  const match = canonical === undefined
    ? undefined
    : ctx.workspaceRegistry.list().find(entry => entry.path === canonical)
  if (match === undefined) return undefined
  return { id: match.id, title: match.title, path: match.path }
}

/**
 * Render one staged entry as a stable single line.
 * @param entry - staged entry from the scope record.
 * @returns the pending-list line naming id, kind, op, gist, origin, and instant.
 */
function formatPendingLine(entry: StagedWrite): string {
  return `- ${entry.id} [${entry.kind}:${entry.op}] ${entry.gist} (session '${entry.originSessionId}', ${entry.createdAt})`
}

/**
 * Render a staged-entry list, honestly empty when nothing awaits a decision.
 * @param staged - staged entries in record order.
 * @param noun - singular noun naming what the entries are.
 * @returns the command text.
 */
function formatStagedList(staged: readonly StagedWrite[], noun: string): string {
  if (staged.length === 0) return `No pending ${noun}s.`
  const header = staged.length === 1 ? `1 pending ${noun}:` : `${staged.length} pending ${noun}s:`
  return [header, ...staged.map(formatPendingLine)].join('\n')
}

/**
 * Render one Remote failure from a staged mutation. A missing entry reports
 * the id; every other Remote rejection names its code and message and keeps
 * the entry staged. Plain errors are caller bugs and propagate.
 * @param verb - mutation the handler attempted.
 * @param id - staged entry identity.
 * @param failure - recognized Remote failure.
 * @returns the command error text.
 */
export function stagedFailureText(verb: StagedVerb, id: string, failure: RemoteFailure): string {
  if (failure.code === 'evolution/staged-not-found') return `No staged write '${id}'.`
  return `Cannot ${verb} '${id}' (${failure.code}): ${failure.message}. The entry stays staged.`
}

/**
 * Run one staged approve or reject against an entry the caller already
 * located and validated, mapping store rejections onto stable host text.
 * @param ctx - plugin context carrying the evolution memory store.
 * @param entry - the staged entry to mutate.
 * @param verb - mutation to run.
 * @param success - text to report once the mutation lands.
 * @returns the command result.
 */
async function mutateStaged(
  ctx: Context,
  entry: StagedWrite,
  verb: StagedVerb,
  success: string,
): Promise<CommandResult> {
  try {
    if (verb === 'approve') await ctx.evolutionMemory.approveStaged(entry.id)
    else await ctx.evolutionMemory.rejectStaged(entry.id)
  } catch (error) {
    const failure = remoteErrorOf(error)
    if (failure === undefined) throw error
    return { kind: 'error', text: stagedFailureText(verb, entry.id, failure) }
  }
  return { kind: 'success', text: success }
}

/**
 * Execute `/memory` against the session's scope. A bare invocation reports the
 * pending list, the grammar's default verb, as a bare `/journey` reports its
 * default window.
 * @param ctx - plugin context carrying the evolution memory store.
 * @param scope - scope identity resolved from the invoking session.
 * @param invocation - raw command input.
 * @returns the command result.
 */
async function executeMemory(
  ctx: Context,
  scope: EvolutionScopeIdBrand,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const [verb, id, ...rest] = splitArgs(invocation.rawInput)
  if ((verb === undefined || verb === 'pending') && id === undefined && rest.length === 0) {
    const record = ctx.evolutionMemory.read(scope)
    return { kind: 'success', text: formatStagedList(record?.staged ?? [], 'write') }
  }
  if ((verb === 'approve' || verb === 'reject') && id !== undefined && rest.length === 0) {
    const entry = ctx.evolutionMemory.read(scope)?.staged.find(candidate => candidate.id === id)
    if (entry === undefined) return { kind: 'error', text: `No staged write '${id}'.` }
    if (verb === 'approve' && entry.kind === 'skill') {
      return {
        kind: 'error',
        text: `Staged skill '${id}' (${entry.op}) is decided by '/skills approve ${id}': write the skill with skill_manage first, then approve there to drop the entry.`,
      }
    }
    return mutateStaged(
      ctx,
      entry,
      verb,
      verb === 'approve'
        ? `Approved staged ${entry.op} (${entry.gist}).`
        : `Rejected staged write '${entry.id}'.`,
    )
  }
  return { kind: 'error', text: MEMORY_USAGE }
}

/**
 * Execute `/refine` against the session's scope.
 * @param ctx - plugin context carrying the optional reviewer.
 * @param scope - scope identity resolved from the invoking session.
 * @param invocation - raw command input plus the caller's cancellation.
 * @returns the command result.
 */
async function executeRefine(
  ctx: Context,
  scope: EvolutionScopeIdBrand,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (splitArgs(invocation.rawInput).length > 0) return { kind: 'error', text: REFINE_USAGE }
  const reviewer = ctx.get('evolutionReviewer')
  if (reviewer === undefined) return { kind: 'error', text: 'The evolution reviewer is not mounted.' }
  try {
    await reviewer.rebuild(scope, invocation.signal)
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Memory rebuild cancelled.' }
    const failure = remoteErrorOf(error)
    if (failure === undefined) throw error
    return { kind: 'error', text: `Memory rebuild failed (${failure.code}): ${failure.message}.` }
  }
  return { kind: 'success', text: 'Memory rebuild complete.' }
}

/** Parsed `/journey export` arguments. */
interface JourneyExportArgs {
  readonly range: UsageRange
  readonly out: string | undefined
}

/**
 * Parse `/journey export`'s `[range] [--out <path>]` grammar.
 * @param args - split argument words, already confirmed to start with 'export'.
 * @returns the parsed options, or undefined for anything the grammar rejects.
 */
function parseJourneyExportArgs(args: readonly string[]): JourneyExportArgs | undefined {
  let out: string | undefined
  let index = 0
  let range: UsageRange = '7d'

  if (args.length > 0 && isUsageRange(args[0])) {
    range = args[0]
    index = 1
  }

  while (index < args.length) {
    const arg = args[index]
    if (arg === '--out') {
      const value = args[index + 1]
      if (out !== undefined || value === undefined || value.startsWith('--')) return undefined
      out = value
      index += 1
    } else {
      return undefined
    }
    index += 1
  }

  return { range, out }
}

/**
 * Default output path for journey exports: `$DSH_HOME/exports/journey-<scope>-<range>.zip`,
 * falling back to `.dsh/exports/` relative to the home directory.
 */
function defaultExportPath(scope: string, range: string): string {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh')
  const scopeDir = scope.replace(/[/\\:*?"<>|]/gu, '_')
  return join(home, 'exports', `journey-${scopeDir}-${range}.zip`)
}

/**
 * Execute `/journey export`: bundle the journey timeline plus the current
 * session log into a zip archive.
 * @param ctx - plugin context carrying the evolution memory store.
 * @param scope - scope identity resolved from the invoking session.
 * @param invocation - raw command input.
 * @param rangeArgs - post-'export' argument words.
 * @returns the command result.
 */
async function executeJourneyExport(
  ctx: Context,
  scope: EvolutionScopeIdBrand,
  invocation: CommandInvocation,
  rangeArgs: readonly string[],
): Promise<CommandResult> {
  const parsed = parseJourneyExportArgs(rangeArgs)
  if (parsed === undefined) return { kind: 'error', text: JOURNEY_EXPORT_USAGE }

  const range = parsed.range
  const usage = ctx.evolutionMemory.usage(scope)
  const timeline = scopeTimeline({
    record: ctx.evolutionMemory.read(scope),
    usedBytes: usage.usedBytes,
    capacityBytes: usage.capacityBytes,
    digest: ctx.evolutionMemory.digest(scope),
    range,
    now: Date.now(),
  })

  // ponytail: deprecated snapshotEvents, inline serializer when that is dropped
  const session = invocation.agent.session
  // eslint-disable-next-line typescript/no-deprecated -- one-shot export snapshot
  const events = session.snapshotEvents()
  const sessionLogText = serializeSessionLog(session.header, events)

  const zipBuffer = zipSync({
    'timeline.json': strToU8(JSON.stringify(timeline, null, 2)),
    'session-log.jsonl': strToU8(sessionLogText),
  })

  const outPath = parsed.out ?? defaultExportPath(scope, range)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, zipBuffer)

  return { kind: 'success', text: `Journey exported to ${outPath}` }
}

/**
 * Execute `/journey` against the session's scope.
 * @param ctx - plugin context carrying the evolution memory store.
 * @param scope - scope identity resolved from the invoking session.
 * @param invocation - raw command input.
 * @returns the command result.
 */
async function executeJourney(
  ctx: Context,
  scope: EvolutionScopeIdBrand,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const args = splitArgs(invocation.rawInput)
  if (args[0] === 'export') return executeJourneyExport(ctx, scope, invocation, args.slice(1))
  const range = args[0] ?? '7d'
  if (args.length > 1 || !isUsageRange(range)) return { kind: 'error', text: JOURNEY_USAGE }
  const usage = ctx.evolutionMemory.usage(scope)
  return {
    kind: 'success',
    text: renderTimeline(scopeTimeline({
      record: ctx.evolutionMemory.read(scope),
      usedBytes: usage.usedBytes,
      capacityBytes: usage.capacityBytes,
      digest: ctx.evolutionMemory.digest(scope),
      range,
      now: Date.now(),
    })),
  }
}

/**
 * Execute `/skills` against the session's scope: the skill-kind half of staged
 * governance. Approving drops an entry whose skill write already happened
 * through `skill_manage`. A bare invocation reports the pending list, as
 * `/memory` does.
 * @param ctx - plugin context carrying the evolution memory store.
 * @param scope - scope identity resolved from the invoking session.
 * @param invocation - raw command input.
 * @returns the command result.
 */
async function executeSkills(
  ctx: Context,
  scope: EvolutionScopeIdBrand,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const [verb, id, ...rest] = splitArgs(invocation.rawInput)
  const staged = (ctx.evolutionMemory.read(scope)?.staged ?? []).filter(entry => entry.kind === 'skill')
  if ((verb === undefined || verb === 'pending') && id === undefined && rest.length === 0) {
    return { kind: 'success', text: staged.length === 0 ? SKILLS_EMPTY : formatStagedList(staged, 'skill proposal') }
  }
  if (verb === 'approve' && id !== undefined && rest.length === 0) {
    const entry = staged.find(candidate => candidate.id === id)
    if (entry === undefined) return { kind: 'error', text: `No staged skill '${id}'.` }
    return await mutateStaged(
      ctx,
      entry,
      'approve',
      `Approved staged skill ${entry.op} (${entry.gist}). The skill file itself is written by skill_manage; approve only after that write landed.`,
    )
  }
  return { kind: 'error', text: SKILLS_USAGE }
}

/** One trajectory export outcome as the trajectory service reports it. */
interface TrajectoryExportResult {
  readonly path: string
  readonly conversations: number
  readonly bytes: number
}

/** The optional trajectory service, resolved dynamically at call time. */
interface TrajectoryExporter {
  exportSession(sessionId: string, options?: { out?: string }): Promise<TrajectoryExportResult>
  exportScope(scopeId: string, options?: { out?: string }): Promise<TrajectoryExportResult>
}

/** Parsed `/trajectory` arguments. */
interface TrajectoryArgs {
  readonly out: string | undefined
  readonly all: boolean
}

/**
 * Parse `/trajectory`'s `[--out <path>] [--all]` grammar.
 * @param args - split argument words.
 * @returns the parsed options, or undefined for anything the grammar rejects.
 */
function parseTrajectoryArgs(args: readonly string[]): TrajectoryArgs | undefined {
  let out: string | undefined
  let all = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--all') {
      if (all) return undefined
      all = true
    } else if (arg === '--out') {
      const value = args[index + 1]
      if (out !== undefined || value === undefined || value.startsWith('--')) return undefined
      out = value
      index += 1
    } else {
      return undefined
    }
  }
  return { out, all }
}

/**
 * Run one trajectory export and render its outcome, mapping documented service
 * failures onto stable host text so a rejected export never looks like a write.
 * @param run - the export call.
 * @returns the command result.
 */
async function runTrajectoryExport(run: () => Promise<TrajectoryExportResult>): Promise<CommandResult> {
  try {
    const result = await run()
    return {
      kind: 'success',
      text: `Trajectory written to ${result.path} (${result.conversations} conversation${result.conversations === 1 ? '' : 's'}, ${result.bytes} bytes).`,
    }
  } catch (error) {
    const failure = remoteErrorOf(error)
    if (failure === undefined) throw error
    return { kind: 'error', text: `Trajectory export failed (${failure.code}): ${failure.message}.` }
  }
}

/**
 * Execute `/trajectory`: export the invoking session, or every scope session
 * with `--all`, through the trajectory service.
 * @param ctx - plugin context carrying the optional trajectory service.
 * @param profile - configured scope namespace.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeTrajectory(
  ctx: Context,
  profile: string,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const args = parseTrajectoryArgs(splitArgs(invocation.rawInput))
  if (args === undefined) return { kind: 'error', text: TRAJECTORY_USAGE }
  const exporter = ctx.get('evolutionTrajectory') as TrajectoryExporter | undefined
  if (exporter === undefined) return { kind: 'error', text: 'The evolution trajectory exporter is not mounted.' }
  const options = args.out === undefined ? {} : { out: args.out }
  if (!args.all) return await runTrajectoryExport(() => exporter.exportSession(invocation.agent.session.id, options))
  const membership = await resolveMembership(ctx, invocation.agent.session)
  if (membership === undefined) return { kind: 'error', text: 'This session is outside any workspace scope.' }
  const scope = EvolutionScopeId(profile, String(membership.id))
  return await runTrajectoryExport(() => exporter.exportScope(scope, options))
}

/**
 * Build the research-and-save prompt behind `/learn`.
 * @param topic - everything the human typed after the command name.
 * @returns the prompt delivered as one ordinary turn.
 */
export function buildLearnPrompt(topic: string): string {
  return [
    `Learn this and save it as a skill: ${topic}`,
    '',
    'Gather the material with the tools you already have: read and search the workspace, and fetch the web sources that are reachable.',
    'Then write exactly one skill through skill_manage. That write is proposal-gated: describe what the skill will contain and never claim it exists until the write lands.',
    "Keep the skill lean — a routing description, when-to-use guidance, and the steps — and move long material into the skill's references/ files.",
  ].join('\n')
}

/**
 * Execute `/learn`: queue the prompt-builder's output as one ordinary turn.
 * The command writes nothing itself; the gated `skill_manage` write is the
 * only save path the prompt offers.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
function executeLearn(invocation: CommandInvocation): CommandResult {
  const topic = invocation.rawInput.trim()
  if (topic.length === 0) return { kind: 'error', text: LEARN_USAGE }
  invocation.agent.followup(createUserMessage({
    content: [{ type: 'text', text: buildLearnPrompt(topic) }],
    source: { kind: 'plugin', plugin: 'command-evolution' },
  }))
  return {
    kind: 'success',
    text: `Started a learning turn for '${topic}'. The skill lands only through the gated skill_manage write.`,
  }
}

/** The catalog surface `/suggestions` reads, resolved dynamically at call time. */
interface SkillCatalog {
  list(options: { cwd?: string; signal?: AbortSignal }): Promise<readonly SkillCatalogEntry[]>
  get(name: string, options: { cwd?: string; signal?: AbortSignal }): Promise<SkillCatalogEntry | undefined>
}

/** The skill fields `/suggestions` reads; the blueprint may sit on either surface. */
interface SkillCatalogEntry {
  readonly name: string
  readonly description: string
  readonly blueprint?: unknown
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * Read one skill's blueprint from whichever surface discovery published: the
 * parsed field, or the frontmatter bag it was parsed from.
 * @param skill - loaded skill definition.
 * @returns the accepted blueprint, or undefined when absent or malformed.
 */
function blueprintOf(skill: SkillCatalogEntry): SkillBlueprint | undefined {
  const value = skill.blueprint ?? skill.metadata?.blueprint
  if (typeof value !== 'object' || value === null) return undefined
  const { schedule, deliver, prompt } = value as Record<string, unknown>
  if (typeof schedule !== 'string' || typeof prompt !== 'string') return undefined
  if (deliver !== 'session' && deliver !== 'file') return undefined
  return { schedule, deliver, prompt }
}

/**
 * Execute `/suggestions`: list the blueprint-backed skills a human may choose
 * to schedule. Nothing is installed here — the schedule a blueprint names is a
 * suggestion, and installing it stays a separate, deliberate act.
 * @param ctx - plugin context carrying the optional skill registry.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeSuggestions(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  if (splitArgs(invocation.rawInput).length > 0) return { kind: 'error', text: SUGGESTIONS_USAGE }
  const catalog = ctx.get('skills') as SkillCatalog | undefined
  if (catalog === undefined) return { kind: 'error', text: 'The skill registry is not mounted.' }
  const cwd = invocation.agent.session.header.cwd
  const options = cwd === undefined ? { signal: invocation.signal } : { cwd, signal: invocation.signal }
  const suggested: { name: string; description: string; blueprint: SkillBlueprint }[] = []
  for (const summary of await catalog.list(options)) {
    const skill = await catalog.get(summary.name, options)
    if (skill === undefined) continue
    const blueprint = blueprintOf(skill)
    if (blueprint === undefined) continue
    suggested.push({ name: summary.name, description: summary.description, blueprint })
  }
  if (suggested.length === 0) return { kind: 'success', text: SUGGESTIONS_EMPTY }
  return {
    kind: 'success',
    text: [
      `${suggested.length} suggested skill${suggested.length === 1 ? '' : 's'}:`,
      ...suggested.map(skill => `- ${skill.name}: ${skill.description} (schedule ${skill.blueprint.schedule}, deliver ${skill.blueprint.deliver})`),
      'Suggested only: this command installs no schedule; register the one a skill names when you trust it.',
    ].join('\n'),
  }
}

/**
 * Execute `/curator`: dispatch to the handler for each sub-verb. Pin and
 * unpin only need telemetry; every other verb requires the curator.
 * @param ctx - plugin context carrying the optional curator and telemetry.
 * @param invocation - raw command input.
 * @returns the command result.
 */
async function executeCurator(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const args = splitArgs(invocation.rawInput)
  const verb = args[0]
  const rest = args.slice(1)
  if (verb === undefined) return { kind: 'error', text: CURATOR_USAGE }

  // Pin/unpin only need telemetry, not the curator.
  if (verb === 'pin' || verb === 'unpin') {
    if (rest.length !== 1) return { kind: 'error', text: CURATOR_USAGE }
    const telemetry = ctx.get('evolutionSkillTelemetry')
    if (telemetry === undefined) return { kind: 'error', text: 'Skill telemetry is not mounted. Pin/unpin requires the telemetry store.' }
    return verb === 'pin' ? executeCuratorPin(telemetry, rest[0]!) : executeCuratorUnpin(telemetry, rest[0]!)
  }

  // Validate args for every curator verb before resolving the curator so
  // malformed invocations report usage even when the curator is absent.
  switch (verb) {
    case 'status': if (rest.length > 0) return { kind: 'error', text: CURATOR_USAGE }; break
    case 'run': if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--dry-run')) return { kind: 'error', text: CURATOR_USAGE }; break
    case 'adopt': if (rest.length !== 1) return { kind: 'error', text: CURATOR_USAGE }; break
    case 'purge': if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--dry-run')) return { kind: 'error', text: CURATOR_USAGE }; break
    case 'rollback': if (rest.length !== 2 || rest[0] !== '--id') return { kind: 'error', text: CURATOR_USAGE }; break
    case 'ledger': if (rest.length > 0) return { kind: 'error', text: CURATOR_USAGE }; break
    default: return { kind: 'error', text: CURATOR_USAGE }
  }

  const curator = ctx.get('evolutionCurator')
  if (curator === undefined) return { kind: 'error', text: 'The evolution curator is not mounted.' }

  switch (verb) {
    case 'status': return executeCuratorStatus(ctx, curator)
    case 'run': return runCuratorPass(curator, rest[0] === '--dry-run')
    case 'adopt': return executeCuratorAdopt(curator, rest[0]!)
    case 'purge': return executeCuratorPurge(curator, rest[0] === '--dry-run')
    case 'rollback': return executeCuratorRollback(curator, rest[1]!)
    case 'ledger': return executeCuratorLedger(curator)
    default: return { kind: 'error', text: CURATOR_USAGE }
  }
}

/**
 * Execute `/curator status`: bookkeeping and tracked-skill counts.
 * @param ctx - plugin context carrying the optional telemetry.
 * @param curator - the mounted curator service.
 * @returns the command result.
 */
async function executeCuratorStatus(ctx: Context, curator: EvolutionCurator): Promise<CommandResult> {
  const telemetry = ctx.get('evolutionSkillTelemetry')
  const entries = telemetry?.entries() ?? []
  const state = (lifecycle: 'active' | 'stale' | 'archived'): number =>
    entries.filter(entry => entry.usage.state === lifecycle).length
  const passes = await curator.passes()
  const newest = passes[0]
  const lines = [
    `Curator: last pass ${curator.lastRunAt() ?? 'never'}`,
    telemetry === undefined
      ? 'Tracked skills: unavailable (skill telemetry is not mounted).'
      : `Tracked skills: ${entries.length} (active ${state('active')}, stale ${state('stale')}, archived ${state('archived')}, pinned ${entries.filter(entry => entry.usage.pinned).length})`,
    newest === undefined
      ? 'Recorded passes: 0'
      : `Recorded passes: ${passes.length} · newest ${newest.passId} at ${newest.at} (${newest.transitions} transition${newest.transitions === 1 ? '' : 's'})`,
  ]
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Run one curator pass and render its report.
 * @param curator - the mounted curator service.
 * @param dryRun - whether to preview the pass without writing.
 * @returns the command result.
 */
async function runCuratorPass(curator: EvolutionCurator, dryRun: boolean): Promise<CommandResult> {
  const report = await curator.run({ dryRun })
  const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
  return {
    kind: 'success',
    text: [
      report.dryRun
        ? `Curator pass previewed at ${report.at}: ${plural(report.scanned, 'tracked skill')}, ${plural(report.transitions.length, 'transition')} (no writes)`
        : `Curator pass complete at ${report.at}: ${plural(report.scanned, 'tracked skill')}, ${plural(report.transitions.length, 'transition')}`,
      ...report.transitions.map(transition => `- ${transition.name}: ${transition.from} → ${transition.to}`),
      `Skipped: ${report.skippedPinned} pinned, ${report.skippedProtected} protected, ${report.skippedExcluded} bundled or hub`,
      report.passId === null ? 'Snapshot: none' : `Snapshot: ${report.passId}`,
    ].join('\n'),
  }
}

/**
 * Execute `/curator adopt <name>`: adopt one agent-created skill into
 * user-directed standing.
 * @param curator - the mounted curator service.
 * @param rest - argument words after the verb.
 * @returns the command result.
 */
async function executeCuratorAdopt(curator: EvolutionCurator, name: string): Promise<CommandResult> {
  try {
    const record = await curator.adopt(name)
    return { kind: 'success', text: `Adopted '${name}' (state: ${record.state})` }
  } catch (err: unknown) {
    return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Execute `/curator purge [--dry-run]`: purge archived skills past their TTL.
 * @param curator - the mounted curator service.
 * @param rest - argument words after the verb.
 * @returns the command result.
 */
async function executeCuratorPurge(curator: EvolutionCurator, dryRun: boolean): Promise<CommandResult> {
  const report: PurgeReport = await curator.purge({ dryRun })
  const header = report.dryRun
    ? `Purge previewed at ${report.at}: ${report.purged.length} skill${report.purged.length === 1 ? '' : 's'}, ${report.skippedPinned} skipped (pinned), no writes`
    : `Purge complete at ${report.at}: ${report.purged.length} skill${report.purged.length === 1 ? '' : 's'} removed, ${report.skippedPinned} skipped (pinned)`
  const lines = [header, ...report.purged.map(p => `- ${p.name}${p.dir !== null ? ` (${p.dir})` : ''}`)]
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Execute `/curator rollback --id <id>`: roll back one recorded pass or ledger
 * entry. Prefers pass-level rollback.
 * @param curator - the mounted curator service.
 * @param rest - argument words after the verb.
 * @returns the command result.
 */
async function executeCuratorRollback(curator: EvolutionCurator, id: string): Promise<CommandResult> {
  try {
    const report: RollbackReport = await curator.rollbackPass(id)
    return {
      kind: 'success',
      text: [
        `Rolled back ${report.label} at ${report.at}: ${report.restored.length} skill${report.restored.length === 1 ? '' : 's'} restored`,
        ...report.restored.map(r => `- ${r.name}: ${r.from} → ${r.to}`),
      ].join('\n'),
    }
  } catch (err: unknown) {
    return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Execute `/curator ledger`: list recorded passes newest-first.
 * @param curator - the mounted curator service.
 * @param rest - unused argument words.
 * @returns the command result.
 */
async function executeCuratorLedger(curator: EvolutionCurator): Promise<CommandResult> {
  const passes: PassSummary[] = await curator.passes()
  if (passes.length === 0) return { kind: 'success', text: 'No recorded passes.' }
  const lines = passes.map(p =>
    `- ${p.passId} at ${p.at}: ${p.transitions} transition${p.transitions === 1 ? '' : 's'}`,
  )
  return { kind: 'success', text: [`${passes.length} pass${passes.length === 1 ? '' : 'es'}:`, ...lines].join('\n') }
}

/**
 * Execute `/curator pin <name>`: pin a tracked skill.
 * @param telemetry - the mounted telemetry service.
 * @param rest - argument words after the verb.
 * @returns the command result.
 */
async function executeCuratorPin(telemetry: { setPinned(name: string, pinned: boolean): Promise<SkillUsageRecord> }, name: string): Promise<CommandResult> {
  try {
    await telemetry.setPinned(name, true)
    return { kind: 'success', text: `Pinned '${name}'` }
  } catch (err: unknown) {
    return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Execute `/curator unpin <name>`: unpin a tracked skill.
 * @param telemetry - the mounted telemetry service.
 * @param rest - argument words after the verb.
 * @returns the command result.
 */
async function executeCuratorUnpin(telemetry: { setPinned(name: string, pinned: boolean): Promise<SkillUsageRecord> }, name: string): Promise<CommandResult> {
  try {
    await telemetry.setPinned(name, false)
    return { kind: 'success', text: `Unpinned '${name}'` }
  } catch (err: unknown) {
    return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Resolve the invocation's scope and run one scoped evolution command.
 * @param ctx - plugin context carrying the registry and the store.
 * @param profile - configured scope namespace.
 * @param kind - command to run.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function handleCommand(
  ctx: Context,
  profile: string,
  kind: 'memory' | 'refine' | 'journey' | 'skills' | 'trajectory',
  invocation: CommandInvocation,
): Promise<CommandResult> {
  // Exporting the invoking session needs no workspace, so `/trajectory`
  // decides for itself whether it must resolve one.
  if (kind === 'trajectory') return executeTrajectory(ctx, profile, invocation)
  const membership = await resolveMembership(ctx, invocation.agent.session)
  if (membership === undefined) return { kind: 'error', text: 'This session is outside any workspace scope.' }
  const scope = EvolutionScopeId(profile, String(membership.id))
  switch (kind) {
    case 'memory':
      return executeMemory(ctx, scope, invocation)
    case 'refine':
      return executeRefine(ctx, scope, invocation)
    case 'journey':
      return executeJourney(ctx, scope, invocation)
    case 'skills':
      return executeSkills(ctx, scope, invocation)
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(kind, 'command-evolution command kind')
  }
}

/**
 * Register every evolution command for the composed human-command adapters.
 * @param ctx - context carrying the command registry and the evolution seams.
 * @param config - scope namespace choices.
 */
export function apply(ctx: Context, config: Config): void {
  const profile = config.profile
  checkProfile(profile)
  /* jscpd:ignore-start -- the command-lifecycle drain deliberately parallels dsh-command-compact */
  const active = new Set<Promise<CommandResult>>()
  const track = (operation: Promise<CommandResult>): Promise<CommandResult> => {
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }
  /* jscpd:ignore-end */

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/memory'),
      name: 'memory',
      description: 'Review staged evolution memory writes',
      input: { hint: 'pending | approve <id> | reject <id>' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'memory', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/refine'),
      name: 'refine',
      description: 'Rebuild evolution lessons from session history',
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'refine', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/journey'),
      name: 'journey',
      description: 'Show or export this scope\'s recorded evolution activity',
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'journey', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/skills'),
      name: 'skills',
      description: 'Review staged skill proposals',
      input: { hint: 'pending | approve <id>' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'skills', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/curator'),
      name: 'curator',
      description: 'Manage skill curation: status, pass history, adopt, purge, pin, and rollback',
      input: { hint: 'status | run | adopt <name> | purge | rollback | ledger | pin <name>' },
      handler: (invocation: CommandInvocation) => track(executeCurator(ctx, invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/trajectory'),
      name: 'trajectory',
      description: 'Export this session or this scope as share-ready conversations',
      input: { hint: '[--out <path>] [--all]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'trajectory', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/learn'),
      name: 'learn',
      description: 'Research a topic and save it as a skill through the gated writer',
      input: { hint: 'What should the harness learn?' },
      handler: (invocation: CommandInvocation) => track(Promise.resolve(executeLearn(invocation))),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/suggestions'),
      name: 'suggestions',
      description: 'List blueprint-backed skills without scheduling them',
      handler: (invocation: CommandInvocation) => track(executeSuggestions(ctx, invocation)),
    })
  }, 'command-evolution lifecycle')
}

