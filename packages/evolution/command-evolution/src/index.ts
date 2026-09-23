/**
 * Human-facing evolution commands over the evolution seams: staged-write
 * governance (`/memory`, `/skills`), on-demand lessons rebuilds (`/refine`),
 * the scope's recorded activity (`/journey`), curation status (`/curator`),
 * session export (`/trajectory`), a research-and-save turn (`/learn`),
 * blueprint-backed skill suggestions (`/suggestions`), and the reporting
 * commands that read what the engine measured — traces (`/trace`),
 * the scope graph (`/graph`) and its claims (`/claims`), stored failure
 * reflections (`/reflection`),
 * benchmarks (`/benchmark`), curricula (`/curriculum`), evaluator health
 * (`/evaluators`), populations (`/population`), routes (`/routes`), rollouts
 * (`/canary`), novelty (`/novelty`), stagnation (`/stagnation`), islands
 * (`/islands`), self-models (`/selfmodel`), uncertainty (`/uncertainty`),
 * adversarial probes (`/adversary`), lineage (`/lineage`), sleep-time plans
 * (`/sleeptime`), budgets (`/budget`), engine configurations (`/meta`),
 * operators (`/operators`), routing evidence (`/router`), evaluator
 * strategy (`/evaluator-strategy`), and the capability-per-compute metrics
 * (`/metrics`). Every command but `/learn` answers
 * directly from the seams it reads; `/learn` builds a prompt and queues it as
 * one ordinary turn.
 * @module @deepseek-ai/dsh-command-evolution
 */

import { randomUUID } from 'node:crypto'
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
import type {} from '@deepseek-ai/dsh-evolution-graph'
import type {} from '@deepseek-ai/dsh-evolution-memory'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type {} from '@deepseek-ai/dsh-evolution-dreaming'
import type { EvolutionScopeId as EvolutionScopeIdBrand, LessonArtifact, StagedWrite } from '@deepseek-ai/dsh-evolution-memory'
import type {} from '@deepseek-ai/dsh-evolution-reviewer'
import type {} from '@deepseek-ai/dsh-evolution-curator'
import type { EvolutionCurator, PassSummary, PurgeReport, RollbackReport } from '@deepseek-ai/dsh-evolution-curator'
import type { EvolutionOptimizer, ExperimentRecord, OptimizeReport } from '@deepseek-ai/dsh-evolution-optimizer'
import { rankFrontier } from './frontier.ts'
import type { FrontierInput } from './frontier.ts'
import type {} from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { SkillLifecycleState, SkillUsageRecord, SkillVersion } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { SkillBlueprint } from '@deepseek-ai/dsh-skill'
import { isUsageRange, type UsageRange } from '@deepseek-ai/dsh-usage-ledger'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import { strToU8, zipSync } from 'fflate'
import { renderTimeline, scopeTimeline } from './journey.ts'
import type { TraceRecord } from '@deepseek-ai/dsh-evolution-trace'
import type { CurriculumGap, CurriculumProposal } from '@deepseek-ai/dsh-evolution-curriculum'
import { nextLadder } from '@deepseek-ai/dsh-evolution-benchmark'
import type { BenchmarkInput, BenchmarkState, BenchmarkTask } from '@deepseek-ai/dsh-evolution-benchmark'
import type { EvaluatorHealthSummary, EvaluatorRun } from '@deepseek-ai/dsh-evolution-evaluator-health'
import type { PopulationCandidate, PopulationStatus } from '@deepseek-ai/dsh-evolution-population'
import type { NoveltyArchiveEntry } from '@deepseek-ai/dsh-evolution-novelty-search'
import type { StagnationRun, StagnationStatus } from '@deepseek-ai/dsh-evolution-stagnation'
import { ISLAND_OBJECTIVES } from '@deepseek-ai/dsh-evolution-islands'
import type {} from '@deepseek-ai/dsh-evolution-self-model'
import type {} from '@deepseek-ai/dsh-evolution-uncertainty'
import { ADVERSARIAL_CATEGORIES, GAMING_DEFENSES } from '@deepseek-ai/dsh-evolution-adversary'
import type {} from '@deepseek-ai/dsh-evolution-lineage'
import type {
  Island,
  IslandInput,
  IslandObjective,
  IslandSchedule,
  Migration,
  MigrationInput,
  MigrationReason,
} from '@deepseek-ai/dsh-evolution-islands'
import { EVOLUTION_ROLES } from '@deepseek-ai/dsh-evolution-model-routes'
import type { DutyDecision, DutyInput, DutyRecord, DutyVerdict, EvolutionRole, ModelRoute, RouteEvidence, RouteRow, RouteSummary } from '@deepseek-ai/dsh-evolution-model-routes'
import { nextStage } from '@deepseek-ai/dsh-evolution-canary'
import type { DeploymentRecord, DeploymentState } from '@deepseek-ai/dsh-evolution-canary'
import { settle } from '@deepseek-ai/dsh-evolution-budget'
import type { BudgetAllocation, BudgetSettlement, SpendRecord } from '@deepseek-ai/dsh-evolution-budget'
import type { ConfigRecommendation, ConfigSummary, EngineRun } from '@deepseek-ai/dsh-evolution-meta'
import type { MetricUnit, MetricValue } from '@deepseek-ai/dsh-evolution-metrics'
import type { OperatorRanking, OperatorStats } from '@deepseek-ai/dsh-evolution-operators'
import type { RouteEffectiveness, RouteRankingEntry, RoutingRole } from '@deepseek-ai/dsh-evolution-router'
import { ROUTING_ROLES } from '@deepseek-ai/dsh-evolution-router'
import type { EvaluatorStrategy, StrategyRanking } from '@deepseek-ai/dsh-evolution-evaluator-strategy'

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

/** Argument grammar for `/graph`; anything else reports usage. */
const GRAPH_USAGE = 'Usage: /graph <entity> [relation]'

/** Argument grammar for `/claims`; anything else reports usage. */
const CLAIMS_USAGE = 'Usage: /claims [query]'

/** Argument grammar for `/reflection`; anything else reports usage. */
const REFLECTION_USAGE = 'Usage: /reflection [limit]'

/** How many reflections `/reflection` lists when the caller names no limit. */
const DEFAULT_REFLECTION_LIMIT = 5

/** Usage line shown when `/dream` is given arguments it does not accept. */
const DREAM_USAGE = 'Usage: /dream [light|rem|deep]'

/**
 * Split `/graph` arguments, keeping a double-quoted run together so a
 * multi-word entity can be named: `"Project X" worked_on` yields two
 * arguments. An unterminated quote stays literal, so it resolves as an
 * unknown entity rather than silently dropping part of the name.
 * @param raw - the raw command input after the command name.
 * @returns the argument tokens.
 */
function graphArgs(raw: string): string[] {
  const tokens = raw.match(/"[^"]*"|\S+/g) ?? []
  return tokens.map(token => token.length > 1 && token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1)
    : token)
}

/** Argument grammar for `/curator`; anything else reports usage. */
const CURATOR_USAGE = 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]'

/** Argument grammar for `/trajectory`; anything else reports usage. */
const TRAJECTORY_USAGE = 'Usage: /trajectory [--out <path>] [--all]'

/** Argument grammar for `/trace`; anything else reports usage. */
const TRACE_USAGE = 'Usage: /trace <sessionId>'

/** Argument grammar for `/curriculum`; anything else reports usage. */
const CURRICULUM_USAGE = 'Usage: /curriculum [retire <id>]'

/** Argument grammar for `/benchmark`; anything else reports usage. */
const BENCHMARK_USAGE = 'Usage: /benchmark [admit | promote <id> [state] | retire <id>]'

/** Argument grammar for `/evaluators`; anything else reports usage. */
const EVALUATORS_USAGE = 'Usage: /evaluators [runs [<skill>]]'

/** Argument grammar for `/population`; anything else reports usage. */
const POPULATION_USAGE = 'Usage: /population <skill> [lineage <id> | approve <id> | reject <id>]'

/** Argument grammar for `/routes`; anything else reports usage. */
const ROUTES_USAGE = 'Usage: /routes [pin <role> <provider> <model> | evidence [<role>]]'

/** Argument grammar for `/canary`; anything else reports usage. */
const CANARY_USAGE = 'Usage: /canary [status [<skill>] | rollout <id> | promote <id> | reject <id> | rollback <id>]'

/** Argument grammar for `/novelty`; anything else reports usage. */
const NOVELTY_USAGE = 'Usage: /novelty [<skill>]'

/** Argument grammar for `/stagnation`; anything else reports usage. */
const STAGNATION_USAGE = 'Usage: /stagnation [status <skill> | runs [<skill>] | reset <skill>]'

/** Argument grammar for `/islands`; anything else reports usage. */
const ISLANDS_USAGE = 'Usage: /islands [list [<skill>] | register <island> <name> <objective> <skill> | migrate <from> <to> <candidate> [<reason>] | migrations [<skill>]]'

/** Argument grammar for `/selfmodel`; anything else reports usage. */
const SELF_MODEL_USAGE = 'Usage: /selfmodel [<skill>]'

/** Argument grammar for `/uncertainty`; anything else reports usage. */
const UNCERTAINTY_USAGE = 'Usage: /uncertainty [<skill>]'

/** Argument grammar for `/adversary`; anything else reports usage. */
const ADVERSARY_USAGE = 'Usage: /adversary [list [<skill>] | probe <skill> <category> <probe> | repair <probeId> | challenge <skill> | defenses | defense <name> <satisfied>]'

/** Argument grammar for `/lineage`; anything else reports usage. */
const LINEAGE_USAGE = 'Usage: /lineage [list [<skill>] | compare <idA> <idB> | replay <id>]'

/** Argument grammar for `/sleeptime`; anything else reports usage. */
const SLEEPTIME_USAGE = 'Usage: /sleeptime [tasks [<domain>] | artifacts [<taskId>] | plan]'

/** Argument grammar for `/budget`; anything else reports usage. */
const BUDGET_USAGE = 'Usage: /budget [spends [<batchId>]]'

/** Argument grammar for `/metrics`; anything else reports usage. */
const METRICS_USAGE = 'Usage: /metrics [<taskClass>]'

/** Argument grammar for `/meta`; anything else reports usage. */
const META_USAGE = 'Usage: /meta [summaries [<taskClass>] | runs [<taskClass>] | recommend <taskClass>]'

/** Argument grammar for `/operators`; anything else reports usage. */
const OPERATORS_USAGE = 'Usage: /operators <artifactClass>'

/** Argument grammar for `/router`; anything else reports usage. */
const ROUTER_USAGE = 'Usage: /router [effectiveness [<taskClass>] [<role>] | recommend <taskClass> <role>]'

/** Argument grammar for `/evaluator-strategy`; anything else reports usage. */
const EVALUATOR_STRATEGY_USAGE = 'Usage: /evaluator-strategy [strategies [<taskClass>] | rank <taskClass>]'

/** Argument grammar for `/learn`; a bare call reports usage. */
const LEARN_USAGE = 'Usage: /learn <anything>'

/** Argument grammar for `/suggestions`; the command takes no arguments. */
const SUGGESTIONS_USAGE = 'Usage: /suggestions (no arguments)'

/** Argument grammar for `/frontier`; the command takes no arguments. */
const FRONTIER_USAGE = 'Usage: /frontier (no arguments)'

/** The feedback surface `/frontier` reads, resolved dynamically at call time. */
interface FrontierFeedback {
  signals(sessionIds: readonly string[], limit: number): readonly { message: string }[]
}

/** The feedback surface `/reflection` reads, resolved dynamically at call time. */
interface ReflectionFeedback {
  reflections(sessionIds: readonly string[], limit: number): Promise<readonly ReflectionRow[]>
}

/** One stored reflection as `/reflection` renders it. */
interface ReflectionRow {
  symptom: string
  violatedExpectation: string
  rootCause: string | null
  correctedStrategy: string | null
  antiPattern: string | null
  reusableWhen: string | null
  candidateTest: string | null
  confidence: number
}

/** Self-model assessment shape `/selfmodel` reads when the store is mounted. */
interface SelfModelAssessment {
  strengths: readonly string[]
  weaknesses: readonly string[]
  uncertainAreas: readonly string[]
  failureModes: readonly string[]
  preferredTools: readonly string[]
  evaluatorBlindspots: readonly string[]
  confidence: number
  revision: number
  at: string
}

/** Capability frontier row `/selfmodel` renders. */
interface SelfModelGap {
  capability: string
  score: number
  confidence: number
  coveringSkills: readonly string[]
  observations: number
}

/** Prioritized evaluation task `/uncertainty` renders. */
interface UncertaintyQueueRow {
  skill: string
  taskId: string | null
  kinds: readonly string[]
  priority: number
  signals: number
}

/** Adversarial probe row `/adversary` renders. */
interface AdversaryProbeRow {
  probeId: string
  skill: string
  category: string
  probe: string
  foundWeakness: boolean
  repaired: boolean
}

/** Adversary challenge `/adversary` renders. */
interface AdversaryChallengeRow {
  category: string
  probed: number
  reason: string
}

/** Defense checklist row `/adversary` renders. */
interface AdversaryDefenseRow {
  defense: string
  satisfied: boolean
}

/** Measured triple one lineage envelope reports. */
interface LineageMetrics {
  pass: boolean
  tokens: number
  wallTimeMs: number
}

/** Lineage envelope rows `/lineage` reads and renders. */
interface LineageEnvelopeRow {
  experimentId: string
  skill: string
  operator?: string
  outcome: string
  metrics: LineageMetrics
  dependencies: Record<string, string>
  seeds: readonly number[]
}

/** Anticipated sleep-time task `/sleeptime` renders. */
interface SleeptimeTaskRow {
  taskId: string
  domain: string
  likelihood: number
  expectedQueries: number
  expectedSavingTokens: number
}

/** Precomputed sleep-time artifact `/sleeptime` renders. */
interface SleeptimeArtifactRow {
  artifactId: string
  taskId: string
  kind: string
  summary: string
  offlineCostTokens: number
  hits: number
  savedTokens: number
}

/** Sleep-time plan row `/sleeptime` renders. */
interface SleeptimePlanRow {
  taskId: string
  domain: string
  worthIt: boolean
  expectedNet: number
  reason: string
}

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
 * Narrow a JSON value to an object, or undefined for any other shape.
 * @param value - the value to narrow.
 * @returns the object, or undefined.
 */
function objectOf(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * Read one named string field of a JSON value.
 * @param value - the value to read from.
 * @param key - the field name.
 * @returns the field's text, or undefined when absent or not a string.
 */
function stringFieldOf(value: JsonValue | undefined, key: string): string | undefined {
  const field = objectOf(value)?.[key]
  return typeof field === 'string' ? field : undefined
}

/**
 * Render one decision of an `applyDecisions` batch: the fact it upholds, the
 * correction it makes, or the fact it adds.
 * @param raw - one element of the payload's `decisions` array.
 * @param lessons - the scope's current artifacts, for a contradiction's old text.
 * @returns the detail text, or undefined for an element this renderer cannot read.
 */
function decisionDetail(raw: JsonValue, lessons: readonly LessonArtifact[]): string | undefined {
  const decision = objectOf(raw)
  if (decision === undefined) return undefined
  if (decision['kind'] === 'new') {
    const statement = stringFieldOf(decision['candidate'], 'statement')
    return statement === undefined ? undefined : `new '${statement}'`
  }
  const artifactId = stringFieldOf(decision, 'artifactId')
  if (artifactId === undefined) return undefined
  // A decision addresses an artifact by id, which stops equaling its statement
  // once a contradiction corrects it, so the current statement is what the
  // reviewer needs to see. An id the record no longer holds reads as itself: a
  // pruned target stays named rather than dropping out of the list.
  const referred = lessons.find(lesson => lesson.id === artifactId)?.statement ?? artifactId
  if (decision['kind'] === 'confirms') return `confirms '${referred}'`
  if (decision['kind'] !== 'contradicts') return undefined
  // A contradiction with no replacement text only bumps the refutation count,
  // so the contested fact is the whole story.
  const replacement = stringFieldOf(decision, 'statement')
  return replacement === undefined ? `contradicts '${referred}'` : `contradicts '${referred}' → '${replacement}'`
}

/**
 * Render the per-decision detail of a staged `applyDecisions` entry. The
 * payload is unvalidated JSON, so anything this renderer cannot read renders no
 * line rather than failing `/memory pending`.
 * @param entry - staged entry from the scope record.
 * @param lessons - the scope's current artifacts.
 * @returns one indented line per recognizable decision, empty for every other op.
 */
function decisionLines(entry: StagedWrite, lessons: readonly LessonArtifact[]): string[] {
  if (entry.op !== 'applyDecisions') return []
  const decisions = objectOf(entry.payload)?.['decisions']
  if (!Array.isArray(decisions)) return []
  const lines: string[] = []
  for (const decision of decisions) {
    const detail = decisionDetail(decision, lessons)
    if (detail !== undefined) lines.push(`  ${detail}`)
  }
  return lines
}

/**
 * Render one staged entry as a stable single line, followed by one indented
 * line per decision when the entry carries an `applyDecisions` batch.
 * @param entry - staged entry from the scope record.
 * @param lessons - the scope's current artifacts, for a contradiction's old text.
 * @returns the pending-list line naming id, kind, op, gist, origin, and instant.
 */
function formatPendingLine(entry: StagedWrite, lessons: readonly LessonArtifact[]): string {
  const line = `- ${entry.id} [${entry.kind}:${entry.op}] ${entry.gist} (session '${entry.originSessionId}', ${entry.createdAt})`
  return [line, ...decisionLines(entry, lessons)].join('\n')
}

/**
 * Render a staged-entry list, honestly empty when nothing awaits a decision.
 * @param staged - staged entries in record order.
 * @param noun - singular noun naming what the entries are.
 * @param lessons - the scope's current artifacts; a skill proposal resolves against none.
 * @returns the command text.
 */
function formatStagedList(staged: readonly StagedWrite[], noun: string, lessons: readonly LessonArtifact[]): string {
  if (staged.length === 0) return `No pending ${noun}s.`
  const header = staged.length === 1 ? `1 pending ${noun}:` : `${staged.length} pending ${noun}s:`
  return [header, ...staged.map(entry => formatPendingLine(entry, lessons))].join('\n')
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
    return { kind: 'success', text: formatStagedList(record?.staged ?? [], 'write', record?.agentLessons ?? []) }
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
 * Execute `/graph <entity> [relation]` against the session's scope: name a
 * relation to traverse outward from an entity, or omit it to list the
 * entity's immediate connections.
 * @param ctx - plugin context carrying the optional knowledge graph.
 * @param scope - scope identity resolved from the invoking session.
 * @param invocation - raw command input.
 * @returns the command result.
 */
function executeGraph(
  ctx: Context,
  scope: EvolutionScopeIdBrand,
  invocation: CommandInvocation,
): CommandResult {
  const [entity, relation, ...rest] = graphArgs(invocation.rawInput)
  if (entity === undefined || rest.length > 0) return { kind: 'error', text: GRAPH_USAGE }
  const graph = ctx.get('evolutionGraph')
  if (graph === undefined) return { kind: 'error', text: 'The knowledge graph is not mounted.' }
  if (relation !== undefined) {
    const answer = graph.answer(scope, entity, relation)
    if (answer === undefined) return { kind: 'success', text: `No entity matching '${entity}' in this scope's graph.` }
    if (answer.objects.length === 0) {
      return { kind: 'success', text: `${answer.subject.label} has no '${answer.relation}' relation.` }
    }
    return {
      kind: 'success',
      text: `${answer.subject.label} —${answer.relation}→ ${answer.objects.map(object => object.label).join(', ')}`,
    }
  }
  const reached = graph.expand(scope, entity, 1)
  const [origin, ...neighbours] = reached
  if (origin === undefined) return { kind: 'success', text: `No entity matching '${entity}' in this scope's graph.` }
  return {
    kind: 'success',
    text: [
      `${origin.node.label}:`,
      ...neighbours.map(reach => `- ${reach.path.join(' → ')} → ${reach.node.label}`),
    ].join('\n'),
  }
}

/**
 * Execute `/claims [query]`: the scope's active claims, most believed first,
 * each with the decomposed confidence and the evidence standing behind it. A
 * retired claim is absent — `/graph` still reaches its subject, but only a
 * standing claim answers here.
 * @param ctx - plugin context carrying the optional knowledge graph.
 * @param scope - scope identity resolved from the invoking session.
 * @param invocation - raw command input.
 * @returns the command result.
 */
function executeClaims(
  ctx: Context,
  scope: EvolutionScopeIdBrand,
  invocation: CommandInvocation,
): CommandResult {
  const [query, ...rest] = graphArgs(invocation.rawInput)
  if (rest.length > 0) return { kind: 'error', text: CLAIMS_USAGE }
  const graph = ctx.get('evolutionGraph')
  if (graph === undefined) return { kind: 'error', text: 'The knowledge graph is not mounted.' }
  const claims = graph.claims(scope, query ?? '')
  if (claims.length === 0) {
    return { kind: 'success', text: `No active claim matching '${query ?? ''}' in this scope.` }
  }
  return {
    kind: 'success',
    text: [
      `${claims.length} active claim${claims.length === 1 ? '' : 's'}:`,
      ...claims.map(claim => `- ${claim.statement}`
        + ` [confidence ${claim.confidence.toFixed(2)}`
        + `, ${claim.independentSupport} supporting / ${claim.contradictionCount} contradicting source(s)`
        + `, evidence ${claim.evidenceQuality.toFixed(2)}`
        + `, source ${claim.sourceReliability.toFixed(2)}`
        + `, newest ${claim.recency}]`),
    ].join('\n'),
  }
}

/**
 * Execute `/reflection [limit]`: the structured reflections stored for this
 * scope's sessions — the failure-to-heuristic association the learning loop
 * keeps — newest first, with the anti-pattern to avoid and the check that would
 * have caught the failure.
 * @param ctx - plugin context carrying the optional feedback store.
 * @param membership - the workspace the invoking session belongs to.
 * @param invocation - raw command input.
 * @returns the command result.
 */
async function executeReflection(
  ctx: Context,
  membership: ScopeMembership,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const [rawLimit, ...rest] = splitArgs(invocation.rawInput)
  const limit = rawLimit === undefined ? DEFAULT_REFLECTION_LIMIT : Number(rawLimit)
  if (rest.length > 0 || !Number.isInteger(limit) || limit < 1) {
    return { kind: 'error', text: REFLECTION_USAGE }
  }
  const feedback = ctx.get('evolutionFeedback') as ReflectionFeedback | undefined
  if (feedback === undefined) return { kind: 'error', text: 'The evolution feedback store is not mounted.' }
  // The reflections belong to the sessions this workspace owns; a workspace
  // with none has nothing to report rather than an error.
  const sessionIds = (ctx.workspaceRegistry.get(membership.id)?.sessionIds ?? []).map(id => String(id))
  try {
    const stored = await feedback.reflections(sessionIds, limit)
    if (stored.length === 0) return { kind: 'success', text: 'No reflections stored for this scope.' }
    return {
      kind: 'success',
      text: [
        `${stored.length} reflection${stored.length === 1 ? '' : 's'} (newest first):`,
        ...stored.map(renderReflection),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Render one stored reflection as operator-facing text: what happened, what was
 * expected instead, and the heuristic the loop will reuse.
 * @param reflection - the stored reflection to render.
 * @returns the rendered block.
 */
function renderReflection(reflection: ReflectionRow): string {
  const lines = [
    `- ${reflection.symptom} (confidence ${reflection.confidence.toFixed(2)})`,
    `  expected: ${reflection.violatedExpectation}`,
  ]
  if (reflection.rootCause !== null) lines.push(`  cause: ${reflection.rootCause}`)
  if (reflection.antiPattern !== null) {
    lines.push(`  avoid: ${reflection.antiPattern}`
      + (reflection.reusableWhen === null ? '' : ` (${reflection.reusableWhen})`))
  }
  if (reflection.correctedStrategy !== null) lines.push(`  instead: ${reflection.correctedStrategy}`)
  if (reflection.candidateTest !== null) lines.push(`  check: ${reflection.candidateTest}`)
  return lines.join('\n')
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
    // A skill proposal stages a skill write, never an artifact batch, so there
    // is no artifact text for its list to resolve.
    return { kind: 'success', text: staged.length === 0 ? SKILLS_EMPTY : formatStagedList(staged, 'skill proposal', []) }
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
 * Execute `/evaluators [runs [<skill>]]`: summarize evaluator ensemble health
 * — approval rates with drift, unanimity, false positives, per-channel rows —
 * or list the recorded verdicts, optionally for one skill.
 * @param ctx - plugin context carrying the optional evaluator-health store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
function executeEvaluators(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionEvaluatorHealth') as {
    summary(): EvaluatorHealthSummary
    runs(skill?: string): readonly EvaluatorRun[]
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evaluator-health store is not mounted.' }
  const args = splitArgs(invocation.rawInput)
  const verb = args[0]
  if (verb === 'runs') {
    if (args.length > 2) return { kind: 'error', text: EVALUATORS_USAGE }
    const rows = store.runs(args[1]).slice(0, 10)
    if (rows.length === 0) return { kind: 'success', text: 'No recorded evaluator verdicts.' }
    const lines = rows.map(run =>
      `- ${run.id.slice(0, 8)} ${run.skill}: ${run.status}${run.approved ? ' approved' : ''}`
      + `${run.unanimous ? ' unanimous' : ` (split: ${run.dissenting.join(', ')})`} at ${run.at}`)
    return { kind: 'success', text: [`${rows.length} verdict${rows.length === 1 ? '' : 's'}:`, ...lines].join('\n') }
  }
  if (verb !== undefined) return { kind: 'error', text: EVALUATORS_USAGE }
  const summary = store.summary()
  const channel = summary.channels.map(row => `${row.channel} ${Math.round(row.approvalRate * 100)}%`).join(', ')
  return {
    kind: 'success',
    text: [
      `Evaluator health: ${summary.runs} verdict${summary.runs === 1 ? '' : 's'},`
      + ` approved ${Math.round(summary.approvalRate * 100)}%`
      + ` (recent ${Math.round(summary.recentApprovalRate * 100)}%, drift ${summary.drift >= 0 ? '+' : ''}${Math.round(summary.drift * 100)} points),`
      + ` unanimous ${Math.round(summary.unanimousRate * 100)}%,`
      + ` false positives ${Math.round(summary.falsePositiveRate * 100)}% of approvals.`,
      `Channels: ${channel}.`,
    ].join('\n'),
  }
}

/**
 * Execute `/population <skill> [lineage <id> | approve <id> | reject <id>]`:
 * list one skill's candidate population with generations and standings, walk
 * one candidate's lineage oldest first, or move a staged candidate to
 * approved or rejected. Candidate ids are the optimizer's staged write ids.
 * @param ctx - plugin context carrying the optional population store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executePopulation(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const store = ctx.get('evolutionPopulation') as {
    candidates(skill?: string): readonly PopulationCandidate[]
    lineage(skill: string, candidateId: string): readonly PopulationCandidate[]
    elite(skill: string): readonly PopulationCandidate[]
    updateStatus(candidateId: string, status: PopulationStatus): Promise<PopulationCandidate>
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution population store is not mounted.' }
  const [skill, verb, id, ...rest] = splitArgs(invocation.rawInput)
  if (skill === undefined || rest.length > 0) return { kind: 'error', text: POPULATION_USAGE }
  if (verb !== undefined && (id === undefined || (verb !== 'lineage' && verb !== 'approve' && verb !== 'reject'))) {
    return { kind: 'error', text: POPULATION_USAGE }
  }
  try {
    if (verb === 'lineage') {
      const chain = store.lineage(skill, id as string)
      if (chain.length === 0) return { kind: 'error', text: `No candidate '${id}' for skill '${skill}'.` }
      const lines = chain.map((candidate, index) =>
        `- g${candidate.generation} ${candidate.candidateId.slice(0, 8)} [${candidate.status}] ${candidate.operator}`
        + (index === chain.length - 1 ? ' ← newest' : ''))
      return { kind: 'success', text: [`Lineage of '${id}' in '${skill}':`, ...lines].join('\n') }
    }
    if (verb === 'approve' || verb === 'reject') {
      const status: PopulationStatus = verb === 'approve' ? 'approved' : 'rejected'
      const moved = await store.updateStatus(id as string, status)
      return { kind: 'success', text: `Marked candidate '${moved.candidateId.slice(0, 8)}' (g${moved.generation} ${moved.skill}) as '${moved.status}'.` }
    }
    const rows = store.candidates(skill)
    if (rows.length === 0) return { kind: 'success', text: `No candidates recorded for '${skill}'.` }
    const generation = rows.reduce((max, candidate) => Math.max(max, candidate.generation), 0)
    const lines = rows.map((candidate) => {
      const measure = candidate.triple === null
        ? 'unmeasured'
        : `${String(candidate.triple.pass)} pass, ${candidate.triple.tokens} tokens, ${candidate.triple.wallTimeMs}ms`
      const parent = candidate.parentCandidateId === null ? ' · root' : ` ← ${candidate.parentCandidateId.slice(0, 8)}`
      return `- g${candidate.generation} ${candidate.candidateId.slice(0, 8)} [${candidate.status}] ${candidate.operator}: ${measure}${parent}`
    })
    const elite = store.elite(skill).slice(0, 3)
      .map(candidate => `${candidate.candidateId.slice(0, 8)} (g${candidate.generation})`).join(', ')
    return {
      kind: 'success',
      text: [
        `Population '${skill}': generation ${generation}, ${rows.length} candidate${rows.length === 1 ? '' : 's'}.`,
        ...lines,
        elite.length === 0 ? 'Elite: none approved yet.' : `Elite: ${elite}.`,
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/routes [pin <role> <provider> <model> | evidence [<role>]]`: list
 * the per-role route assignments with their measured evidence and the role's
 * recommended route, pin one route for a role, or list the newest evidence.
 * @param ctx - plugin context carrying the optional model-routes store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeRoutes(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const store = ctx.get('evolutionModelRoutes') as {
    routes(role?: EvolutionRole): readonly RouteSummary[]
    evidence(role?: EvolutionRole, route?: ModelRoute): readonly RouteEvidence[]
    pin(role: EvolutionRole, provider: string, model: string): Promise<RouteRow>
    recommend(role: EvolutionRole): ModelRoute | undefined
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution model-routes store is not mounted.' }
  const [verb, ...rest] = splitArgs(invocation.rawInput)
  const isRole = (candidate: string | undefined): candidate is EvolutionRole =>
    candidate !== undefined && (EVOLUTION_ROLES as readonly string[]).includes(candidate)
  try {
    if (verb === 'pin') {
      if (rest.length !== 3 || !isRole(rest[0]) || (rest[1] as string).length === 0 || (rest[2] as string).length === 0) {
        return { kind: 'error', text: ROUTES_USAGE }
      }
      const pinned = await store.pin(rest[0], rest[1] as string, rest[2] as string)
      return { kind: 'success', text: `Pinned '${pinned.role}' to ${pinned.provider}/${pinned.model}.` }
    }
    if (verb === 'evidence') {
      if (rest.length > 1) return { kind: 'error', text: ROUTES_USAGE }
      const role = rest[0]
      if (role !== undefined && !isRole(role)) return { kind: 'error', text: ROUTES_USAGE }
      const rows = store.evidence(role).slice(0, 10)
      if (rows.length === 0) return { kind: 'success', text: 'No recorded route evidence.' }
      const lines = rows.map(row =>
        `- ${row.id.slice(0, 8)} ${row.role}: ${row.provider}/${row.model}`
        + ` ${String(row.pass)} pass, ${row.tokens} tokens at ${row.at}`)
      return { kind: 'success', text: [`${rows.length} evidence row${rows.length === 1 ? '' : 's'}:`, ...lines].join('\n') }
    }
    if (verb !== undefined) return { kind: 'error', text: ROUTES_USAGE }
    const summaries = store.routes()
    if (summaries.length === 0) {
      return { kind: 'success', text: 'No route assignments yet. The optimizer records candidate-generation routes; pin the rest.' }
    }
    const lines: string[] = []
    for (const role of EVOLUTION_ROLES) {
      const mine = summaries.filter(summary => summary.role === role)
      if (mine.length === 0) continue
      const recommended = store.recommend(role)
      const recommendedText = recommended === undefined
        ? ''
        : ` → recommended ${recommended.provider}/${recommended.model}`
      const per = mine.map(summary =>
        `${summary.provider}/${summary.model}${summary.origin === 'pinned' ? ' (pinned)' : ''}`
        + `: ${summary.runs} run${summary.runs === 1 ? '' : 's'},`
        + ` ${Math.round(summary.passRate * 100)}% pass,`
        + ` ${Math.round(summary.meanTokens)} tokens avg`).join(' · ')
      lines.push(`${role}: ${per}${recommendedText}`)
    }
    return { kind: 'success', text: ['Routes:', ...lines].join('\n') }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The slice of `ctx.evolutionModelRoutes` §53's separation of duties needs: the
 * role fills it records and the check it answers them with. Structural, so the
 * check stays an optional seam: a deployment without the store promotes on the
 * canary ladder's own rules.
 */
interface DutyStore {
  recordDuty(input: DutyInput): Promise<DutyRecord>
  checkDuties(runId: string, decision: DutyDecision): DutyVerdict
}

/**
 * Record the identity that filled §53's candidate-generation role for one run
 * — the staged write's proposer, which is the invocation's own session and the
 * same string the staged entry carries as its `originSessionId`. A failed fill
 * must not fail an optimization that already staged its patch, so it logs a
 * warning: the role then reads as unrecorded, and a promotion over it is
 * refused as unknown rather than judged on an identity that never landed.
 * @param ctx - plugin context carrying the optional model-routes store.
 * @param runId - the run the candidate belongs to.
 * @param identity - the identity that proposed it.
 */
async function recordProposerDuty(ctx: Context, runId: string, identity: string): Promise<void> {
  const store = ctx.get('evolutionModelRoutes') as DutyStore | undefined
  if (store === undefined) return
  try {
    await store.recordDuty({ runId, role: 'candidate-generation', identity })
  } catch (error) {
    ctx.logger.warn(`command-evolution could not record the candidate-generation duty for '${runId}': ${String(error)}`)
  }
}

/**
 * §53's separation of duties over one promotion: record the reviewing identity
 * and answer whether it differs from the identity that proposed the candidate.
 * A fill that cannot be written refuses the promotion instead of falling
 * through to an identity an earlier attempt left behind, and an unrecorded
 * proposing role refuses as unknown — absence is never read as separation.
 * @param ctx - plugin context carrying the optional model-routes store.
 * @param id - the deployment being promoted, which is the run the pair belongs to.
 * @param reviewer - the identity that invoked the promotion.
 * @returns the refusal, which names the roles and the run, or null to proceed.
 */
async function promotionRefusal(ctx: Context, id: string, reviewer: string): Promise<string | null> {
  const store = ctx.get('evolutionModelRoutes') as DutyStore | undefined
  if (store === undefined) return null
  try {
    await store.recordDuty({ runId: id, role: 'promotion-review', identity: reviewer })
  } catch (error) {
    return `Promotion of '${id}' refused: the promotion-review identity could not be recorded (${String(error)})`
  }
  const verdict = store.checkDuties(id, 'promotion')
  return verdict.allowed ? null : `Promotion of '${id}' refused: ${verdict.reason}`
}

/**
 * Execute `/canary [status [<skill>] | rollout <id> | promote <id> | reject
 * <id> | rollback <id>]`: list deployment states (optionally per skill), move
 * a shadow deployment to canary, promote a canary to promoted, or exit a
 * staged rollout to rejected or rolled-back. Deployment entry itself is
 * automatic: the optimizer records every staged write as shadow. A promotion
 * carries §53's separation of duties: the invocation's session is recorded as
 * the reviewing identity and the promotion is refused when it is the identity
 * that proposed the candidate.
 * @param ctx - plugin context carrying the optional canary store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeCanary(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const store = ctx.get('evolutionCanary') as {
    deployments(state?: DeploymentState, skill?: string): readonly DeploymentRecord[]
    advance(id: string, to: DeploymentState): Promise<DeploymentRecord>
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution canary store is not mounted.' }
  const [verb, ...rest] = splitArgs(invocation.rawInput)
  try {
    if (verb === 'rollout' || verb === 'promote' || verb === 'reject' || verb === 'rollback') {
      if (rest.length !== 1) return { kind: 'error', text: CANARY_USAGE }
      const id = rest[0] as string
      const to: DeploymentState = verb === 'rollout'
        ? 'canary'
        : verb === 'promote'
          ? 'promoted'
          : verb === 'reject'
            ? 'rejected'
            : 'rolled-back'
      if (to === 'promoted') {
        const refusal = await promotionRefusal(ctx, id, String(invocation.agent.session.id))
        if (refusal !== null) return { kind: 'error', text: refusal }
      }
      const moved = await store.advance(id, to)
      return { kind: 'success', text: `Deployment '${moved.id.slice(0, 8)}' (${moved.skill}) moved to '${moved.state}'.` }
    }
    if (verb !== undefined && verb !== 'status') return { kind: 'error', text: CANARY_USAGE }
    if (verb === 'status' && rest.length > 1) return { kind: 'error', text: CANARY_USAGE }
    const skill = rest[0]
    const rows = store.deployments(undefined, skill)
    if (rows.length === 0) {
      const text = skill === undefined
        ? 'No deployments yet. The optimizer records staged writes as shadow.'
        : `No deployments for '${skill}'.`
      return { kind: 'success', text }
    }
    const summarize = (state: DeploymentState): number => rows.filter(row => row.state === state).length
    const lines = rows.slice(0, 10).map((row) => {
      const stage = nextStage(row.state)
      const next = stage === null ? '' : ` → next ${stage}`
      const measure = row.triple === null ? '' : ` (${String(row.triple.pass)} pass, ${row.triple.tokens} tokens)`
      return `- ${row.id.slice(0, 8)} ${row.skill}: ${row.state}${next}${measure}`
    })
    return {
      kind: 'success',
      text: [
        `Canary: ${summarize('shadow')} shadow, ${summarize('canary')} canary,`
        + ` ${summarize('promoted')} promoted, ${summarize('rolled-back')} rolled-back, ${summarize('rejected')} rejected.`,
        ...lines,
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/novelty [<skill>]`: summarize the novelty archive (optionally per
 * skill), or list one skill's recorded behavior descriptors with their
 * measured archive novelty. Entries arrive automatically from the optimizer's
 * staged writes.
 * @param ctx - plugin context carrying the optional novelty-search store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
function executeNovelty(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionNovelty') as {
    entries(skill?: string): readonly NoveltyArchiveEntry[]
    mean(skill: string): number
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution novelty-search store is not mounted.' }
  const [skill, ...rest] = splitArgs(invocation.rawInput)
  if (skill === undefined) {
    if (rest.length > 0) return { kind: 'error', text: NOVELTY_USAGE }
    const entries = store.entries()
    if (entries.length === 0) {
      return { kind: 'success', text: 'No recorded novelty archive entries. The optimizer records staged writes as descriptors.' }
    }
    const skills = [...new Set(entries.map(entry => entry.skill))].sort()
    const lines = skills.map((name) => {
      const mine = entries.filter(entry => entry.skill === name)
      return `- ${name}: ${mine.length} entr${mine.length === 1 ? 'y' : 'ies'}, mean novelty ${store.mean(name).toFixed(2)}`
    })
    return {
      kind: 'success',
      text: [
        `Novelty archive: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} across ${skills.length} skill${skills.length === 1 ? '' : 's'}.`,
        ...lines,
      ].join('\n'),
    }
  }
  if (rest.length > 0) return { kind: 'error', text: NOVELTY_USAGE }
  const rows = store.entries(skill)
  if (rows.length === 0) return { kind: 'success', text: `No recorded novelty archive entries for '${skill}'.` }
  const lines = rows.slice(0, 10).map(entry =>
    `- ${entry.candidateId.slice(0, 8)}: ${entry.features.length} features, novelty ${entry.novelty.toFixed(2)} at ${entry.at}`)
  return {
    kind: 'success',
    text: [
      `Novelty archive '${skill}': ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}, mean ${store.mean(skill).toFixed(2)}.`,
      ...lines,
    ].join('\n'),
  }
}

/**
 * Execute `/stagnation [status <skill> | runs [<skill>] | reset <skill>]`:
 * summarize every skill's stagnation standing, render one skill's status with
 * the recommended strategy, list evaluation runs, or drop one skill's history
 * when its task regime changed. Runs arrive automatically from the optimizer's
 * staged writes.
 * @param ctx - plugin context carrying the optional stagnation store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeStagnation(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const store = ctx.get('evolutionStagnation') as {
    runs(skill?: string): readonly StagnationRun[]
    status(skill: string): StagnationStatus
    reset(skill: string): Promise<number>
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution stagnation store is not mounted.' }
  const [verb, ...rest] = splitArgs(invocation.rawInput)
  try {
    if (verb === 'status') {
      if (rest.length !== 1) return { kind: 'error', text: STAGNATION_USAGE }
      const status = store.status(rest[0] as string)
      const measure = status.bestScore === null
        ? 'no best yet'
        : `${String(status.bestScore.pass)} pass, ${status.bestScore.tokens} tokens, ${status.bestScore.wallTimeMs}ms`
      return {
        kind: 'success',
        text: [
          `Stagnation '${status.skill}': ${status.runs} run${status.runs === 1 ? '' : 's'}, best ${measure}.`,
          `${status.generationsSinceImprovement} generation${status.generationsSinceImprovement === 1 ? '' : 's'} since improvement, threshold ${status.threshold}.`,
          status.stagnant ? `STAGNANT → strategy: ${status.strategy}` : `Not stagnant — continue ${status.strategy}.`,
        ].join('\n'),
      }
    }
    if (verb === 'runs') {
      if (rest.length > 1) return { kind: 'error', text: STAGNATION_USAGE }
      const rows = store.runs(rest[0]).slice(0, 10)
      if (rows.length === 0) return { kind: 'success', text: 'No recorded stagnation runs.' }
      const lines = rows.map(run =>
        `- g${run.generation} ${run.runId.slice(0, 8)} ${run.skill}: ${String(run.score.pass)} pass, ${run.score.tokens} tokens,`
        + ` ${run.score.wallTimeMs}ms${run.improved ? ' improved' : ''} at ${run.at}`)
      return { kind: 'success', text: [`${rows.length} run${rows.length === 1 ? '' : 's'}:`, ...lines].join('\n') }
    }
    if (verb === 'reset') {
      if (rest.length !== 1) return { kind: 'error', text: STAGNATION_USAGE }
      const skill = rest[0] as string
      const removed = await store.reset(skill)
      return { kind: 'success', text: `Reset stagnation history of '${skill}': dropped ${removed} run${removed === 1 ? '' : 's'}.` }
    }
    if (verb !== undefined) return { kind: 'error', text: STAGNATION_USAGE }
    const rows = store.runs()
    const skills = [...new Set(rows.map(run => run.skill))].sort()
    if (skills.length === 0) {
      return { kind: 'success', text: 'No recorded stagnation runs. The optimizer records staged writes as runs.' }
    }
    const lines = skills.map((skill) => {
      const status = store.status(skill)
      return `- ${skill}: ${status.generationsSinceImprovement}/${status.threshold} generations since improvement`
        + (status.stagnant ? ` — STAGNANT → ${status.strategy}` : ' — ok')
    })
    return { kind: 'success', text: ['Stagnation:', ...lines].join('\n') }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/islands [list [<skill>] | register <island> <name> <objective>
 * <skill> | migrate <from> <to> <candidate> [<reason>] | migrations [<skill>]]`:
 * list islands with their migration schedule, register a lane of a skill's
 * evolution job, record a candidate migration between two islands, or list
 * the migration log. Generation ticks arrive automatically from the
 * optimizer's staged writes.
 * @param ctx - plugin context carrying the optional islands store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeIslands(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const store = ctx.get('evolutionIslands') as {
    register(input: IslandInput): Promise<Island>
    migrate(input: MigrationInput): Promise<Migration>
    migrations(skill?: string): readonly Migration[]
    schedule(skill?: string): readonly IslandSchedule[]
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution islands store is not mounted.' }
  const [verb, ...rest] = splitArgs(invocation.rawInput)
  try {
    if (verb === 'register') {
      if (rest.length !== 4) return { kind: 'error', text: ISLANDS_USAGE }
      const [islandId, name, objective, skill] = rest as [string, string, string, string]
      if (!(ISLAND_OBJECTIVES as readonly string[]).includes(objective)) return { kind: 'error', text: ISLANDS_USAGE }
      const stored = await store.register({ islandId, name, objective: objective as IslandObjective, skill })
      return {
        kind: 'success',
        text: `Registered island '${stored.islandId}' '${stored.name}' [${stored.objective}] for '${stored.skill}'.`,
      }
    }
    if (verb === 'migrate') {
      if (rest.length < 3 || rest.length > 4) return { kind: 'error', text: ISLANDS_USAGE }
      const [fromIslandId, toIslandId, candidateId, reasonArg] = rest as [string, string, string, string | undefined]
      if (reasonArg !== undefined && reasonArg !== 'schedule' && reasonArg !== 'elite' && reasonArg !== 'diversity') {
        return { kind: 'error', text: ISLANDS_USAGE }
      }
      const reason: MigrationReason = reasonArg ?? 'schedule'
      const migrated = await store.migrate({ fromIslandId, toIslandId, candidateId, reason })
      return {
        kind: 'success',
        text: `Migrated candidate '${migrated.candidateId.slice(0, 8)}' ${migrated.fromIslandId} → ${migrated.toIslandId} (${migrated.reason}).`,
      }
    }
    if (verb === 'migrations') {
      if (rest.length > 1) return { kind: 'error', text: ISLANDS_USAGE }
      const rows = store.migrations(rest[0]).slice(0, 10)
      if (rows.length === 0) return { kind: 'success', text: 'No recorded island migrations.' }
      const lines = rows.map(migration =>
        `- ${migration.migrationId.slice(0, 8)} ${migration.candidateId.slice(0, 8)} ${migration.fromIslandId} → ${migration.toIslandId}`
        + ` (${migration.reason}) at ${migration.at}`)
      return { kind: 'success', text: [`${rows.length} migration${rows.length === 1 ? '' : 's'}:`, ...lines].join('\n') }
    }
    if (verb !== undefined && verb !== 'list') return { kind: 'error', text: ISLANDS_USAGE }
    if (verb === 'list' && rest.length > 1) return { kind: 'error', text: ISLANDS_USAGE }
    const schedule = store.schedule(rest[0])
    if (schedule.length === 0) {
      return { kind: 'success', text: 'No islands registered. Define a skill\'s lanes with `/islands register <island> <name> <objective> <skill>`.' }
    }
    const lines = schedule.map(row =>
      `- ${row.island.islandId} '${row.island.name}' [${row.island.objective}] ${row.island.skill} g${row.island.generation}`
      + (row.due ? ' · migration due' : ''))
    return { kind: 'success', text: [`Islands${rest[0] === undefined ? '' : ` '${rest[0]}'`}:`, ...lines].join('\n') }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/selfmodel [<skill>]`: render one skill's self-assessment or the
 * whole weakest-first capability frontier with the capability to learn next.
 * @param ctx - plugin context carrying the optional self-model store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
function executeSelfModel(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionSelfModel') as {
    assessment(skill: string): SelfModelAssessment | undefined
    gaps(): readonly SelfModelGap[]
    nextToLearn(): { capability: string } | null
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution self-model store is not mounted.' }
  const args = splitArgs(invocation.rawInput)
  try {
    if (args.length > 1) return { kind: 'error', text: SELF_MODEL_USAGE }
    if (args.length === 1) {
      const model = store.assessment(args[0] as string)
      if (model === undefined) return { kind: 'success', text: `No self-assessment recorded for '${args[0]}'.` }
      return { kind: 'success', text: renderSelfModel(args[0] as string, model) }
    }
    const gaps = store.gaps()
    if (gaps.length === 0) return { kind: 'success', text: 'No measured capabilities yet. The optimizer records capability observations as it stages writes.' }
    const next = store.nextToLearn()
    return {
      kind: 'success',
      text: [
        `Capability frontier (weakest first): ${gaps.length}`,
        ...gaps.map(gap => `- ${gap.capability}: score ${gap.score.toFixed(2)}, confidence ${gap.confidence.toFixed(2)}, ${gap.coveringSkills.length} skill${gap.coveringSkills.length === 1 ? '' : 's'}, ${gap.observations} observations`),
        next === null ? '' : `Next to learn: ${next.capability}`,
      ].filter(line => line.length > 0).join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/uncertainty [<skill>]`: render the prioritized queue of high-value
 * evaluation tasks, optionally for one skill.
 * @param ctx - plugin context carrying the optional uncertainty store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
function executeUncertainty(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionUncertainty') as {
    queue(skill?: string): readonly UncertaintyQueueRow[]
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution uncertainty store is not mounted.' }
  const args = splitArgs(invocation.rawInput)
  try {
    if (args.length > 1) return { kind: 'error', text: UNCERTAINTY_USAGE }
    const queue = store.queue(args[0])
    if (queue.length === 0) return { kind: 'success', text: 'No uncertainty signals. The scorer records evaluator disagreement as signals.' }
    return {
      kind: 'success',
      text: [
        `Evaluation queue${args[0] === undefined ? '' : ` '${args[0]}'`}: ${queue.length}`,
        ...queue.map(row => `- ${row.skill}${row.taskId === null ? ' (skill-wide)' : ` task ${row.taskId}`}: priority ${row.priority.toFixed(2)}, [${row.kinds.join(', ')}], ${row.signals} signals`),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/adversary [...]`: list probes, record one, mark it repaired, read
 * the next probing challenge, or track the evaluator-gaming defense checklist.
 * @param ctx - plugin context carrying the optional adversary store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeAdversary(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const store = ctx.get('evolutionAdversary') as {
    probes(skill?: string): readonly AdversaryProbeRow[]
    probe(input: { probeId: string; skill: string; category: string; probe: string; foundWeakness: boolean }): Promise<unknown>
    setRepaired(probeId: string): Promise<unknown>
    challenge(skill: string): AdversaryChallengeRow
    defenses(): readonly AdversaryDefenseRow[]
    setDefense(defense: string, satisfied: boolean): Promise<unknown>
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution adversary store is not mounted.' }
  const args = splitArgs(invocation.rawInput)
  const verb = args[0]
  try {
    if (verb === 'probe') {
      if (args.length < 4) return { kind: 'error', text: ADVERSARY_USAGE }
      const category = args[2] as string
      if (!(ADVERSARIAL_CATEGORIES as readonly string[]).includes(category)) return { kind: 'error', text: ADVERSARY_USAGE }
      // The probe phrase may contain spaces; everything after the category is the probe text.
      const probeText = args.slice(3).join(' ')
      if (probeText.length === 0) return { kind: 'error', text: ADVERSARY_USAGE }
      const recorded = await store.probe({
        probeId: randomUUID(),
        skill: args[1] as string,
        category,
        probe: probeText,
        foundWeakness: false,
      })
      void recorded
      return { kind: 'success', text: `Recorded a '${category}' probe for '${args[1]}'. Mark it repaired with /adversary repair <id> once the weakness is fixed.` }
    }
    if (verb === 'repair') {
      if (args.length !== 2) return { kind: 'error', text: ADVERSARY_USAGE }
      await store.setRepaired(args[1] as string)
      return { kind: 'success', text: `Marked probe '${(args[1] as string).slice(0, 8)}' repaired.` }
    }
    if (verb === 'challenge') {
      if (args.length !== 2) return { kind: 'error', text: ADVERSARY_USAGE }
      const challenge = store.challenge(args[1] as string)
      return { kind: 'success', text: `Next adversarial probe for '${challenge.category}' (${challenge.probed} recorded): ${challenge.reason}` }
    }
    if (verb === 'defenses') {
      if (args.length !== 1) return { kind: 'error', text: ADVERSARY_USAGE }
      const rows = store.defenses()
      if (rows.length === 0) return { kind: 'success', text: 'No evaluator-gaming defenses recorded.' }
      return {
        kind: 'success',
        text: ['Evaluator-gaming defenses:', ...rows.map(row => `- ${row.defense}: ${row.satisfied ? 'satisfied' : 'open'}`)].join('\n'),
      }
    }
    if (verb === 'defense') {
      if (args.length !== 3 || !(GAMING_DEFENSES as readonly string[]).includes(args[1] as string)) return { kind: 'error', text: ADVERSARY_USAGE }
      if (args[2] !== 'true' && args[2] !== 'false') return { kind: 'error', text: ADVERSARY_USAGE }
      await store.setDefense(args[1] as string, args[2] === 'true')
      return { kind: 'success', text: `Set defense '${args[1]}' to ${args[2] === 'true' ? 'satisfied' : 'open'}.` }
    }
    if (verb !== undefined && verb !== 'list') return { kind: 'error', text: ADVERSARY_USAGE }
    if (verb === 'list' && args.length > 2) return { kind: 'error', text: ADVERSARY_USAGE }
    const rows = store.probes(args[1])
    if (rows.length === 0) return { kind: 'success', text: 'No adversarial probes recorded. Record one with /adversary probe <skill> <category> <probe>.' }
    return {
      kind: 'success',
      text: [
        `Adversarial probes${args[1] === undefined ? '' : ` '${args[1]}'`}: ${rows.length}`,
        ...rows.map(row => `- ${row.probeId.slice(0, 8)} [${row.category}] ${row.skill}: ${row.foundWeakness ? 'weakness found' : 'no weakness'}${row.repaired ? ' · repaired' : ''}`),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/lineage [list [<skill>] | compare <idA> <idB> | replay <id>]`:
 * list dependency-versioned experiment envelopes, prove two envelopes were
 * measured comparably, or replay one from its record.
 * @param ctx - plugin context carrying the optional lineage store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
function executeLineage(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionLineage') as {
    experiments(skill?: string): readonly Omit<LineageEnvelopeRow, 'seeds'>[]
    compare(idA: string, idB: string): { comparable: boolean; changed: readonly string[] } | undefined
    replay(id: string): LineageEnvelopeRow | undefined
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution lineage store is not mounted.' }
  const args = splitArgs(invocation.rawInput)
  const verb = args[0]
  try {
    if (verb === 'compare') {
      if (args.length !== 3) return { kind: 'error', text: LINEAGE_USAGE }
      const verdict = store.compare(args[1] as string, args[2] as string)
      if (verdict === undefined) return { kind: 'error', text: 'Unknown experiment id in /lineage compare.' }
      if (verdict.comparable) return { kind: 'success', text: `'${(args[1] as string).slice(0, 8)}' vs '${(args[2] as string).slice(0, 8)}': comparable — no compared dependency changed.` }
      return { kind: 'success', text: `'${(args[1] as string).slice(0, 8)}' vs '${(args[2] as string).slice(0, 8)}': incomparable — changed dependencies: ${verdict.changed.join(', ')}.` }
    }
    if (verb === 'replay') {
      if (args.length !== 2) return { kind: 'error', text: LINEAGE_USAGE }
      const envelope = store.replay(args[1] as string)
      if (envelope === undefined) return { kind: 'error', text: `Unknown experiment '${(args[1] as string).slice(0, 8)}'.` }
      return { kind: 'success', text: renderLineageEnvelope(envelope) }
    }
    if (verb !== undefined && verb !== 'list') return { kind: 'error', text: LINEAGE_USAGE }
    if (verb === 'list' && args.length > 2) return { kind: 'error', text: LINEAGE_USAGE }
    const rows = store.experiments(args[1])
    if (rows.length === 0) return { kind: 'success', text: 'No experiment envelopes recorded. The optimizer records staged writes as envelopes.' }
    return {
      kind: 'success',
      text: [
        `Experiments${args[1] === undefined ? '' : ` '${args[1]}'`} (newest first): ${rows.length}`,
        ...rows.map(row => `- ${row.experimentId.slice(0, 8)} ${row.skill} ${row.outcome} by ${row.operator ?? '?'}: pass ${String(row.metrics.pass)}, ${row.metrics.tokens} tokens, ${row.metrics.wallTimeMs}ms`),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/sleeptime [tasks [<domain>] | artifacts [<taskId>] | plan]`: list
 * anticipated future tasks, list precomputed reasoning artifacts, or show the
 * offline-cost plan choosing which artifacts to build.
 * @param ctx - plugin context carrying the optional sleeptime store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
function executeSleeptime(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionSleeptime') as {
    tasks(domain?: string): readonly SleeptimeTaskRow[]
    artifacts(taskId?: string): readonly SleeptimeArtifactRow[]
    plan(): readonly SleeptimePlanRow[]
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution sleeptime store is not mounted.' }
  const args = splitArgs(invocation.rawInput)
  const verb = args[0]
  try {
    if (verb === 'plan') {
      if (args.length !== 1) return { kind: 'error', text: SLEEPTIME_USAGE }
      const plan = store.plan()
      if (plan.length === 0) return { kind: 'success', text: 'Nothing worth precomputing now. Anticipate tasks to seed the plan.' }
      return {
        kind: 'success',
        text: [
          'Sleep-time plan:',
          ...plan.map(row => `- ${row.taskId} (${row.domain}): net ${row.expectedNet} tokens — ${row.reason}`),
        ].join('\n'),
      }
    }
    if (verb === 'artifacts') {
      if (args.length > 2) return { kind: 'error', text: SLEEPTIME_USAGE }
      const rows = store.artifacts(args[1])
      if (rows.length === 0) return { kind: 'success', text: 'No precomputed artifacts recorded.' }
      return {
        kind: 'success',
        text: [
          `Precomputed artifacts${args[1] === undefined ? '' : ` '${args[1]}'`}: ${rows.length}`,
          ...rows.map(row => `- ${row.artifactId.slice(0, 8)} [${row.kind}] for ${row.taskId}: ${row.hits} hits, ${row.savedTokens} tokens saved, cost ${row.offlineCostTokens}`),
        ].join('\n'),
      }
    }
    if (verb !== undefined && verb !== 'tasks') return { kind: 'error', text: SLEEPTIME_USAGE }
    if (verb === 'tasks' && args.length > 2) return { kind: 'error', text: SLEEPTIME_USAGE }
    const rows = store.tasks(args[1])
    if (rows.length === 0) return { kind: 'success', text: 'No anticipated tasks. Anticipate likely future tasks to seed sleep-time compute.' }
    return {
      kind: 'success',
      text: [
        `Anticipated tasks${args[1] === undefined ? '' : ` '${args[1]}'`} (likelihood first): ${rows.length}`,
        ...rows.map(row => `- ${row.taskId} (${row.domain}): ${Math.round(row.likelihood * 100)}%, ${row.expectedQueries} expected queries, ${row.expectedSavingTokens} tokens each`),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Render one self-assessment for `/selfmodel <skill>`.
 * @param skill - the skill the assessment describes.
 * @param model - the recorded assessment.
 * @returns the rendered block, one fact per line.
 */
function renderSelfModel(skill: string, model: SelfModelAssessment): string {
  return [
    `Self-model '${skill}' (revision ${model.revision}, confidence ${model.confidence.toFixed(2)}):`,
    ...renderList('strengths', model.strengths),
    ...renderList('weaknesses', model.weaknesses),
    ...renderList('uncertain areas', model.uncertainAreas),
    ...renderList('failure modes', model.failureModes),
    ...renderList('preferred tools', model.preferredTools),
    ...renderList('evaluator blindspots', model.evaluatorBlindspots),
  ].join('\n')
}

/**
 * Render one lineage envelope for `/lineage replay <id>`.
 * @param envelope - the envelope to render.
 * @returns the rendered block, one fact per line.
 */
function renderLineageEnvelope(envelope: LineageEnvelopeRow): string {
  return [
    `Experiment ${envelope.experimentId} (${envelope.skill}, ${envelope.outcome} by ${envelope.operator ?? '?'}):`,
    `- pass ${String(envelope.metrics.pass)}, ${envelope.metrics.tokens} tokens, ${envelope.metrics.wallTimeMs}ms`,
    `- dependencies: ${Object.entries(envelope.dependencies).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`,
    `- seeds: ${envelope.seeds.length === 0 ? 'not recorded' : envelope.seeds.join(', ')}`,
  ].join('\n')
}

/**
 * Render a labelled list as `- label: item` lines, omitting empty lists.
 * @param label - the list's label.
 * @param items - the items to render.
 * @returns the rendered lines.
 */
function renderList(label: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [`- ${label}: ${items.join(', ')}`]
}

/**
 * Execute `/benchmark [admit | promote <id> [state] | retire <id>]`: list the
 * benchmark store by state, admit the open curriculum proposals as fresh
 * tasks, promote a task up the learning ladder (or to a named state), or
 * retire one.
 * @param ctx - plugin context carrying the optional benchmark and curriculum stores.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeBenchmark(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const store = ctx.get('evolutionBenchmark') as {
    admit(inputs: readonly BenchmarkInput[]): Promise<{ admitted: readonly BenchmarkTask[]; duplicates: string[] }>
    tasks(state?: BenchmarkState): readonly BenchmarkTask[]
    transition(id: string, to: BenchmarkState): Promise<BenchmarkTask>
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution benchmark store is not mounted.' }
  const args = splitArgs(invocation.rawInput)
  const verb = args[0]
  try {
    if (verb === 'admit') {
      if (args.length !== 1) return { kind: 'error', text: BENCHMARK_USAGE }
      const curriculum = ctx.get('evolutionCurriculum') as { proposals(): readonly CurriculumProposal[] } | undefined
      if (curriculum === undefined) return { kind: 'error', text: 'The evolution curriculum store is not mounted; admit needs open proposals.' }
      const inputs: BenchmarkInput[] = curriculum.proposals()
        .filter(proposal => proposal.state === 'open')
        .map(proposal => ({
          capability: proposal.capability,
          task: proposal.task,
          gists: [...proposal.gists],
          sourceSessions: [...proposal.sourceSessions],
        }))
      const { admitted, duplicates } = await store.admit(inputs)
      return {
        kind: 'success',
        text: `Admitted ${admitted.length} benchmark task${admitted.length === 1 ? '' : 's'}`
        + `, ${duplicates.length} duplicate${duplicates.length === 1 ? '' : 's'} skipped.`,
      }
    }
    if (verb === 'promote') {
      if (args.length < 2 || args.length > 3) return { kind: 'error', text: BENCHMARK_USAGE }
      const id = args[1] as string
      const current = store.tasks().find(task => task.id === id)
      if (current === undefined) return { kind: 'error', text: `evolution-benchmark: unknown task '${id}'` }
      const target = args[2] === undefined ? nextLadder(current.state) : args[2] as BenchmarkState | undefined
      if (target === undefined) return { kind: 'error', text: `No promotion from '${current.state}' for '${id}'` }
      const moved = await store.transition(id, target)
      return { kind: 'success', text: `Promoted '${id.slice(0, 8)}' to '${moved.state}'.` }
    }
    if (verb === 'retire') {
      if (args.length !== 2) return { kind: 'error', text: BENCHMARK_USAGE }
      await store.transition(args[1] as string, 'retired')
      return { kind: 'success', text: `Retired '${(args[1] as string).slice(0, 8)}'.` }
    }
    if (verb !== undefined) return { kind: 'error', text: BENCHMARK_USAGE }
    const rows = store.tasks()
    const count = (state: BenchmarkState): number => rows.filter(task => task.state === state).length
    const fresh = rows.filter(task => task.state === 'fresh').slice(0, 10)
    const lines = [
      `Benchmark: ${count('fresh')} fresh, ${count('search')} search, ${count('validation')} validation,`
      + ` ${count('holdout')} holdout, ${count('contaminated')} contaminated, ${count('retired')} retired.`,
      ...fresh.map(task => `- ${task.id.slice(0, 8)} ${task.capability}: ${task.task}`),
    ]
    return { kind: 'success', text: lines.join('\n') }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/curriculum [retire <id>]`: measure current capability gaps from
 * the mounted telemetry and trace seams, stage one grounded task per gap, and
 * list every open proposal — or retire one by id.
 * @param ctx - plugin context carrying the optional curriculum store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeCurriculum(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const store = ctx.get('evolutionCurriculum') as {
    gaps(): Promise<readonly CurriculumGap[]>
    propose(gaps: readonly CurriculumGap[]): Promise<readonly CurriculumProposal[]>
    proposals(): readonly CurriculumProposal[]
    retire(id: string): Promise<CurriculumProposal>
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution curriculum store is not mounted.' }
  const args = splitArgs(invocation.rawInput)
  if (args[0] === 'retire') {
    if (args.length !== 2) return { kind: 'error', text: CURRICULUM_USAGE }
    try {
      const retired = await store.retire(args[1] as string)
      return { kind: 'success', text: `Retired curriculum task '${retired.id.slice(0, 8)}' (${retired.capability}).` }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }
  if (args.length !== 0) return { kind: 'error', text: CURRICULUM_USAGE }
  try {
    const staged = await store.propose(await store.gaps())
    const open = store.proposals().filter(proposal => proposal.state === 'open')
    const lines = staged.length === 0
      ? ['No new tasks staged from the measured gaps.']
      : [`Staged ${staged.length} new task${staged.length === 1 ? '' : 's'}.`]
    if (open.length === 0) lines.push('No open curriculum tasks.')
    for (const proposal of open) {
      lines.push(`- ${proposal.id.slice(0, 8)} ${proposal.capability}: ${proposal.task}`)
    }
    return { kind: 'success', text: lines.join('\n') }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/trace <sessionId>`: project one session's committed log into its
 * structured learning trace and render the ranked failure causes.
 * @param ctx - plugin context carrying the optional trace store.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeTrace(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const args = splitArgs(invocation.rawInput)
  if (args.length !== 1) return { kind: 'error', text: TRACE_USAGE }
  const sessionId = args[0] as string
  const store = ctx.get('evolutionTrace') as { trace(sessionId: string): Promise<TraceRecord | undefined> } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution trace store is not mounted.' }
  try {
    const record = await store.trace(sessionId)
    if (record === undefined) return { kind: 'error', text: `No trace for session '${sessionId}'.` }
    return { kind: 'success', text: renderTrace(record) }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Render one structured trace as operator-facing text: the session header, one
 * line per turn with its request and outcome, one line per tool call, and the
 * ranked root-cause candidates under each failure.
 * @param record - the structured trace to render.
 * @returns the rendered text.
 */
function renderTrace(record: TraceRecord): string {
  const lines: string[] = [
    `Trace of ${record.sessionId}: ${record.turnCount} turn${record.turnCount === 1 ? '' : 's'}`
    + (record.updatedAt === null ? ' (no events)' : `, updated ${record.updatedAt}`),
  ]
  for (const turn of record.turns) {
    const outcome = turn.endedAt === null
      ? 'open'
      : `${turn.endReason ?? 'ended'} (${turn.latencyMs ?? 0}ms)`
    lines.push(`Turn ${turn.turn} [${outcome}]${turn.request === null ? '' : `: ${turn.request}`}`)
    for (const step of turn.steps) {
      for (const call of step.calls) {
        lines.push(call.ok ? `  · ${call.name} ok` : `  · ${call.name} failed: ${call.message}`)
      }
    }
    for (const failure of turn.failures) {
      for (const cause of failure.causes) lines.push(`    ← ${cause.reason}`)
    }
  }
  return lines.join('\n')
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
 * Read one skill's newest measured winner: the first ledger row, newest
 * first, that produced a winner at all. Runs that never scored one carry no
 * score, so they cannot move the frontier.
 * @param rows - the skill's ledger rows, newest first.
 * @returns the winner behind the frontier score, or null when unmeasured.
 */
function newestWinner(rows: readonly ExperimentRecord[]): {
  pass: boolean
  tokens: number
  confidence: { wins: number; runs: number } | null
} | null {
  const measured = rows.find(row => row.winner !== null)
  if (measured?.winner === null || measured?.winner === undefined) return null
  return {
    pass: measured.winner.pass,
    tokens: measured.winner.tokens,
    confidence: measured.confidence === null ? null : { wins: measured.confidence.wins, runs: measured.confidence.runs },
  }
}

/**
 * Execute `/frontier`: rank this scope's skills weakest first from measured
 * evidence — optimizer winners, telemetry failures and coverage, and the top
 * failure observed while each skill was in play. The optimizer and telemetry
 * are required; the catalog only supplies descriptions and feedback only the
 * top failure message, so either degrades to less text rather than an error.
 * @param ctx - plugin context carrying the evolution seams.
 * @param scope - the invoking session's scope.
 * @param invocation - raw command input plus the invoking agent.
 * @returns the command result.
 */
async function executeFrontier(ctx: Context, scope: EvolutionScopeId, invocation: CommandInvocation): Promise<CommandResult> {
  if (splitArgs(invocation.rawInput).length > 0) return { kind: 'error', text: FRONTIER_USAGE }
  const optimizer = ctx.get('evolutionOptimizer') as EvolutionOptimizer | undefined
  if (optimizer === undefined) return { kind: 'error', text: 'The evolution optimizer is not mounted.' }
  const telemetry = ctx.get('evolutionSkillTelemetry')
  if (telemetry === undefined) return { kind: 'error', text: 'Skill telemetry is not mounted. The frontier needs the telemetry store.' }
  const catalog = ctx.get('skills') as SkillCatalog | undefined
  const feedback = ctx.get('evolutionFeedback') as FrontierFeedback | undefined
  const cwd = invocation.agent.session.header.cwd
  const options = cwd === undefined ? { signal: invocation.signal } : { cwd, signal: invocation.signal }
  const byName = new Map(telemetry.entries().map(entry => [entry.name, entry.usage]))
  const names = new Set<string>(byName.keys())
  for (const row of optimizer.experiments(scope, {})) names.add(row.skill)
  const inputs: FrontierInput[] = []
  for (const name of names) {
    const usage = byName.get(name)
    // Archived skills never rank; skip their reads too, not just their rows.
    if (usage?.state === 'archived') continue
    const winner = newestWinner(optimizer.experiments(scope, { skill: name }))
    const sessionIds = usage === undefined ? [] : [...usage.sessionIds]
    const top = feedback !== undefined && sessionIds.length > 0
      ? feedback.signals(sessionIds, 1)[0]?.message ?? null
      : null
    inputs.push({
      name,
      description: catalog === undefined ? undefined : (await catalog.get(name, options))?.description,
      // The archived skip above means no archived input ever reaches the ranker.
      archived: false,
      useCount: usage?.useCount ?? 0,
      failureCount: usage?.failureCount ?? 0,
      trustFailures: usage?.trustFailures ?? 0,
      sessions: sessionIds.length,
      winner,
      topFailure: top,
    })
  }
  const rows = rankFrontier(inputs)
  if (rows.length === 0) return { kind: 'success', text: 'No measured capabilities yet.' }
  return {
    kind: 'success',
    text: [
      `Frontier (weakest first): ${rows.length}`,
      ...rows.map((row) => {
        const confidence = row.confidence === null ? '' : ` ${row.confidence}`
        const failures = row.failures === 0
          ? ''
          : ` · ${row.failures} failure${row.failures === 1 ? '' : 's'}${row.topFailure === null ? '' : ` (top: '${row.topFailure}')`}`
        const description = row.description === undefined ? '' : `: ${row.description}`
        const loads = `${row.loads} load${row.loads === 1 ? '' : 's'} in ${row.sessions} session${row.sessions === 1 ? '' : 's'}`
        return `- ${row.name}: ${row.score}${confidence}${failures} · ${loads}${description}`
      }),
      'Weakest first: failing without a passing winner, then unmeasured, then passing.',
    ].join('\n'),
  }
}

/**
 * Execute `/curator`: dispatch to the handler for each sub-verb. Pin and
 * unpin only need telemetry, optimize needs the optimizer and a scope, and
 * every other verb requires the curator.
 * @param ctx - plugin context carrying the optional curator, telemetry, and optimizer.
 * @param profile - configured scope namespace for the optimize scope.
 * @param invocation - raw command input.
 * @returns the command result.
 */
async function executeCurator(ctx: Context, profile: string, invocation: CommandInvocation): Promise<CommandResult> {
  const args = splitArgs(invocation.rawInput)
  const verb = args[0]
  const rest = args.slice(1)
  if (verb === undefined) return { kind: 'error', text: CURATOR_USAGE }

  // Pin/unpin and the version registry read only telemetry, not the curator.
  if (verb === 'pin' || verb === 'unpin' || verb === 'history') {
    if (rest.length !== 1) return { kind: 'error', text: CURATOR_USAGE }
    const telemetry = ctx.get('evolutionSkillTelemetry')
    if (telemetry === undefined) return { kind: 'error', text: 'Skill telemetry is not mounted. Pin, unpin, and history require the telemetry store.' }
    const name = rest[0] as string
    if (verb === 'pin') return executeCuratorPin(telemetry, name)
    if (verb === 'unpin') return executeCuratorUnpin(telemetry, name)
    return executeCuratorHistory(telemetry, name)
  }
  // Optimize needs the optimizer and a scope, not the curator.
  if (verb === 'experiments') {
    if (rest.length > 1) return { kind: 'error', text: CURATOR_USAGE }
    return executeCuratorExperiments(ctx, profile, invocation, rest[0])
  }
  if (verb === 'optimize') {
    const skill = rest[0]
    if (skill === undefined || rest.length < 2) return { kind: 'error', text: CURATOR_USAGE }
    return executeCuratorOptimize(ctx, profile, invocation, skill, rest.slice(1))
  }
  switch (verb) {
    case 'status': if (rest.length > 0) return { kind: 'error', text: CURATOR_USAGE }; break
    case 'run': if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--dry-run')) return { kind: 'error', text: CURATOR_USAGE }; break
    case 'adopt': if (rest.length !== 1) return { kind: 'error', text: CURATOR_USAGE }; break
    case 'purge': if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--dry-run')) return { kind: 'error', text: CURATOR_USAGE }; break
    case 'rollback': if (rest.length !== 2 || rest[0] !== '--id') return { kind: 'error', text: CURATOR_USAGE }; break
    case 'ledger': if (rest.length > 0) return { kind: 'error', text: CURATOR_USAGE }; break
    case 'staged': if (rest.length > 0) return { kind: 'error', text: CURATOR_USAGE }; break
    default: return { kind: 'error', text: CURATOR_USAGE }
  }

  const curator = ctx.get('evolutionCurator')
  if (curator === undefined) return { kind: 'error', text: 'The evolution curator is not mounted.' }

  switch (verb) {
    case 'status': return executeCuratorStatus(ctx, curator, invocation.signal)
    case 'run': return runCuratorPass(curator, rest[0] === '--dry-run')
    case 'adopt': return executeCuratorAdopt(curator, rest[0] as string)
    case 'purge': return executeCuratorPurge(curator, rest[0] === '--dry-run')
    case 'rollback': return executeCuratorRollback(curator, rest[1] as string)
    case 'ledger': return executeCuratorLedger(curator)
    case 'staged': return executeCuratorStaged(curator)
    default: return { kind: 'error', text: CURATOR_USAGE }
  }
}

/**
 * Execute `/curator optimize <skill> <scenario...>`: run one offline
 * optimization and report its outcome. A staged winner names its entry id;
 * anything else names the reason no patch was staged.
 * @param ctx - plugin context carrying the optional optimizer.
 * @param profile - configured scope namespace for the staged patch.
 * @param invocation - raw command input plus the invoking agent.
 * @param skill - skill to optimize.
 * @param scenarios - corpus scenario names, in run order.
 * @returns the command result.
 */
async function executeCuratorOptimize(
  ctx: Context,
  profile: string,
  invocation: CommandInvocation,
  skill: string,
  scenarios: string[],
): Promise<CommandResult> {
  const optimizer = ctx.get('evolutionOptimizer') as EvolutionOptimizer | undefined
  if (optimizer === undefined) return { kind: 'error', text: 'The evolution optimizer is not mounted.' }
  const membership = await resolveMembership(ctx, invocation.agent.session)
  if (membership === undefined) return { kind: 'error', text: 'This session is outside any workspace scope.' }
  const scope = EvolutionScopeId(profile, String(membership.id))
  const proposer = String(invocation.agent.session.id)
  let report: OptimizeReport
  try {
    report = await optimizer.optimize({
      skill,
      scenarios,
      scopeId: scope,
      originSessionId: proposer,
      signal: invocation.signal,
    })
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
  if (report.status === 'staged' && report.stagedId !== null) {
    // The staged patch is a candidate under §53: the session that proposed it
    // is recorded against the run, so the promotion that reviews it can show
    // its reviewer to be a different identity.
    await recordProposerDuty(ctx, report.stagedId, proposer)
    const holdout = report.holdout === null
      ? ''
      : ` Holdout: ${String(report.holdout.winner.pass)} pass at ${report.holdout.winner.tokens} tokens vs baseline ${String(report.holdout.baseline.pass)} pass at ${report.holdout.baseline.tokens} tokens.`
    return {
      kind: 'success',
      text: `Optimized '${skill}': staged skill patch ${report.stagedId}.${holdout} Write the skill with skill_manage, then '/skills approve ${report.stagedId}' to drop the entry.`,
    }
  }
  const stagnant = report.stagnant
    ? ' Recent runs promoted nothing, so it drew candidates from the operators they had not used.'
    : ''
  return { kind: 'success', text: `Optimized '${skill}': ${report.reason ?? report.status}.${stagnant}` }
}

/**
 * Execute `/curator experiments [skill]`: read the scope's optimization
 * ledger, newest first, so a human sees what was tried before spending on
 * another run. An empty ledger says so rather than reporting a bare zero.
 * @param ctx - plugin context carrying the optional optimizer.
 * @param profile - configured scope namespace the runs staged into.
 * @param invocation - raw command input plus the invoking agent.
 * @param skill - skill to read, or undefined for the whole scope.
 * @returns the command result.
 */
async function executeCuratorExperiments(
  ctx: Context,
  profile: string,
  invocation: CommandInvocation,
  skill: string | undefined,
): Promise<CommandResult> {
  const optimizer = ctx.get('evolutionOptimizer') as EvolutionOptimizer | undefined
  if (optimizer === undefined) return { kind: 'error', text: 'The evolution optimizer is not mounted.' }
  const membership = await resolveMembership(ctx, invocation.agent.session)
  if (membership === undefined) return { kind: 'error', text: 'This session is outside any workspace scope.' }
  const scope = EvolutionScopeId(profile, String(membership.id))
  const rows = optimizer.experiments(scope, skill === undefined ? {} : { skill })
  if (rows.length === 0) {
    return {
      kind: 'success',
      text: skill === undefined
        ? 'No optimizations recorded in this scope.'
        : `No optimizations recorded for '${skill}'.`,
    }
  }
  const lines = rows.map((row) => {
    const operators = row.operators.length === 0 ? '' : ` [${row.operators.join('+')}]`
    const staged = row.stagedId === null
      ? ''
      : ` ${row.stagedId}${row.winnerOperator === null ? '' : ` via ${row.winnerOperator}`}`
    const change = row.addedLines > 0 || row.removedLines > 0 ? ` +${row.addedLines}/-${row.removedLines}` : ''
    const confidence = row.confidence === null ? '' : ` ${row.confidence.wins}/${row.confidence.runs}`
    const reason = row.reason === null ? '' : ` — ${row.reason}`
    return `${row.at} ${row.skill}: ${row.outcome}${operators}${staged}${change}${confidence}${reason}`
  })
  return { kind: 'success', text: [`Experiments (newest first): ${rows.length}`, ...lines].join('\n') }
}

/**
 * Execute `/curator status`: bookkeeping, tracked-skill counts, and the two
 * dashboard rates (today's cache-hit share from the usage ledger, aggregate
 * skill failure rate from telemetry). Either rate reports its missing source
 * rather than a number it cannot prove.
 * @param ctx - plugin context carrying the optional telemetry and ledger.
 * @param curator - the mounted curator service.
 * @param signal - caller cancellation for the ledger read.
 * @returns the command result.
 */
async function executeCuratorStatus(ctx: Context, curator: EvolutionCurator, signal: AbortSignal): Promise<CommandResult> {
  const telemetry = ctx.get('evolutionSkillTelemetry')
  const entries = telemetry?.entries() ?? []
  const state = (lifecycle: SkillLifecycleState): number =>
    entries.filter(entry => entry.usage.state === lifecycle).length
  const loads = entries.reduce((sum, entry) => sum + entry.usage.useCount + (entry.usage.failureCount ?? 0), 0)
  const failures = entries.reduce((sum, entry) => sum + (entry.usage.failureCount ?? 0), 0)
  const ledger = ctx.get('usageLedger')
  const today = ledger === undefined ? undefined : await ledger.summary('today', signal)
  const passes = await curator.passes()
  const staged = await curator.staged()
  const worst = staged[0]
  const newest = passes[0]
  const lines = [
    `Curator: last pass ${curator.lastRunAt() ?? 'never'}`,
    telemetry === undefined
      ? 'Tracked skills: unavailable (skill telemetry is not mounted).'
      : `Tracked skills: ${entries.length} (active ${state('active')}, suspect ${state('suspect')}, stale ${state('stale')}, archived ${state('archived')}, pinned ${entries.filter(entry => entry.usage.pinned).length}) · trust: ${entries.filter(entry => entry.usage.trust === 'provisional').length} provisional, ${entries.filter(entry => entry.usage.trust === 'trusted').length} trusted`,
    today === undefined
      ? 'Cache hit (today): unavailable (usage ledger is not mounted).'
      : `Cache hit (today): ${Math.round(today.totals.cacheHitAvg * 100)}% (${today.totals.requests} requests)`,
    telemetry === undefined
      ? 'Skill failure rate: unavailable (skill telemetry is not mounted).'
      : loads === 0
        ? 'Skill failure rate: no recorded loads.'
        : `Skill failure rate: ${Math.round((failures / loads) * 100)}% across ${entries.length} skills (${loads} loads)`,
    worst === undefined
      ? 'Staged for review: 0'
      : `Staged for review: ${staged.length} · worst ${worst.name} (${Math.round(worst.failureRate * 100)}%)`,
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
      report.staged.length === 0
        ? 'Staged for review: none'
        : `Staged for review: ${plural(report.staged.length, 'skill')} (${report.staged.map(candidate => candidate.name).join(', ')})`,
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
        ...(report.restoredFiles.length === 0 ? [] : [`Restored bodies: ${report.restoredFiles.join(', ')}`]),
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
 * Execute `/curator staged`: list the skills staged for review, worst first.
 * @param curator - the mounted curator service.
 * @returns the command result.
 */
async function executeCuratorStaged(curator: EvolutionCurator): Promise<CommandResult> {
  const rows = await curator.staged()
  if (rows.length === 0) return { kind: 'success', text: 'No staged skills.' }
  const lines = rows.map(row => `- ${row.name}: ${row.reason} (staged ${row.at})`)
  return { kind: 'success', text: [`${rows.length} staged skill${rows.length === 1 ? '' : 's'}:`, ...lines].join('\n') }
}

/**
 * Execute `/curator history <name>`: list one skill's committed body
 * revisions, oldest first, with the lineage each row records.
 * @param telemetry - the mounted telemetry service.
 * @param name - skill name.
 * @returns the command result.
 */
function executeCuratorHistory(
  telemetry: { versions(name: string): readonly SkillVersion[] },
  name: string,
): CommandResult {
  const rows = telemetry.versions(name)
  if (rows.length === 0) return { kind: 'success', text: `No recorded revisions for '${name}'.` }
  const lines = rows.map((row) => {
    const parent = row.parentRevisionSha === null
      ? ''
      : ` ← r${row.revision - 1} ${row.parentRevisionSha.slice(0, 8)}`
    return `- r${row.revision} ${row.contentSha.slice(0, 8)}${parent} (${row.at})`
  })
  return { kind: 'success', text: [`${rows.length} revision${rows.length === 1 ? '' : 's'} for '${name}':`, ...lines].join('\n') }
}

/**
 * Execute `/curator pin <name>`: pin a tracked skill.
 * @param telemetry - the mounted telemetry service.
 * @param rest - argument words after the verb.
 * @returns the command result.
 */
async function executeCuratorPin(
  telemetry: { setPinned(name: string, pinned: boolean): Promise<SkillUsageRecord> },
  name: string,
): Promise<CommandResult> {
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
async function executeCuratorUnpin(
  telemetry: { setPinned(name: string, pinned: boolean): Promise<SkillUsageRecord> },
  name: string,
): Promise<CommandResult> {
  try {
    await telemetry.setPinned(name, false)
    return { kind: 'success', text: `Unpinned '${name}'` }
  } catch (err: unknown) {
    return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Run one dreaming phase, or the whole cycle, for the invoking scope.
 * @param ctx - plugin context carrying the dreaming service and the registry.
 * @param scope - scope identity resolved from the invoking session.
 * @param membership - the workspace the invoking session belongs to.
 * @param invocation - raw command input and the invoking session.
 * @returns the command result.
 */
async function executeDream(
  ctx: Context,
  scope: EvolutionScopeIdBrand,
  membership: ScopeMembership,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const dreaming = ctx.get('evolutionDreaming')
  if (dreaming === undefined) return { kind: 'error', text: 'Dreaming consolidation is not mounted.' }
  const [phase, ...rest] = splitArgs(invocation.rawInput)
  const phases: readonly string[] = ['light', 'rem', 'deep']
  if (rest.length > 0 || (phase !== undefined && !phases.includes(phase))) {
    return { kind: 'error', text: DREAM_USAGE }
  }
  // The cycle scans the sessions this workspace owns; a workspace with none
  // simply has nothing to consolidate.
  const sessionIds = (ctx.workspaceRegistry.get(membership.id)?.sessionIds ?? []).map(id => String(id))
  try {
    if (phase !== undefined) {
      const report = await dreaming.run(phase as 'light' | 'rem' | 'deep', scope, sessionIds)
      return {
        kind: 'success',
        text: `Dream ${report.phase}: scanned ${report.scanned}, staged ${report.staged},`
        + ` promoted ${report.promoted}, pruned ${report.pruned}.`,
      }
    }
    const report = await dreaming.dream(scope, sessionIds)
    const themes = dreaming.read(scope)?.narratives[0]?.themes ?? []
    const top = themes.slice(0, 3).map(theme => `${theme.key} (${theme.candidates})`).join(', ')
    return {
      kind: 'success',
      text: `Dream cycle: scanned ${report.scanned}, staged ${report.staged},`
      + ` promoted ${report.promoted}, pruned ${report.pruned}.`
      + (top.length === 0 ? '' : `\nTop themes: ${top}.`),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Whether one argument names a §28 routing role.
 * @param candidate - the argument to test.
 * @returns true when the argument is a routing role.
 */
function isRoutingRole(candidate: string | undefined): candidate is RoutingRole {
  return candidate !== undefined && (ROUTING_ROLES as readonly string[]).includes(candidate)
}

/**
 * Report the budget allocations the optimizer recorded, one batch at a time
 * with its candidate class, ceilings, and exact settlement, or the recorded
 * spends of one batch. The settlement arithmetic comes from the budget
 * package's own `settle`, so the margins here are the ones the engine spent
 * against.
 * @param ctx - plugin context carrying the budget seam.
 * @param invocation - raw command input.
 * @returns the command result.
 */
function executeBudget(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionBudget') as {
    batches(taskClass?: string): readonly BudgetAllocation[]
    spends(batchId?: string): readonly SpendRecord[]
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution budget store is not mounted.' }
  const [verb, ...rest] = splitArgs(invocation.rawInput)
  try {
    if (verb === 'spends') {
      if (rest.length > 1) return { kind: 'error', text: BUDGET_USAGE }
      const rows = store.spends(rest[0]).slice(0, 20)
      if (rows.length === 0) return { kind: 'success', text: 'No recorded budget spends.' }
      return {
        kind: 'success',
        text: [
          `${rows.length} spend${rows.length === 1 ? '' : 's'}:`,
          ...rows.map(row => `- ${row.batchId}: ${row.tokens} tokens, ${row.wallTimeMs}ms, ${row.rollouts} rollout${row.rollouts === 1 ? '' : 's'} at ${row.at}`),
        ].join('\n'),
      }
    }
    if (verb !== undefined) return { kind: 'error', text: BUDGET_USAGE }
    const allocations = store.batches()
    if (allocations.length === 0) {
      return { kind: 'success', text: 'No recorded budget allocations. The optimizer records one allocation per candidate batch.' }
    }
    const lines = allocations.map((allocation) => {
      const settlement = settle(allocation, store.spends(allocation.batchId))
      const over = settlement.exceededTokens > 0 || settlement.exceededWallTimeMs > 0
      return `- ${allocation.batchId} (${allocation.candidateClass}, ${allocation.taskClass}):`
        + ` ${settlement.tokens}/${allocation.maxTokens} tokens, ${settlement.wallTimeMs}/${allocation.maxWallTimeMs}ms`
        + (over
          ? ` — EXCEEDED by ${settlement.exceededTokens} tokens, ${settlement.exceededWallTimeMs}ms`
          : ` — ${settlement.remainingTokens} tokens, ${settlement.remainingWallTimeMs}ms left`)
        // §37's later dimensions are only rendered when the allocation priced
        // them, so a batch written before them reads exactly as it did.
        + renderBudgetMargins(settlement)
    })
    return { kind: 'success', text: [`Budget (${allocations.length} batch${allocations.length === 1 ? '' : 'es'}):`, ...lines].join('\n') }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Render the §37 dimensions a settlement priced beyond tokens and wall time:
 * cost, deadline, and concurrency. A dimension the allocation did not price,
 * or one nothing recorded, is named rather than shown as a zero it cannot
 * prove.
 * @param settlement - the settlement to render.
 * @returns the rendered suffix, empty when the allocation priced none of them.
 */
function renderBudgetMargins(settlement: BudgetSettlement): string {
  const parts: string[] = []
  for (const [label, unit, margin] of [
    ['cost', '', settlement.cost],
    ['time', 'ms', settlement.time],
    ['parallelism', '', settlement.parallelism],
  ] as const) {
    if (margin.budgeted === null) continue
    parts.push(margin.spent === null
      ? `${label} unmeasured (ceiling ${margin.budgeted}${unit})`
      : `${label} ${margin.spent}/${margin.budgeted}${unit}`
        + (margin.exceeded !== null && margin.exceeded > 0
          ? ` — EXCEEDED by ${margin.exceeded}${unit}`
          : ` — ${margin.remaining ?? 0}${unit} left`))
  }
  return parts.length === 0 ? '' : ` · ${parts.join(', ')}`
}

/**
 * Report the engine runs recorded under their configurations, the derived
 * per-configuration summaries, or the configuration the store recommends for
 * one task class. The recommendation is a record, not a policy: nothing here
 * changes what the optimizer runs next.
 * @param ctx - plugin context carrying the meta seam.
 * @param invocation - raw command input.
 * @returns the command result.
 */
function executeMeta(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionMeta') as {
    runs(taskClass?: string): readonly EngineRun[]
    summaries(taskClass?: string): readonly ConfigSummary[]
    recommend(taskClass: string): ConfigRecommendation | undefined
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution meta store is not mounted.' }
  const [verb, ...rest] = splitArgs(invocation.rawInput)
  try {
    if (verb === 'recommend') {
      if (rest.length !== 1) return { kind: 'error', text: META_USAGE }
      const taskClass = rest[0] as string
      const recommendation = store.recommend(taskClass)
      if (recommendation === undefined) {
        return { kind: 'success', text: `No configuration has enough recorded runs on '${taskClass}' to recommend yet.` }
      }
      return {
        kind: 'success',
        text: [
          `Recommended engine configuration for '${taskClass}': ${recommendation.configId}`,
          `operators ${recommendation.config.operators}, evaluator ${recommendation.config.evaluator},`
          + ` budget ${recommendation.config.budget}, routing ${recommendation.config.routing}`,
          recommendation.workflow.length === 0
            ? 'workflow: unrecorded'
            : `workflow: ${recommendation.workflow.map(step => `${step.component}=${step.choice}`).join('>')}`,
          recommendation.reason,
        ].join('\n'),
      }
    }
    if (verb === 'runs') {
      if (rest.length > 1) return { kind: 'error', text: META_USAGE }
      const rows = store.runs(rest[0]).slice(0, 10)
      if (rows.length === 0) return { kind: 'success', text: 'No recorded engine runs.' }
      return {
        kind: 'success',
        text: [
          `${rows.length} engine run${rows.length === 1 ? '' : 's'}:`,
          ...rows.map(row => `- ${row.runId} (${row.taskClass}) ${row.pass ? 'pass' : 'fail'},`
            + ` ${row.tokens} tokens, ${row.wallTimeMs}ms at ${row.at}`),
        ].join('\n'),
      }
    }
    if (verb !== undefined && verb !== 'summaries') return { kind: 'error', text: META_USAGE }
    if (verb === 'summaries' && rest.length > 1) return { kind: 'error', text: META_USAGE }
    const rows = store.summaries(rest[0])
    if (rows.length === 0) {
      return { kind: 'success', text: 'No engine-configuration summaries. The optimizer records one run per staged write.' }
    }
    return {
      kind: 'success',
      text: [
        `Engine configurations${rest[0] === undefined ? '' : ` for '${rest[0]}'`} (best score first): ${rows.length}`,
        ...rows.map(row => `- ${row.configId} (${row.taskClass}): ${Math.round(row.passRate * 100)}% pass over ${row.samples}`
          + ` run${row.samples === 1 ? '' : 's'}, ${Math.round(row.meanTokens)} mean tokens, score ${row.score.toFixed(3)}`),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Report the mutation-operator statistics recorded for one artifact class and
 * the exploration-adjusted ranking that says which operator to try next.
 * @param ctx - plugin context carrying the operators seam.
 * @param invocation - raw command input.
 * @returns the command result.
 */
function executeOperators(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionOperators') as {
    stats(artifactClass?: string): readonly OperatorStats[]
    ranking(artifactClass: string): readonly OperatorRanking[]
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution operators store is not mounted.' }
  const [artifactClass, ...rest] = splitArgs(invocation.rawInput)
  try {
    if (artifactClass === undefined) {
      const rows = store.stats()
      if (rows.length === 0) {
        return { kind: 'success', text: 'No recorded operator statistics. The optimizer records every staged write\'s operator and outcome.' }
      }
      const classes = [...new Set(rows.map(row => row.artifactClass))].sort()
      return {
        kind: 'success',
        text: [
          `Operator statistics span ${classes.length} artifact class${classes.length === 1 ? '' : 'es'}: ${classes.join(', ')}.`,
          'Name one class to rank its operators.',
        ].join('\n'),
      }
    }
    if (rest.length > 0) return { kind: 'error', text: OPERATORS_USAGE }
    const ranking = store.ranking(artifactClass)
    if (ranking.length === 0) return { kind: 'success', text: `No operator statistics recorded for '${artifactClass}'.` }
    // The ranking carries the exploration-adjusted score and the acceptance
    // numbers; the regression rate stays on the statistics rows, so join them
    // rather than recomputing either.
    const regressionsByOperator = new Map(store.stats(artifactClass).map(row => [row.operator, row.regressionRate]))
    return {
      kind: 'success',
      text: [
        `Operator ranking for '${artifactClass}' (best first):`,
        ...ranking.map(row => `- ${row.operator}: ${row.attempts} attempt${row.attempts === 1 ? '' : 's'},`
          + ` ${Math.round(row.acceptanceRate * 100)}% accepted, mean delta ${row.meanDelta.toFixed(2)},`
          + ` ${Math.round((regressionsByOperator.get(row.operator) ?? 0) * 100)}% regressions,`
          + ` score ${row.score.toFixed(3)}`),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Report the measured route effectiveness for the task classes and roles the
 * optimizer recorded, or the route the store recommends for one pair.
 * @param ctx - plugin context carrying the router seam.
 * @param invocation - raw command input.
 * @returns the command result.
 */
function executeRouter(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionRouter') as {
    effectiveness(taskClass?: string, role?: string): readonly RouteEffectiveness[]
    recommend(taskClass: string, role: string): RouteRankingEntry | undefined
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution router store is not mounted.' }
  const [verb, ...rest] = splitArgs(invocation.rawInput)
  try {
    if (verb === 'recommend') {
      if (rest.length !== 2 || !isRoutingRole(rest[1])) return { kind: 'error', text: ROUTER_USAGE }
      const taskClass = rest[0] as string
      const role = rest[1]
      const recommendation = store.recommend(taskClass, role)
      if (recommendation === undefined) {
        return { kind: 'success', text: `No route has enough recorded outcomes on '${taskClass}' for ${role} to recommend yet.` }
      }
      return {
        kind: 'success',
        text: [
          `Recommended route for ${role} on '${taskClass}': ${recommendation.provider}/${recommendation.model}`,
          recommendation.reason,
        ].join('\n'),
      }
    }
    if (verb !== undefined && verb !== 'effectiveness') return { kind: 'error', text: ROUTER_USAGE }
    if (verb === 'effectiveness' && (rest.length > 2 || (rest.length === 2 && !isRoutingRole(rest[1])))) {
      return { kind: 'error', text: ROUTER_USAGE }
    }
    const rows = store.effectiveness(rest[0], rest[1])
    if (rows.length === 0) {
      return { kind: 'success', text: 'No recorded route outcomes. The optimizer records the evaluation route of every staged write.' }
    }
    return {
      kind: 'success',
      text: [
        `${rows.length} route row${rows.length === 1 ? '' : 's'}:`,
        ...rows.map(row => `- ${row.provider}/${row.model} (${row.role}, ${row.taskClass}):`
          + ` ${Math.round(row.passRate * 100)}% pass over ${row.samples},`
          + ` ${Math.round(row.meanTokens)} mean tokens, ${Math.round(row.meanWallTimeMs)}ms mean`),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Report the trust statistics recorded for each evaluator on one task class,
 * or the ranking that says which evaluator to trust. Trust comes from verdicts
 * later judged against an independent ground truth, not from how often the
 * evaluator ran.
 * @param ctx - plugin context carrying the evaluator-strategy seam.
 * @param invocation - raw command input.
 * @returns the command result.
 */
function executeEvaluatorStrategy(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionEvaluatorStrategy') as {
    strategies(taskClass?: string): readonly EvaluatorStrategy[]
    ranking(taskClass: string): readonly StrategyRanking[]
  } | undefined
  if (store === undefined) return { kind: 'error', text: 'The evolution evaluator-strategy store is not mounted.' }
  const [verb, ...rest] = splitArgs(invocation.rawInput)
  try {
    if (verb === 'rank') {
      if (rest.length !== 1) return { kind: 'error', text: EVALUATOR_STRATEGY_USAGE }
      const taskClass = rest[0] as string
      const ranking = store.ranking(taskClass)
      if (ranking.length === 0) return { kind: 'success', text: `No evaluator strategy recorded for '${taskClass}'.` }
      return {
        kind: 'success',
        text: [
          `Evaluator ranking for '${taskClass}' (most trusted first):`,
          ...ranking.map(row => `- ${row.evaluator}: ${row.corroborations}/${row.independentSamples} independent corroborations`
            + ` over ${row.samples} verdict${row.samples === 1 ? '' : 's'}, weight ${row.weight.toFixed(3)}`),
        ].join('\n'),
      }
    }
    if (verb !== undefined && verb !== 'strategies') return { kind: 'error', text: EVALUATOR_STRATEGY_USAGE }
    if (verb === 'strategies' && rest.length > 1) return { kind: 'error', text: EVALUATOR_STRATEGY_USAGE }
    const rows = store.strategies(rest[0])
    if (rows.length === 0) {
      return { kind: 'success', text: 'No evaluator strategy recorded. The optimizer pairs each verdict with its holdout ground truth.' }
    }
    return {
      kind: 'success',
      text: [
        `${rows.length} evaluator strategy row${rows.length === 1 ? '' : 's'}:`,
        ...rows.map(row => `- ${row.evaluator} (${row.taskClass}): ${row.corroborations}/${row.independentSamples} independent`
          + ` corroborations over ${row.samples} verdict${row.samples === 1 ? '' : 's'}, weight ${row.weight.toFixed(3)} at ${row.lastAt}`),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Render one metric's number or the record it is missing. A measured value
 * carries the store it was read from; an unmeasured one carries the gap, so
 * the report never shows a zero where nothing was recorded.
 * @param entry - the metric to render.
 * @returns the report lines for this metric.
 */
function renderMetric(entry: MetricValue): string[] {
  if (entry.value === null) return [`- ${entry.id}: not measured — ${entry.unavailableReason ?? 'no reason recorded'}`]
  const line = `- ${entry.id}: ${formatMetricValue(entry.value, entry.unit)}`
    + (entry.caveat === null ? '' : ` — ${entry.caveat}`)
  return [line, `  from ${entry.inputs.join('; ')}`]
}

/**
 * Render one measured number in the unit the metric is read in.
 * @param value - the measurement.
 * @param unit - how the metric is read.
 * @returns the number as displayed.
 */
function formatMetricValue(value: number, unit: MetricUnit): string {
  if (unit === 'share') return `${(value * 100).toFixed(1)}%`
  if (unit === 'count') return String(value)
  if (unit === 'ratio') return `${value.toFixed(2)}x`
  return String(Number(value.toPrecision(4)))
}

/**
 * Report the north-star metric — capability gain per unit of compute — and
 * the supporting metrics over the recorded engine runs, optionally for one
 * task class. The metric layer owns every number: this command only renders
 * what it measured and, for each metric it could not measure, the record that
 * is missing.
 * @param ctx - plugin context carrying the metric layer.
 * @param invocation - raw command input.
 * @returns the command result.
 */
function executeMetrics(ctx: Context, invocation: CommandInvocation): CommandResult {
  const store = ctx.get('evolutionMetrics')
  if (store === undefined) return { kind: 'error', text: 'The evolution metric layer is not mounted.' }
  const [taskClass, ...rest] = splitArgs(invocation.rawInput)
  if (rest.length > 0) return { kind: 'error', text: METRICS_USAGE }
  try {
    const report = store.report(taskClass === undefined ? {} : { taskClass })
    const { window } = report
    const scope = window.taskClass === null ? '' : ` for '${window.taskClass}'`
    const capability = window.baselinePassRate === null || window.treatmentPassRate === null
      ? `Capability: not measured — the window holds ${window.baselineRuns} older and ${window.treatmentRuns} newer runs`
      : `Capability: ${formatMetricValue(window.baselinePassRate, 'share')} → ${formatMetricValue(window.treatmentPassRate, 'share')}`
        + ` over ${window.baselineRuns} older and ${window.treatmentRuns} newer runs`
    return {
      kind: 'success',
      text: [
        `Metric window${scope}: ${window.runs} run${window.runs === 1 ? '' : 's'}`
        + (window.from === null ? '' : ` from ${window.from} to ${window.to}`),
        capability,
        'North star:',
        ...report.northStar.flatMap(renderMetric),
        'Supporting:',
        ...report.supporting.flatMap(renderMetric),
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
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
  kind: 'memory' | 'refine' | 'journey' | 'skills' | 'graph' | 'claims' | 'reflection' | 'trajectory' | 'dream' | 'frontier' | 'trace' | 'curriculum' | 'benchmark' | 'evaluators' | 'population' | 'routes' | 'canary' | 'novelty' | 'stagnation' | 'islands' | 'selfmodel' | 'uncertainty' | 'adversary' | 'lineage' | 'sleeptime' | 'budget' | 'meta' | 'operators' | 'router' | 'evaluator-strategy' | 'metrics',
  invocation: CommandInvocation,
): Promise<CommandResult> {
  // Exporting the invoking session needs no workspace, so `/trajectory`
  // decides for itself whether it must resolve one; `/trace` names a session
  // and `/curriculum` is host-wide, so neither needs a workspace.
  if (kind === 'trajectory') return executeTrajectory(ctx, profile, invocation)
  if (kind === 'trace') return executeTrace(ctx, invocation)
  if (kind === 'curriculum') return executeCurriculum(ctx, invocation)
  if (kind === 'benchmark') return executeBenchmark(ctx, invocation)
  if (kind === 'evaluators') return executeEvaluators(ctx, invocation)
  if (kind === 'population') return executePopulation(ctx, invocation)
  if (kind === 'routes') return executeRoutes(ctx, invocation)
  if (kind === 'canary') return executeCanary(ctx, invocation)
  if (kind === 'novelty') return executeNovelty(ctx, invocation)
  if (kind === 'stagnation') return executeStagnation(ctx, invocation)
  if (kind === 'islands') return executeIslands(ctx, invocation)
  if (kind === 'selfmodel') return executeSelfModel(ctx, invocation)
  if (kind === 'uncertainty') return executeUncertainty(ctx, invocation)
  if (kind === 'adversary') return executeAdversary(ctx, invocation)
  if (kind === 'lineage') return executeLineage(ctx, invocation)
  if (kind === 'sleeptime') return executeSleeptime(ctx, invocation)
  if (kind === 'budget') return executeBudget(ctx, invocation)
  if (kind === 'meta') return executeMeta(ctx, invocation)
  if (kind === 'operators') return executeOperators(ctx, invocation)
  if (kind === 'router') return executeRouter(ctx, invocation)
  if (kind === 'evaluator-strategy') return executeEvaluatorStrategy(ctx, invocation)
  if (kind === 'metrics') return executeMetrics(ctx, invocation)
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
    case 'graph':
      return executeGraph(ctx, scope, invocation)
    case 'claims':
      return executeClaims(ctx, scope, invocation)
    case 'reflection':
      return executeReflection(ctx, membership, invocation)
    case 'dream':
      return executeDream(ctx, scope, membership, invocation)
    case 'frontier':
      return executeFrontier(ctx, scope, invocation)
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
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/graph'),
      name: 'graph',
      description: 'Query the scope knowledge graph',
      input: { hint: '<entity> [relation]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'graph', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/claims'),
      name: 'claims',
      description: 'List the scope\'s active claims, most believed first',
      input: { hint: '[query]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'claims', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/reflection'),
      name: 'reflection',
      description: 'Show the stored failure reflections for this scope',
      input: { hint: '[limit]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'reflection', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/curator'),
      name: 'curator',
      description: 'Manage skill curation: status, pass history, adopt, purge, pin, rollback, and optimize',
      input: { hint: 'status | run | adopt <name> | purge | rollback | ledger | pin <name> | optimize <skill> <scenario...> | experiments [skill]' },
      handler: (invocation: CommandInvocation) => track(executeCurator(ctx, profile, invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/dream'),
      name: 'dream',
      description: 'Consolidate recorded failures into durable scope memory',
      input: { hint: '[light|rem|deep]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'dream', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/trajectory'),
      name: 'trajectory',
      description: 'Export this session or this scope as share-ready conversations',
      input: { hint: '[--out <path>] [--all]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'trajectory', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/trace'),
      name: 'trace',
      description: 'Project one session into its structured learning trace with ranked failure causes',
      input: { hint: '<sessionId>' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'trace', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/curriculum'),
      name: 'curriculum',
      description: 'Stage training and evaluation tasks from measured capability gaps',
      input: { hint: '[retire <id>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'curriculum', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/benchmark'),
      name: 'benchmark',
      description: 'Manage the evaluation-task benchmark: admit curriculum proposals and promote tasks along the learning ladder',
      input: { hint: '[admit | promote <id> [state] | retire <id>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'benchmark', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/evaluators'),
      name: 'evaluators',
      description: 'Report evaluator ensemble health: agreement, approval drift, false positives, and per-channel rates',
      input: { hint: '[runs [<skill>]]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'evaluators', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/population'),
      name: 'population',
      description: 'List a skill\'s candidate population, walk one lineage, or approve and reject staged candidates',
      input: { hint: '<skill> [lineage <id> | approve <id> | reject <id>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'population', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/routes'),
      name: 'routes',
      description: 'List or pin adaptive model routes per evolutionary role and read their measured evidence',
      input: { hint: '[pin <role> <provider> <model> | evidence [<role>]]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'routes', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/canary'),
      name: 'canary',
      description: 'Track shadow/canary rollouts of staged skill patches: list states, rollout, promote, reject, or roll back',
      input: { hint: '[status [<skill>] | rollout <id> | promote <id> | reject <id> | rollback <id>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'canary', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/novelty'),
      name: 'novelty',
      description: 'Summarize the novelty archive or list one skill\'s behavior descriptors with their archive novelty',
      input: { hint: '[<skill>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'novelty', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/stagnation'),
      name: 'stagnation',
      description: 'Report stagnation across skills, one skill\'s standing with its recommended strategy, runs, or reset a skill\'s history',
      input: { hint: '[status <skill> | runs [<skill>] | reset <skill>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'stagnation', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/islands'),
      name: 'islands',
      description: 'List evolution islands with their migration schedule, register a lane, record a candidate migration, or read the migration log',
      input: { hint: '[list [<skill>] | register <island> <name> <objective> <skill> | migrate <from> <to> <candidate> [<reason>] | migrations [<skill>]]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'islands', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/selfmodel'),
      name: 'selfmodel',
      description: 'Show one skill\'s controlled self-assessment or the weakest-first capability frontier with the next capability to learn',
      input: { hint: '[<skill>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'selfmodel', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/uncertainty'),
      name: 'uncertainty',
      description: 'Show the prioritized queue of high-value evaluation tasks derived from recorded uncertainty signals',
      input: { hint: '[<skill>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'uncertainty', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/adversary'),
      name: 'adversary',
      description: 'Record adversarial probes, mark them repaired, read the next probing challenge, or track the evaluator-gaming defense checklist',
      input: { hint: '[list [<skill>] | probe <skill> <category> <probe> | repair <probeId> | challenge <skill> | defenses | defense <name> <satisfied>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'adversary', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/lineage'),
      name: 'lineage',
      description: 'List dependency-versioned experiment envelopes, prove two experiments comparable, or replay one from its record',
      input: { hint: '[list [<skill>] | compare <idA> <idB> | replay <id>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'lineage', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/sleeptime'),
      name: 'sleeptime',
      description: 'List anticipated future tasks, precomputed reasoning artifacts, or the offline-cost plan for sleep-time compute',
      input: { hint: '[tasks [<domain>] | artifacts [<taskId>] | plan]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'sleeptime', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/budget'),
      name: 'budget',
      description: 'Report the evolution budget: one allocation per candidate batch with its class, ceilings, and exact settlement, or the recorded spends',
      input: { hint: '[spends [<batchId>]]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'budget', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/meta'),
      name: 'meta',
      description: 'Report engine runs under their configurations, the derived pass rates, or the configuration recommended for a task class',
      input: { hint: '[summaries [<taskClass>] | runs [<taskClass>] | recommend <taskClass>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'meta', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/operators'),
      name: 'operators',
      description: 'Rank the mutation operators recorded for one artifact class by acceptance, mean delta, and regression rate',
      input: { hint: '<artifactClass>' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'operators', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/router'),
      name: 'router',
      description: 'Report measured route effectiveness per task class and evolutionary role, or the route the store recommends',
      input: { hint: '[effectiveness [<taskClass>] [<role>] | recommend <taskClass> <role>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'router', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/evaluator-strategy'),
      name: 'evaluator-strategy',
      description: 'Report evaluator trust earned from verdicts later judged against independent ground truth, or rank the evaluators of one task class',
      input: { hint: '[strategies [<taskClass>] | rank <taskClass>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'evaluator-strategy', invocation)),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/metrics'),
      name: 'metrics',
      description: 'Report capability gain per unit of compute and the supporting metrics, each measured or naming the record it is missing',
      input: { hint: '[<taskClass>]' },
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'metrics', invocation)),
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
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-evolution/frontier'),
      name: 'frontier',
      description: 'Rank this scope\'s capabilities weakest first from measured evidence',
      handler: (invocation: CommandInvocation) => track(handleCommand(ctx, profile, 'frontier', invocation)),
    })
  }, 'command-evolution lifecycle')
}

