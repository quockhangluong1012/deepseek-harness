import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionMemoryRecord, EvolutionScopeId as ScopeId, LessonArtifactInput, LessonDecision } from '@deepseek-ai/dsh-evolution-memory'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import EvolutionGraph from '@deepseek-ai/dsh-evolution-graph'
import type {} from '@deepseek-ai/dsh-evolution-reviewer'
import type { PassSummary, PurgeReport, RollbackReport, StagedCandidate, StagedSkill } from '@deepseek-ai/dsh-evolution-curator'
import type { SkillUsageRecord, SkillVersion } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { TraceRecord } from '@deepseek-ai/dsh-evolution-trace'
import type { CurriculumProposal } from '@deepseek-ai/dsh-evolution-curriculum'
import type { BenchmarkInput, BenchmarkState, BenchmarkTask } from '@deepseek-ai/dsh-evolution-benchmark'
import type { EvaluatorHealthSummary, EvaluatorRun } from '@deepseek-ai/dsh-evolution-evaluator-health'
import type { PopulationCandidate, PopulationStatus } from '@deepseek-ai/dsh-evolution-population'
import { separationOfDuties } from '@deepseek-ai/dsh-evolution-model-routes'
import type { DutyDecision, DutyRecord, ModelRoute, RouteEvidence, RouteRow, RouteSummary } from '@deepseek-ai/dsh-evolution-model-routes'
import type { DeploymentRecord, DeploymentState } from '@deepseek-ai/dsh-evolution-canary'
import type { NoveltyArchiveEntry } from '@deepseek-ai/dsh-evolution-novelty-search'
import type { StagnationRun, StagnationStatus } from '@deepseek-ai/dsh-evolution-stagnation'
import type { BudgetAllocation, SpendRecord } from '@deepseek-ai/dsh-evolution-budget'
import type { ConfigRecommendation, ConfigSummary, EngineRun } from '@deepseek-ai/dsh-evolution-meta'
import EvolutionMetrics from '@deepseek-ai/dsh-evolution-metrics'
import type { OperatorRanking, OperatorStats } from '@deepseek-ai/dsh-evolution-operators'
import type { RouteEffectiveness, RouteRankingEntry, RoutingRole } from '@deepseek-ai/dsh-evolution-router'
import type { EvaluatorStrategy, StrategyRanking } from '@deepseek-ai/dsh-evolution-evaluator-strategy'
import type { IslandInput, IslandSchedule, Migration, MigrationInput } from '@deepseek-ai/dsh-evolution-islands'
import { dayKeyUTC7 } from '@deepseek-ai/dsh-usage-ledger'
import { unzipSync, strFromU8 } from 'fflate'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as commandEvolution from '../src/index.ts'
import { buildLearnPrompt, stagedFailureText } from '../src/index.ts'

interface ReviewerStub {
  calls: { scope: unknown; signal: AbortSignal }[]
  operation: (() => Promise<undefined>) | undefined
  failure: unknown
}

/** Curator and telemetry state the `/curator` command reads, when provided. */
interface GovernanceStubs {
  lastRunAt?: string | null
  passes?: PassSummary[]
  entries?: { name: string; usage: SkillUsageRecord }[]
  /** Dry-run flags passed to `run`, in call order. */
  runs?: boolean[]
  /** Tracked-skill count the fake pass reports. */
  scanned?: number
  /** Movements the fake pass reports. */
  transitions?: { name: string; from: string; to: string; reason: string }[]
  skippedPinned?: number
  skippedProtected?: number
  skippedExcluded?: number
  passId?: string | null
  /** Skills the fake pass stages for review. */
  stagedSkills?: StagedCandidate[]
  /** Skills the fake `staged` read returns, worst first. */
  staged?: StagedSkill[]
  /** Names passed to `adopt`, in call order. */
  adoptCalls?: string[]
  /** Error `adopt` throws, or the record it returns. */
  adoptResult?: SkillUsageRecord | Error
  /** Dry-run flags passed to `purge`, in call order. */
  purgeCalls?: boolean[]
  /** Outcome `purge` reports. */
  purgeResult?: PurgeReport
  /** Pass ids passed to `rollbackPass`, in call order. */
  rollbackCalls?: string[]
  /** Error `rollbackPass` throws, or the report it returns. */
  rollbackResult?: RollbackReport | Error
  /** (name, pinned) pairs passed to `setPinned`, in call order. */
  setPinnedCalls?: { name: string; pinned: boolean }[]
  /** Error `setPinned` throws. */
  setPinnedError?: Error
  /** Version history `versions` reports for any name. */
  versionsResult?: SkillVersion[]
}

/** Which optional stores and stubs the harness mounts for one spec. */
interface HarnessExtras {
  trajectory?: boolean
  skills?: boolean
  graph?: boolean
  dream?: boolean
  trace?: boolean
  curriculum?: boolean
  benchmark?: boolean
  evaluatorHealth?: boolean
  population?: boolean
  routes?: boolean
  canary?: boolean
  novelty?: boolean
  stagnation?: boolean
  islands?: boolean
  selfModel?: boolean
  uncertainty?: boolean
  adversary?: boolean
  lineage?: boolean
  sleeptime?: boolean
  budget?: boolean
  meta?: boolean
  operators?: boolean
  router?: boolean
  evaluatorStrategy?: boolean
  metrics?: boolean
  reflection?: boolean
}

/** Trajectory-export state the `/trajectory` command reads, when provided. */
interface TrajectoryStub {
  /** Session exports in call order. */
  sessions: { sessionId: string; options: { out?: string } | undefined }[]
  /** Scope exports in call order. */
  scopes: { scopeId: string; options: { out?: string } | undefined }[]
  /** Export outcome reported for both verbs. */
  result?: { path: string; conversations: number; bytes: number }
  /** When set, both verbs reject with this value. */
  failure?: unknown
}

/** Trace-projection state the `/trace` command reads, when provided. */
interface TraceStub {
  /** Session ids asked about, in call order. */
  asked: string[]
  /** Record reported for any session; undefined reports a missing session. */
  record?: TraceRecord
  /** When set, `trace` rejects with this value. */
  failure?: unknown
}

/** Curriculum state the `/curriculum` command reads, when provided. */
interface CurriculumStub {
  /** How many times `gaps` was called. */
  gapsCalls: number
  /** Proposals `propose` returns as newly staged. */
  staged: CurriculumProposal[]
  /** Proposals `proposals` lists. */
  open: CurriculumProposal[]
  /** Ids passed to `retire`. */
  retired: string[]
  /** When set, `retire` rejects with this value. */
  retireError?: unknown
}

/** Evaluator-health state the `/evaluators` command reads, when provided. */
interface EvaluatorHealthStub {
  /** Summary `summary` reports. */
  summary?: EvaluatorHealthSummary
  /** Runs `runs` lists. */
  runs: EvaluatorRun[]
}

/** Reflection state the `/reflection` command reads, when provided. */
interface ReflectionStub {
  /** Rows `reflections` returns. */
  rows?: readonly {
    symptom: string
    violatedExpectation: string
    rootCause: string | null
    correctedStrategy: string | null
    antiPattern: string | null
    reusableWhen: string | null
    candidateTest: string | null
    confidence: number
  }[]
}

/** Benchmark state the `/benchmark` command reads, when provided. */
interface BenchmarkStub {
  /** Inputs passed to `admit`, in call order. */
  admitted: BenchmarkInput[][]
  /** New tasks `admit` reports. */
  admittedCount: number
  /** Duplicate texts `admit` reports. */
  duplicates: string[]
  /** Tasks `tasks` lists. */
  tasks: BenchmarkTask[]
  /** (id, to) pairs passed to `transition`, in call order. */
  transitions: { id: string; to: BenchmarkState }[]
  /** When set, `transition` rejects with this value. */
  transitionError?: unknown
}

/** Population state the `/population` command reads, when provided. */
interface PopulationStub {
  /** Candidates `candidates` lists per skill. */
  candidates: Record<string, PopulationCandidate[]>
  /** (skill, candidateId) pairs passed to `lineage`, in call order. */
  lineageCalls: { skill: string; candidateId: string }[]
  /** Lineage `lineage` reports by (skill, candidateId). */
  lineages: Record<string, PopulationCandidate[]>
  /** (candidateId, status) pairs passed to `updateStatus`, in call order. */
  statusCalls: { candidateId: string; status: PopulationStatus }[]
  /** When set, `updateStatus` rejects with this value. */
  statusError?: unknown
}

/** Model-routes state the `/routes` command reads, when provided. */
interface RoutesStub {
  /** Summaries `routes` lists per role. */
  summaries: RouteSummary[]
  /** Evidence `evidence` lists. */
  evidence: RouteEvidence[]
  /** (role, provider, model) triples passed to `pin`, in call order. */
  pins: { role: string; provider: string; model: string }[]
  /** Recommendation `recommend` reports per role. */
  recommend?: (role: string) => ModelRoute | undefined
  /** When set, `pin` rejects with this value. */
  pinError?: unknown
  /** §53 role fills recorded through `recordDuty`, newest fill per run and role. */
  duties: DutyRecord[]
  /** When set, `recordDuty` rejects with this value. */
  dutyError?: unknown
}

/** Canary state the `/canary` command reads, when provided. */
interface CanaryStub {
  /** Records `deployments` lists. */
  records: DeploymentRecord[]
  /** (id, to) pairs passed to `advance`, in call order. */
  advances: { id: string; to: DeploymentState }[]
  /** When set, `advance` rejects with this value. */
  advanceError?: unknown
}

/** Novelty-archive state the `/novelty` command reads, when provided. */
interface NoveltyStub {
  /** Entries `entries` lists. */
  entries: NoveltyArchiveEntry[]
  /** Means `mean` reports per skill; a missing skill reads zero. */
  means: Record<string, number>
}

/** Stagnation state the `/stagnation` command reads, when provided. */
interface StagnationStub {
  /** Runs `runs` lists. */
  runs: StagnationRun[]
  /** Statuses `status` reports per skill; a missing skill reads an empty status. */
  statuses: Record<string, StagnationStatus>
  /** Skills passed to `reset`, in call order. */
  resets: string[]
  /** When set, `reset` rejects with this value. */
  resetError?: unknown
}

/** Islands state the `/islands` command reads, when provided. */
interface IslandsStub {
  /** Schedule rows `schedule` lists. */
  schedule: IslandSchedule[]
  /** Migrations `migrations` lists. */
  migrations: Migration[]
  /** Register inputs passed to `register`, in call order. */
  registers: IslandInput[]
  /** Migrate inputs passed to `migrate`, in call order. */
  migrateCalls: MigrationInput[]
  /** When set, `migrate` rejects with this value. */
  migrateError?: unknown
  /** When set, `register` rejects with this value. */
  registerError?: unknown
}

/** Self-model state the `/selfmodel` command reads, when provided. */
interface SelfModelStub {
  /** Assessments `assessment` reports per skill; a missing skill reads undefined. */
  assessments: Record<string, unknown>
  /** Capability gaps `gaps` lists. */
  gaps: unknown[]
  /** Capability `nextToLearn` names, or null. */
  next: unknown
}

/** Uncertainty state the `/uncertainty` command reads, when provided. */
interface UncertaintyStub {
  /** Queue rows `queue` reports per skill; a missing skill reads the full queue. */
  queue: unknown[]
}

/** Adversary state the `/adversary` command reads, when provided. */
interface AdversaryStub {
  /** Probes `probes` lists. */
  probes: unknown[]
  /** Probes passed to `probe`, in call order. */
  probeCalls: Record<string, unknown>[]
  /** (probeId, repaired) pairs passed to `setRepaired`, in call order. */
  repairs: string[]
  /** Challenge `challenge` reports per skill. */
  challenges: Record<string, unknown>
  /** Defenses `defenses` lists. */
  defenses: unknown[]
  /** (defense, satisfied) pairs passed to `setDefense`, in call order. */
  defenseSets: { defense: string; satisfied: boolean }[]
  /** When set, `setRepaired` rejects with this value. */
  repairError?: unknown
}

/** Lineage state the `/lineage` command reads, when provided. */
interface LineageStub {
  /** Envelopes `experiments` lists. */
  experiments: unknown[]
  /** Compare verdicts `compare` reports by `<a>/<b>`. */
  comparisons: Record<string, unknown>
  /** Envelope `replay` reports per id; a missing id reads undefined. */
  replays: Record<string, unknown>
  /** (id, outcome, rejectedReason) triples passed to `amendOutcome`, in call order. */
  amendments: { id: string; outcome: string; rejectedReason: string | undefined }[]
  /** When set, `amendOutcome` rejects with this value. */
  amendError?: unknown
}

/** Sleeptime state the `/sleeptime` command reads, when provided. */
interface SleeptimeStub {
  /** Tasks `tasks` lists. */
  tasks: unknown[]
  /** Artifacts `artifacts` lists. */
  artifacts: unknown[]
  /** Plan rows `plan` reports. */
  plan: unknown[]
}

/** Budget state the `/budget` command reads, when provided. */
interface BudgetStub {
  /** Allocations `batches` lists. */
  batches: BudgetAllocation[]
  /** Spends `spends` lists. */
  spends: SpendRecord[]
}

/** Meta state the `/meta` command reads, when provided. */
interface MetaStub {
  /** Runs `runs` lists. */
  runs: EngineRun[]
  /** Summaries `summaries` lists. */
  summaries: ConfigSummary[]
  /** Recommendations `recommend` reports per task class. */
  recommendations: Record<string, ConfigRecommendation>
}

/** Operator state the `/operators` command reads, when provided. */
interface OperatorsStub {
  /** Statistics `stats` lists. */
  stats: OperatorStats[]
  /** Rankings `ranking` reports per artifact class. */
  rankings: Record<string, OperatorRanking[]>
}

/** Router state the `/router` command reads, when provided. */
interface RouterStub {
  /** Effectiveness rows `effectiveness` lists. */
  effectiveness: RouteEffectiveness[]
  /** Recommendations `recommend` reports by `<taskClass>/<role>`. */
  recommendations: Record<string, RouteRankingEntry>
}

/** Evaluator-strategy state the `/evaluator-strategy` command reads, when provided. */
interface EvaluatorStrategyStub {
  /** Strategy rows `strategies` lists. */
  strategies: EvaluatorStrategy[]
  /** Rankings `ranking` reports per task class. */
  rankings: Record<string, StrategyRanking[]>
}

/** Skill-catalog state the `/suggestions` command reads, when provided. */
interface SkillsStub {
  /** Summaries `list` reports, in order. */
  summaries: { name: string; description: string }[]
  /** Definitions `get` reports by name; a missing name reads as undefined. */
  definitions: Record<string, unknown>
  /** Lookup options `list` received, in call order. */
  lists: { cwd?: string }[]
  /** Names `get` received, in call order. */
  gets: string[]
}

interface DreamingStub {
  runs: Array<{ phase: string; scopeId: string; sessionIds: string[] }>
  cycles: Array<{ scopeId: string; sessionIds: string[] }>
  failure?: Error
  record?: { narratives: Array<{ themes: Array<{ key: string; candidates: number }> }> }
}

interface Harness {
  ctx: Context
  plugin: Awaited<ReturnType<Context['plugin']>>
  workspaces: Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>
  dir: string
  reviewer: ReviewerStub
  trajectory: TrajectoryStub
  trace: TraceStub
  curriculum: CurriculumStub
  benchmark: BenchmarkStub
  evaluatorHealth: EvaluatorHealthStub
  /** Stored reflections `/reflection` reads. */
  reflection: ReflectionStub
  population: PopulationStub
  routes: RoutesStub
  canary: CanaryStub
  novelty: NoveltyStub
  stagnation: StagnationStub
  islands: IslandsStub
  selfModel: SelfModelStub
  uncertainty: UncertaintyStub
  adversary: AdversaryStub
  lineage: LineageStub
  sleeptime: SleeptimeStub
  budget: BudgetStub
  meta: MetaStub
  operators: OperatorsStub
  router: RouterStub
  evaluatorStrategy: EvaluatorStrategyStub
  skills: SkillsStub
  dream: DreamingStub
  /** Ordinary turns the invoking agent queued. */
  followups: unknown[]
  scope: (name: string) => ScopeId
}

async function harness(
  withReviewer = true,
  governance?: GovernanceStubs,
  extra: HarnessExtras = {},
): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'evc-')))
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const { default: EvolutionMemoryStore } = await import('@deepseek-ai/dsh-evolution-memory')
  await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 65536 })
  await ctx.plugin(SessionStore)
  const workspaces = new Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>()
  ctx.provide('workspaceRegistry', {
    list: () => [...workspaces.values()],
    get: (id: WorkspaceId) => workspaces.get(String(id)),
  } as never)
  const reviewer: ReviewerStub = { calls: [], operation: undefined, failure: undefined }
  if (withReviewer) {
    ctx.provide('evolutionReviewer', {
      rebuild: async (scopeId: unknown, signal: AbortSignal) => {
        reviewer.calls.push({ scope: scopeId, signal })
        if (reviewer.operation !== undefined) return reviewer.operation()
        if (reviewer.failure !== undefined) throw reviewer.failure
      },
    } as never)
  }
  if (
    governance?.entries !== undefined
    || governance?.setPinnedCalls !== undefined
    || governance?.setPinnedError !== undefined
    || governance?.versionsResult !== undefined
  ) {
    ctx.provide('evolutionSkillTelemetry', {
      entries: () => governance.entries ?? [],
      versions: (name: string) => (governance.versionsResult ?? []).filter(row => row.name === name),
      setPinned: async (name: string, pinned: boolean) => {
        governance.setPinnedCalls?.push({ name, pinned })
        if (governance.setPinnedError !== undefined) throw governance.setPinnedError
        return usageRecord({ pinned })
      },
    } as never)
  }
  if (governance !== undefined) {
    ctx.provide('evolutionCurator', {
      lastRunAt: () => governance.lastRunAt ?? null,
      passes: async () => governance.passes ?? [],
      staged: async () => governance.staged ?? [],
      run: async (options: { dryRun?: boolean } = {}) => {
        governance.runs?.push(options.dryRun === true)
        return {
          at: '2026-09-12T01:00:00.000Z',
          dryRun: options.dryRun === true,
          scanned: governance.scanned ?? 0,
          transitions: governance.transitions ?? [],
          skippedPinned: governance.skippedPinned ?? 0,
          skippedProtected: governance.skippedProtected ?? 0,
          skippedExcluded: governance.skippedExcluded ?? 0,
          passId: options.dryRun === true ? null : governance.passId ?? null,
          snapshot: null,
          staged: governance.stagedSkills ?? [],
        }
      },
      adopt: async (name: string) => {
        governance.adoptCalls?.push(name)
        if (governance.adoptResult instanceof Error) throw governance.adoptResult
        return governance.adoptResult ?? { useCount: 0, viewCount: 0, patchCount: 0, lastUsedAt: null, sessionIds: [], sessionOutcomes: [], lastViewedAt: null, lastPatchedAt: null, createdAt: '2026-01-01T00:00:00.000Z', state: 'active', pinned: false, createdBy: 'agent', absorbedInto: null, archivedAt: null, suspectAt: null, trust: 'provisional', trustFailures: 0, trustObservedSessions: [], trustAnchorSessionId: null, lastTrustFailure: null, revision: 1, contentSha: 'sha', parentRevisionSha: null } satisfies SkillUsageRecord
      },
      purge: async (options: { dryRun?: boolean } = {}) => {
        governance.purgeCalls?.push(options.dryRun === true)
        return governance.purgeResult ?? { at: '2026-09-12T01:00:00.000Z', dryRun: options.dryRun === true, purged: [], skippedPinned: 0 }
      },
      rollbackPass: async (passId: string) => {
        governance.rollbackCalls?.push(passId)
        if (governance.rollbackResult instanceof Error) throw governance.rollbackResult
        return governance.rollbackResult ?? { at: '2026-09-12T01:00:00.000Z', label: `pass '${passId}'`, restored: [], preRollback: 'sha', restoredDirs: [], restoredFiles: [] }
      },
    } as never)
  }
  const trajectory: TrajectoryStub = { sessions: [], scopes: [] }
  if (extra.trajectory === true) {
    ctx.provide('evolutionTrajectory', {
      exportSession: async (sessionId: string, options: { out?: string } | undefined) => {
        trajectory.sessions.push({ sessionId, options })
        if (trajectory.failure !== undefined) throw trajectory.failure
        return trajectory.result ?? { path: 'session.zip', conversations: 1, bytes: 10 }
      },
      exportScope: async (scopeId: string, options: { out?: string } | undefined) => {
        trajectory.scopes.push({ scopeId, options })
        if (trajectory.failure !== undefined) throw trajectory.failure
        return trajectory.result ?? { path: 'scope.zip', conversations: 2, bytes: 20 }
      },
    } as never)
  }
  const trace: TraceStub = { asked: [] }
  if (extra.trace === true) {
    ctx.provide('evolutionTrace', {
      trace: async (sessionId: string) => {
        trace.asked.push(sessionId)
        if (trace.failure !== undefined) throw trace.failure
        return trace.record
      },
    } as never)
  }
  const curriculum: CurriculumStub = { gapsCalls: 0, staged: [], open: [], retired: [] }
  if (extra.curriculum === true) {
    ctx.provide('evolutionCurriculum', {
      gaps: async () => {
        curriculum.gapsCalls += 1
        return []
      },
      propose: async () => curriculum.staged,
      proposals: () => curriculum.open,
      retire: async (id: string) => {
        curriculum.retired.push(id)
        if (curriculum.retireError !== undefined) throw curriculum.retireError
        return { id, capability: 'x', task: 't', sourceSessions: [], gists: [], at: '2026-09-12T00:00:00.000Z', state: 'retired' }
      },
    } as never)
  }
  const benchmark: BenchmarkStub = { admitted: [], admittedCount: 0, duplicates: [], tasks: [], transitions: [] }
  if (extra.benchmark === true) {
    ctx.provide('evolutionBenchmark', {
      admit: async (inputs: BenchmarkInput[]) => {
        benchmark.admitted.push([...inputs])
        return {
          admitted: Array.from({ length: benchmark.admittedCount }, (_, i) => `t${i}`) as unknown as BenchmarkTask[],
          duplicates: benchmark.duplicates,
        }
      },
      tasks: () => benchmark.tasks,
      transition: async (id: string, to: BenchmarkState) => {
        benchmark.transitions.push({ id, to })
        if (benchmark.transitionError !== undefined) throw benchmark.transitionError
        return { id, hash: 'h', capability: 'x', task: 't', gists: [], sourceSessions: [], at: 't', state: to } as BenchmarkTask
      },
    } as never)
  }
  const evaluatorHealth: EvaluatorHealthStub = { runs: [] }
  if (extra.evaluatorHealth === true) {
    ctx.provide('evolutionEvaluatorHealth', {
      summary: () => evaluatorHealth.summary ?? {
        runs: 0,
        unanimousRate: 0,
        approvalRate: 0,
        recentApprovalRate: 0,
        drift: 0,
        falsePositiveRate: 0,
        channels: [
          { channel: 'contract', runs: 0, approved: 0, approvalRate: 0 },
          { channel: 'routing', runs: 0, approved: 0, approvalRate: 0 },
          { channel: 'replay', runs: 0, approved: 0, approvalRate: 0 },
        ],
      },
      runs: (skill?: string) => evaluatorHealth.runs.filter(run => skill === undefined || run.skill === skill),
    } as never)
  }
  const population: PopulationStub = { candidates: {}, lineageCalls: [], lineages: {}, statusCalls: [] }
  if (extra.population === true) {
    ctx.provide('evolutionPopulation', {
      candidates: (skill?: string) => skill === undefined
        ? Object.values(population.candidates).flat()
        : population.candidates[skill] ?? [],
      lineage: (skill: string, candidateId: string) => {
        population.lineageCalls.push({ skill, candidateId })
        return population.lineages[`${skill}/${candidateId}`] ?? []
      },
      elite: (skill: string) => (population.candidates[skill] ?? [])
        .filter(candidate => candidate.status === 'approved'),
      updateStatus: async (candidateId: string, status: PopulationStatus) => {
        population.statusCalls.push({ candidateId, status })
        if (population.statusError !== undefined) throw population.statusError
        return { candidateId, skill: 'writer', parentCandidateId: null, operator: 'rewrite', generation: 1, novelty: 0.5, triple: { pass: true, tokens: 3, wallTimeMs: 5 }, status, at: '2026-09-12T00:00:00.000Z' }
      },
    } as never)
  }
  const routes: RoutesStub = { summaries: [], evidence: [], pins: [], duties: [] }
  if (extra.routes === true) {
    ctx.provide('evolutionModelRoutes', {
      routes: (role?: string) => role === undefined
        ? routes.summaries
        : routes.summaries.filter(summary => summary.role === role),
      evidence: (role?: string, route?: ModelRoute) => routes.evidence.filter(row =>
        (role === undefined || row.role === role)
        && (route === undefined || (row.provider === route.provider && row.model === route.model))),
      pin: async (role: string, provider: string, model: string) => {
        routes.pins.push({ role, provider, model })
        if (routes.pinError !== undefined) throw routes.pinError
        return { role: role as RouteRow['role'], provider, model, origin: 'pinned', at: '2026-09-12T00:00:00.000Z' }
      },
      recommend: (role: string) => routes.recommend?.(role),
      // §53's two calls over the same stub state, with the package's own rule
      // answering the check so the stub records fills without restating policy.
      recordDuty: async (input: { runId: string; role: DutyRecord['role']; identity: string }) => {
        if (routes.dutyError !== undefined) throw routes.dutyError
        const row: DutyRecord = { ...input, at: '2026-09-12T00:00:00.000Z' }
        routes.duties = routes.duties.filter(duty => duty.runId !== input.runId || duty.role !== input.role)
        routes.duties.push(row)
        return row
      },
      checkDuties: (runId: string, decision: DutyDecision) =>
        separationOfDuties(routes.duties.filter(duty => duty.runId === runId), runId, decision),
    } as never)
  }
  const canary: CanaryStub = { records: [], advances: [] }
  if (extra.canary === true) {
    ctx.provide('evolutionCanary', {
      deployments: (state?: string, skill?: string) => canary.records.filter(record =>
        (state === undefined || record.state === state)
        && (skill === undefined || record.skill === skill)),
      advance: async (id: string, to: DeploymentState) => {
        canary.advances.push({ id, to })
        if (canary.advanceError !== undefined) throw canary.advanceError
        return {
          id,
          skill: 'writer',
          state: to,
          triple: null,
          at: '2026-09-12T00:00:00.000Z',
          enteredAt: '2026-09-12T00:00:00.000Z',
          decidedAt: null,
        }
      },
    } as never)
  }
  const novelty: NoveltyStub = { entries: [], means: {} }
  if (extra.novelty === true) {
    ctx.provide('evolutionNovelty', {
      entries: (skill?: string) => novelty.entries.filter(entry => skill === undefined || entry.skill === skill),
      mean: (skill: string) => novelty.means[skill] ?? 0,
    } as never)
  }
  const stagnation: StagnationStub = { runs: [], statuses: {}, resets: [] }
  if (extra.stagnation === true) {
    ctx.provide('evolutionStagnation', {
      runs: (skill?: string) => stagnation.runs.filter(run => skill === undefined || run.skill === skill),
      status: (skill: string) => stagnation.statuses[skill] ?? {
        skill,
        runs: 0,
        bestScore: null,
        generationsSinceImprovement: 0,
        stagnant: false,
        threshold: 5,
        strategy: 'exploitation',
      },
      reset: async (skill: string) => {
        stagnation.resets.push(skill)
        if (stagnation.resetError !== undefined) throw stagnation.resetError
        return 2
      },
    } as never)
  }
  const islands: IslandsStub = { schedule: [], migrations: [], registers: [], migrateCalls: [] }
  if (extra.islands === true) {
    ctx.provide('evolutionIslands', {
      register: async (input: IslandInput) => {
        islands.registers.push(input)
        if (islands.registerError !== undefined) throw islands.registerError
        return {
          islandId: input.islandId,
          name: input.name,
          objective: input.objective,
          skill: input.skill,
          generation: 0,
          lastActivityAt: null,
          at: '2026-09-12T00:00:00.000Z',
        }
      },
      migrate: async (input: MigrationInput) => {
        islands.migrateCalls.push(input)
        if (islands.migrateError !== undefined) throw islands.migrateError
        return {
          migrationId: 'mig-1',
          fromIslandId: input.fromIslandId,
          toIslandId: input.toIslandId,
          candidateId: input.candidateId,
          skill: 'writer',
          reason: input.reason,
          at: '2026-09-12T00:00:00.000Z',
        }
      },
      migrations: (skill?: string) => islands.migrations.filter(migration => skill === undefined || migration.skill === skill),
      schedule: (skill?: string) => islands.schedule.filter(row => skill === undefined || row.island.skill === skill),
    } as never)
  }
  const selfModel: SelfModelStub = { assessments: {}, gaps: [], next: null }
  if (extra.selfModel === true) {
    ctx.provide('evolutionSelfModel', {
      assessment: (skill: string) => selfModel.assessments[skill],
      gaps: () => selfModel.gaps,
      nextToLearn: () => selfModel.next,
    } as never)
  }
  const uncertainty: UncertaintyStub = { queue: [] }
  if (extra.uncertainty === true) {
    ctx.provide('evolutionUncertainty', {
      queue: (skill?: string) => uncertainty.queue.filter(row =>
        (skill === undefined || (row as { skill: string }).skill === skill)),
    } as never)
  }
  const adversary: AdversaryStub = { probes: [], probeCalls: [], repairs: [], challenges: {}, defenses: [], defenseSets: [] }
  if (extra.adversary === true) {
    ctx.provide('evolutionAdversary', {
      probes: (skill?: string) => adversary.probes.filter(probe =>
        (skill === undefined || (probe as { skill: string }).skill === skill)),
      probe: async (input: Record<string, unknown>) => {
        adversary.probeCalls.push(input)
        return { ...input, repaired: false, at: '2026-09-12T00:00:00.000Z' }
      },
      setRepaired: async (probeId: string) => {
        adversary.repairs.push(probeId)
        if (adversary.repairError !== undefined) throw adversary.repairError
        return { probeId, repaired: true }
      },
      challenge: (skill: string) => adversary.challenges[skill] ?? { category: 'edge-case', probed: 0, reason: 'no probe recorded yet' },
      defenses: () => adversary.defenses,
      setDefense: async (defense: string, satisfied: boolean) => {
        adversary.defenseSets.push({ defense, satisfied })
        return { defense, satisfied, at: '2026-09-12T00:00:00.000Z' }
      },
    } as never)
  }
  const lineage: LineageStub = { experiments: [], comparisons: {}, replays: {}, amendments: [] }
  if (extra.lineage === true) {
    ctx.provide('evolutionLineage', {
      experiments: (skill?: string) => lineage.experiments.filter(envelope =>
        (skill === undefined || (envelope as { skill: string }).skill === skill)),
      compare: (idA: string, idB: string) => lineage.comparisons[`${idA}/${idB}`],
      replay: (id: string) => lineage.replays[id],
      amendOutcome: async (id: string, outcome: string, rejectedReason?: string) => {
        lineage.amendments.push({ id, outcome, rejectedReason })
        if (lineage.amendError !== undefined) throw lineage.amendError
        return { experimentId: id, outcome, rejectedReason }
      },
    } as never)
  }
  const sleeptime: SleeptimeStub = { tasks: [], artifacts: [], plan: [] }
  if (extra.sleeptime === true) {
    ctx.provide('evolutionSleeptime', {
      tasks: (domain?: string) => sleeptime.tasks.filter(task =>
        (domain === undefined || (task as { domain: string }).domain === domain)),
      artifacts: (taskId?: string) => sleeptime.artifacts.filter(artifact =>
        (taskId === undefined || (artifact as { taskId: string }).taskId === taskId)),
      plan: () => sleeptime.plan,
    } as never)
  }
  const budget: BudgetStub = { batches: [], spends: [] }
  if (extra.budget === true) {
    ctx.provide('evolutionBudget', {
      batches: (taskClass?: string) => budget.batches.filter(row =>
        (taskClass === undefined || row.taskClass === taskClass)),
      spends: (batchId?: string) => budget.spends.filter(row =>
        (batchId === undefined || row.batchId === batchId)),
    } as never)
  }
  const meta: MetaStub = { runs: [], summaries: [], recommendations: {} }
  if (extra.meta === true) {
    ctx.provide('evolutionMeta', {
      runs: (taskClass?: string) => meta.runs.filter(row =>
        (taskClass === undefined || row.taskClass === taskClass)),
      summaries: (taskClass?: string) => meta.summaries.filter(row =>
        (taskClass === undefined || row.taskClass === taskClass)),
      recommend: (taskClass: string) => meta.recommendations[taskClass],
    } as never)
  }
  const operators: OperatorsStub = { stats: [], rankings: {} }
  if (extra.operators === true) {
    ctx.provide('evolutionOperators', {
      stats: (artifactClass?: string) => operators.stats.filter(row =>
        (artifactClass === undefined || row.artifactClass === artifactClass)),
      ranking: (artifactClass: string) => operators.rankings[artifactClass] ?? [],
    } as never)
  }
  const router: RouterStub = { effectiveness: [], recommendations: {} }
  if (extra.router === true) {
    ctx.provide('evolutionRouter', {
      effectiveness: (taskClass?: string, role?: RoutingRole) => router.effectiveness.filter(row =>
        (taskClass === undefined || row.taskClass === taskClass)
        && (role === undefined || row.role === role)),
      recommend: (taskClass: string, role: RoutingRole) => router.recommendations[`${taskClass}/${role}`],
    } as never)
  }
  const evaluatorStrategy: EvaluatorStrategyStub = { strategies: [], rankings: {} }
  if (extra.evaluatorStrategy === true) {
    ctx.provide('evolutionEvaluatorStrategy', {
      strategies: (taskClass?: string) => evaluatorStrategy.strategies.filter(row =>
        (taskClass === undefined || row.taskClass === taskClass)),
      ranking: (taskClass: string) => evaluatorStrategy.rankings[taskClass] ?? [],
    } as never)
  }
  const dream: DreamingStub = { runs: [], cycles: [] }
  if (extra.dream === true) {
    ctx.provide('evolutionDreaming', {
      run: async (phase: string, scopeId: string, sessionIds: readonly string[]) => {
        dream.runs.push({ phase, scopeId, sessionIds: [...sessionIds] })
        if (dream.failure !== undefined) throw dream.failure
        return { phase, scopeId, scanned: 2, staged: 2, promoted: 1, pruned: 0 }
      },
      dream: async (scopeId: string, sessionIds: readonly string[]) => {
        dream.cycles.push({ scopeId, sessionIds: [...sessionIds] })
        if (dream.failure !== undefined) throw dream.failure
        return { scopeId, scanned: 2, staged: 2, promoted: 1, pruned: 0, phases: [] }
      },
      read: () => dream.record,
    } as never)
  }
  const skills: SkillsStub = { summaries: [], definitions: {}, lists: [], gets: [] }
  if (extra.skills === true) {
    ctx.provide('skills', {
      list: async (options: { cwd?: string } = {}) => {
        skills.lists.push(options)
        return skills.summaries
      },
      get: async (name: string) => {
        skills.gets.push(name)
        return skills.definitions[name]
      },
    } as never)
  }
  if (extra.graph === true) {
    await ctx.plugin(EvolutionGraph, {})
  }
  // The feedback store's reflection read is a seam like any other here: the
  // command renders what the store returns, so a stub names the rows.
  const reflection: ReflectionStub = { rows: [] }
  if (extra.reflection === true) {
    ctx.provide('evolutionFeedback', {
      reflections: async () => reflection.rows ?? [],
    } as never)
  }
  // The metric layer is mounted as itself: it holds no state, so a test that
  // wants a measured number provides the store it reads, like every other
  // optional seam here.
  if (extra.metrics === true) {
    await ctx.plugin(EvolutionMetrics, {})
  }
  const plugin = await ctx.plugin(commandEvolution, { profile: 'test' })
  return {
    ctx,
    plugin,
    workspaces,
    dir,
    reviewer,
    trajectory,
    trace,
    curriculum,
    benchmark,
    evaluatorHealth,
    reflection,
    population,
    routes,
    canary,
    novelty,
    stagnation,
    islands,
    selfModel,
    uncertainty,
    adversary,
    lineage,
    sleeptime,
    budget,
    meta,
    operators,
    router,
    evaluatorStrategy,
    dream,
    skills,
    followups: [],
    scope: (name: string) => EvolutionScopeId('test', name),
  }
}

async function shutdown(test: Harness): Promise<void> {
  await test.plugin.dispose()
  await rm(test.dir, { recursive: true, force: true })
}

function sessionIn(ctx: Context, dir: string, name: string): Session {
  return ctx.sessions.create(SessionId(name), { meta: { cwd: dir } })
}

/**
 * Build the invoking-agent stand-in.
 * @param session - the agent's session.
 * @param followups - sink for the ordinary turns the agent queues.
 * @returns the agent stand-in.
 */
function fakeAgent(session: Session, followups: unknown[] = []): Agent {
  return {
    session,
    status: 'idle',
    options: {},
    reserveTurnAdmission: () => () => undefined,
    followup: (message: unknown) => { followups.push(message) },
  } as unknown as Agent
}

async function run(
  test: Harness,
  session: Session,
  line: string,
  controller = new AbortController(),
): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>> {
  const execution = await test.ctx.commands.execute(fakeAgent(session, test.followups), line, [], controller.signal)
  if (execution === undefined) throw new Error(`command was not registered for '${line}'`)
  return execution
}

function commandIdOf(event: { data: unknown }): unknown {
  return (event.data as { commandId: unknown }).commandId
}

/** One caller-supplied lesson artifact, the shape a staged replace carries. */
function candidate(statement: string): LessonArtifactInput {
  return {
    statement,
    source: 's1',
    conditions: '',
    evidence: 'inference',
    confidence: 0.5,
    scope: 'project',
  }
}

/**
 * A staged payload carrying artifact candidates. `LessonArtifactInput` is a
 * mapped type whose optional `ttlDays` admits `undefined`, so it is not
 * assignable to the store's `JsonValue` payload type even though the value
 * stored is JSON; the store validates the candidate when the entry is
 * approved, so the bridge cast is test-side only.
 * @param value - the payload object to hand the store.
 * @returns the same object typed as a JSON value.
 */
function artifactPayload(value: object): JsonValue {
  return value as unknown as JsonValue
}

/**
 * The stored lessons document as one text: the artifacts' statements joined in
 * stored order. The command suite asserts on the document's content, not on
 * the artifact shell that carries it.
 * @param record - the stored scope record, or undefined when absent.
 * @returns the document text the assertions compare against.
 */
function lessonsOf(record: EvolutionMemoryRecord | undefined): string {
  return (record?.agentLessons ?? []).map(artifact => artifact.statement).join('\n')
}

/**
 * The text of a failed command result, narrowed from the result union.
 * @param result - the command result.
 * @returns the failure text, or the empty string for a successful result.
 */
function errorTextOf(result: CommandResult): string {
  return result.kind === 'error' ? result.text : ''
}

/** One telemetry record carrying the fields `/curator` reads. */
function usageRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    lastUsedAt: null,
    sessionIds: [],
    sessionOutcomes: [],
    lastViewedAt: null,
    lastPatchedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    state: 'active',
    pinned: false,
    createdBy: null,
    absorbedInto: null,
    archivedAt: null,
    suspectAt: null,
    trust: 'trusted',
    trustFailures: 0,
    trustObservedSessions: [],
    trustAnchorSessionId: null,
    lastTrustFailure: null,
    revision: 0,
    contentSha: null,
    parentRevisionSha: null,
    ...overrides,
  }
}

/** Assert the executor-owned lifecycle pair around one result. */
function expectLifecycle(test: Harness, session: Session, name: string, args: string, outcome: CommandResult): void {
  const pair = session.snapshotEvents()
    .filter(event => event.type === 'command/run' || event.type === 'command/done')
    .slice(-2)
  expect(pair).toHaveLength(2)
  const commandId = pair[0] === undefined ? undefined : commandIdOf(pair[0])
  expect(pair.map(event => ({ type: event.type, data: event.data }))).toEqual([
    { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } },
    { type: 'command/done', data: { commandId, ...outcome } },
  ])
  void test
}

describe('@deepseek-ai/dsh-command-evolution registration', () => {
  it('registers memory and refine commands with Loader-safe exports and disposes both', async () => {
    const test = await harness()
    try {
      expect(commandEvolution.name).toBe('command-evolution')
      expect(commandEvolution.inject).toEqual(['commands', 'workspaceRegistry', 'evolutionMemory'])
      expect('default' in commandEvolution).toBe(false)
      const loader = Object.create(Loader.prototype) as Loader
      expect(loader.unwrapExports(commandEvolution)).toBe(commandEvolution)
      const agent = fakeAgent(sessionIn(test.ctx, test.dir, 'list-agent'))
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/memory',
        name: 'memory',
        description: 'Review staged evolution memory writes',
        input: { hint: 'pending | approve <id> | reject <id>' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/refine',
        name: 'refine',
        description: 'Rebuild evolution lessons from session history',
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/journey',
        name: 'journey',
        description: 'Show or export this scope\'s recorded evolution activity',
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/skills',
        name: 'skills',
        description: 'Review staged skill proposals',
        input: { hint: 'pending | approve <id>' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/curator',
        name: 'curator',
        description: 'Manage skill curation: status, pass history, adopt, purge, pin, rollback, and optimize',
        input: { hint: 'status | run | adopt <name> | purge | rollback | ledger | pin <name> | optimize <skill> <scenario...> | experiments [skill]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/trajectory',
        name: 'trajectory',
        description: 'Export this session or this scope as share-ready conversations',
        input: { hint: '[--out <path>] [--all]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/learn',
        name: 'learn',
        description: 'Research a topic and save it as a skill through the gated writer',
        input: { hint: 'What should the harness learn?' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/suggestions',
        name: 'suggestions',
        description: 'List blueprint-backed skills without scheduling them',
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/frontier',
        name: 'frontier',
        description: 'Rank this scope\'s capabilities weakest first from measured evidence',
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/trace',
        name: 'trace',
        description: 'Project one session into its structured learning trace with ranked failure causes',
        input: { hint: '<sessionId>' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/benchmark',
        name: 'benchmark',
        description: 'Manage the evaluation-task benchmark: admit curriculum proposals and promote tasks along the learning ladder',
        input: { hint: '[admit | promote <id> [state] | retire <id>]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/evaluators',
        name: 'evaluators',
        description: 'Report evaluator ensemble health: agreement, approval drift, false positives, and per-channel rates',
        input: { hint: '[runs [<skill>]]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/population',
        name: 'population',
        description: 'List a skill\'s candidate population, walk one lineage, or approve and reject staged candidates',
        input: { hint: '<skill> [lineage <id> | approve <id> | reject <id>]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/routes',
        name: 'routes',
        description: 'List or pin adaptive model routes per evolutionary role and read their measured evidence',
        input: { hint: '[pin <role> <provider> <model> | evidence [<role>]]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/canary',
        name: 'canary',
        description: 'Track shadow/canary rollouts of staged skill patches: list states, rollout, promote, reject, or roll back',
        input: { hint: '[status [<skill>] | rollout <id> | promote <id> | reject <id> | rollback <id>]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/novelty',
        name: 'novelty',
        description: 'Summarize the novelty archive or list one skill\'s behavior descriptors with their archive novelty',
        input: { hint: '[<skill>]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/stagnation',
        name: 'stagnation',
        description: 'Report stagnation across skills, one skill\'s standing with its recommended strategy, runs, or reset a skill\'s history',
        input: { hint: '[status <skill> | runs [<skill>] | reset <skill>]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/islands',
        name: 'islands',
        description: 'List evolution islands with their migration schedule, register a lane, record a candidate migration, or read the migration log',
        input: { hint: '[list [<skill>] | register <island> <name> <objective> <skill> | migrate <from> <to> <candidate> [<reason>] | migrations [<skill>]]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/budget',
        name: 'budget',
        description: 'Report the evolution budget: one allocation per candidate batch with its class, ceilings, and exact settlement, or the recorded spends',
        input: { hint: '[spends [<batchId>]]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/meta',
        name: 'meta',
        description: 'Report engine runs under their configurations, the derived pass rates, or the configuration recommended for a task class',
        input: { hint: '[summaries [<taskClass>] | runs [<taskClass>] | recommend <taskClass>]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/operators',
        name: 'operators',
        description: 'Rank the mutation operators recorded for one artifact class by acceptance, mean delta, and regression rate',
        input: { hint: '<artifactClass>' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/router',
        name: 'router',
        description: 'Report measured route effectiveness per task class and evolutionary role, or the route the store recommends',
        input: { hint: '[effectiveness [<taskClass>] [<role>] | recommend <taskClass> <role>]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/evaluator-strategy',
        name: 'evaluator-strategy',
        description: 'Report evaluator trust earned from verdicts later judged against independent ground truth, or rank the evaluators of one task class',
        input: { hint: '[strategies [<taskClass>] | rank <taskClass>]' },
      })

      await test.plugin.dispose()
      expect(test.ctx.commands.find(agent, 'memory')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'refine')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'journey')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'skills')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'curator')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'trajectory')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'learn')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'suggestions')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'frontier')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'trace')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'benchmark')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'evaluators')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'population')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'routes')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'canary')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'novelty')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'stagnation')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'islands')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'budget')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'meta')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'operators')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'router')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'evaluator-strategy')).toBeUndefined()
    } finally {
      await rm(test.dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed scope namespaces loudly at load', async () => {
    const loadMessage = async (profile: string): Promise<string> => {
      const ctx = new Context()
      ctx.provide('commands', { register: () => () => undefined } as never)
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      ctx.provide('evolutionMemory', {} as never)
      try {
        await ctx.plugin(commandEvolution, { profile })
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      return 'loaded'
    }
    expect(await loadMessage('')).toContain('profile must be non-empty')
    expect(await loadMessage('a:b')).toContain("must not contain ':'")
    expect(await loadMessage('ok')).toBe('loaded')
  })
})

describe('/memory human command', () => {
  it('reports usage for unknown and malformed inputs', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /memory pending | approve <id> | reject <id>' } as const
      expect((await run(test, session, '/memory frobnicate')).result).toEqual(usage)
      expect((await run(test, session, '/memory pending extra')).result).toEqual(usage)
      expect((await run(test, session, '/memory approve')).result).toEqual(usage)
      expect((await run(test, session, '/memory approve a b')).result).toEqual(usage)
      expect((await run(test, session, '/memory reject')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('refuses sessions outside any workspace scope', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('homeless'))
      expect((await run(test, homeless, '/memory pending')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
      const stray = test.ctx.sessions.create(SessionId('stray'), { meta: { cwd: join(test.dir, 'no-such-dir') } })
      expect((await run(test, stray, '/memory pending')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('resolves scopes through the canonical cwd fallback', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'fallback')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [] })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'success',
        text: 'No pending writes.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports no scope when the cwd matches no workspace', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'unmatched')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Elsewhere', path: join(test.dir, 'elsewhere'), sessionIds: [] })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists pending writes honestly, empty and filled', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'pending')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const empty = await run(test, session, '/memory pending')
      expect(empty.result).toEqual({ kind: 'success', text: 'No pending writes.' })
      expectLifecycle(test, session, 'memory', ' pending', empty.result)
      // The bare command reports the same list: `pending` is the default verb.
      expect((await run(test, session, '/memory')).result).toEqual(empty.result)

      const first = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'replaceArtifacts',
        payload: artifactPayload({ candidates: [candidate('reviewed')] }),
        originSessionId: 's1', gist: 'lessons from turn 1',
      })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'success',
        text: `1 pending write:\n- ${first.id} [memory:replaceArtifacts] lessons from turn 1 (session 's1', ${first.createdAt})`,
      })

      const second = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'create',
        payload: { name: 'polish' }, originSessionId: 's2', gist: 'new skill polish',
      })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'success',
        text: `2 pending writes:\n- ${first.id} [memory:replaceArtifacts] lessons from turn 1 (session 's1', ${first.createdAt})\n- ${second.id} [skill:create] new skill polish (session 's2', ${second.createdAt})`,
      })
    } finally {
      await shutdown(test)
    }
  })

  it('names every decision of a staged applyDecisions batch in the pending list', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'decisions-pending')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionMemory.replaceArtifacts(id, [candidate('use spaces'), candidate('kept fact')])
      const stored = test.ctx.evolutionMemory.read(id)?.agentLessons ?? []
      const keptId = stored.find(artifact => artifact.statement === 'kept fact')?.id ?? ''
      const spacesId = stored.find(artifact => artifact.statement === 'use spaces')?.id ?? ''
      const decisions: LessonDecision[] = [
        { kind: 'confirms', artifactId: keptId },
        { kind: 'contradicts', artifactId: spacesId, statement: 'use tabs' },
        // A contradiction with no replacement text only bumps the counter, so
        // the detail names the contested fact and stops there.
        { kind: 'contradicts', artifactId: keptId },
        { kind: 'new', candidate: candidate('prefer pnpm') },
      ]
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id,
        kind: 'memory',
        op: 'applyDecisions',
        payload: artifactPayload({ decisions, extraction: { origin: 'background_review', sessionId: 's1', provider: 'p', model: 'm', at: '2026-09-14T00:00:00.000Z' } }),
        originSessionId: 's1',
        gist: "1 confirms, 2 contradicts, 1 new from turn 1 of session 's1'",
      })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'success',
        text: [
          '1 pending write:',
          `- ${staged.id} [memory:applyDecisions] 1 confirms, 2 contradicts, 1 new from turn 1 of session 's1' (session 's1', ${staged.createdAt})`,
          "  confirms 'kept fact'",
          "  contradicts 'use spaces' → 'use tabs'",
          "  contradicts 'kept fact'",
          "  new 'prefer pnpm'",
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('names an applyDecisions entry whose payload it cannot read, without detail', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'decisions-unreadable')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      // The payload is unvalidated JSON, so a list the renderer cannot read
      // degrades to the entry's own line instead of failing `/memory pending`.
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id,
        kind: 'memory',
        op: 'applyDecisions',
        payload: artifactPayload({ decisions: [
          'not a decision',
          { kind: 'confirms' },
          { kind: 'confirms', artifactId: 'pruned fact' },
          { kind: 'new', candidate: {} },
          { kind: 'retracts', artifactId: 'x' },
        ] }),
        originSessionId: 's2',
        gist: 'unreadable batch',
      })
      const bare = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id,
        kind: 'memory',
        op: 'applyDecisions',
        payload: artifactPayload({}),
        originSessionId: 's2',
        gist: 'no decisions',
      })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'success',
        text: [
          '2 pending writes:',
          `- ${staged.id} [memory:applyDecisions] unreadable batch (session 's2', ${staged.createdAt})`,
          // The addressed artifact is gone, so the id itself is the best name left.
          "  confirms 'pruned fact'",
          `- ${bare.id} [memory:applyDecisions] no decisions (session 's2', ${bare.createdAt})`,
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('approves memory writes and reports the applied op', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'approve')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'replaceArtifacts',
        payload: artifactPayload({ candidates: [candidate('tabs win')] }),
        originSessionId: 's1', gist: 'lessons from turn 1',
      })
      const execution = await run(test, session, `/memory approve ${staged.id}`)
      expect(execution.result).toEqual({
        kind: 'success',
        text: 'Approved staged replaceArtifacts (lessons from turn 1).',
      })
      expectLifecycle(test, session, 'memory', ` approve ${staged.id}`, execution.result)
      expect(lessonsOf(test.ctx.evolutionMemory.read(id))).toBe('tabs win')
      expect(test.ctx.evolutionMemory.read(id)?.staged).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('rejects unknown staged ids on approve and reject', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'unknown')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/memory approve missing')).result).toEqual({
        kind: 'error',
        text: "No staged write 'missing'.",
      })
      expect((await run(test, session, '/memory reject missing')).result).toEqual({
        kind: 'error',
        text: "No staged write 'missing'.",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('rejects staged writes without applying them', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'reject')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionMemory.replaceArtifacts(id, [candidate('keep me')])
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'replaceArtifacts',
        payload: artifactPayload({ candidates: [candidate('drop me')] }),
        originSessionId: 's1', gist: 'bad idea',
      })
      const execution = await run(test, session, `/memory reject ${staged.id}`)
      expect(execution.result).toEqual({ kind: 'success', text: `Rejected staged write '${staged.id}'.` })
      expect(lessonsOf(test.ctx.evolutionMemory.read(id))).toBe('keep me')
      expect(test.ctx.evolutionMemory.read(id)?.staged).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('routes skill approvals to /skills and keeps the entry', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skill-approve')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'create',
        payload: { name: 'polish' }, originSessionId: 's9', gist: 'new skill polish',
      })
      expect((await run(test, session, `/memory approve ${staged.id}`)).result).toEqual({
        kind: 'error',
        text: `Staged skill '${staged.id}' (create) is decided by '/skills approve ${staged.id}': write the skill with skill_manage first, then approve there to drop the entry.`,
      })
      expect(test.ctx.evolutionMemory.read(id)?.staged.map(entry => entry.id)).toEqual([staged.id])
    } finally {
      await shutdown(test)
    }
  })

  it('keeps the entry and names the code when caps reject an approval', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'cap-approve')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'replaceArtifacts',
        payload: artifactPayload({ candidates: [candidate('x'.repeat(70000))] }),
        originSessionId: 's1', gist: 'oversized lessons',
      })
      const rejected = await run(test, session, `/memory approve ${staged.id}`)
      expect(rejected.result).toMatchObject({ kind: 'error' })
      expect(errorTextOf(rejected.result)).toContain(
        `Cannot approve '${staged.id}' (evolution/too-large): evolution memory field 'agentLessons'`,
      )
      expect(test.ctx.evolutionMemory.read(id)?.staged.map(entry => entry.id)).toEqual([staged.id])
    } finally {
      await shutdown(test)
    }
  })

  it('propagates unexpected store failures instead of converting them', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'explode')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'explode', payload: {}, originSessionId: 's1', gist: 'boom',
      })
      await expect(run(test, session, `/memory approve ${staged.id}`)).rejects.toThrow("unknown staged memory op 'explode'")
    } finally {
      await shutdown(test)
    }
  })
})

describe('/dream human command', () => {
  it('reports usage for an unknown phase and for trailing arguments', async () => {
    const test = await harness(true, undefined, { dream: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /dream [light|rem|deep]' } as const
      expect((await run(test, session, '/dream nightly')).result).toEqual(usage)
      expect((await run(test, session, '/dream light extra')).result).toEqual(usage)
      expect(test.dream.runs).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('says so when dreaming is not mounted', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-unmounted')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/dream')).result).toEqual({
        kind: 'error',
        text: 'Dreaming consolidation is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('runs one phase for the scope sessions', async () => {
    const test = await harness(true, undefined, { dream: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-phase')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/dream deep')).result).toEqual({
        kind: 'success',
        text: 'Dream deep: scanned 2, staged 2, promoted 1, pruned 0.',
      })
      expect(test.dream.runs).toEqual([{ phase: 'deep', scopeId: test.scope('ws-1'), sessionIds: [session.id] }])
      expect(test.dream.cycles).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('runs the full cycle and names the strongest themes', async () => {
    const test = await harness(true, undefined, { dream: true })
    test.dream.record = { narratives: [{ themes: [{ key: 'bash', candidates: 3 }, { key: 'pwsh', candidates: 1 }] }] }
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-cycle')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id, SessionId('other')] })
      expect((await run(test, session, '/dream')).result).toEqual({
        kind: 'success',
        text: 'Dream cycle: scanned 2, staged 2, promoted 1, pruned 0.'
          + '\nTop themes: bash (3), pwsh (1).',
      })
      expect(test.dream.cycles).toEqual([{ scopeId: test.scope('ws-1'), sessionIds: [session.id, 'other'] }])
    } finally {
      await shutdown(test)
    }
  })

  it('omits the theme line when the cycle recorded none', async () => {
    const test = await harness(true, undefined, { dream: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-no-themes')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/dream')).result).toEqual({
        kind: 'success',
        text: 'Dream cycle: scanned 2, staged 2, promoted 1, pruned 0.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports a failed pass', async () => {
    const test = await harness(true, undefined, { dream: true })
    test.dream.failure = new Error('dreaming exploded')
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-failure')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/dream')).result).toEqual({ kind: 'error', text: 'dreaming exploded' })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/graph human command', () => {
  it('reports usage for missing and trailing arguments', async () => {
    const test = await harness(true, undefined, { graph: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'graph-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /graph <entity> [relation]' } as const
      expect((await run(test, session, '/graph')).result).toEqual(usage)
      expect((await run(test, session, '/graph A b c')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('says so when the graph is not mounted', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'graph-unmounted')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/graph A')).result).toEqual({
        kind: 'error',
        text: 'The knowledge graph is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('answers a named relation and lists connections without one', async () => {
    const test = await harness(true, undefined, { graph: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'graph')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionGraph.observe(test.scope('ws-1'), [
        { from: 'Project X', relation: 'worked_on', to: 'Alice' },
        { from: 'Project X', relation: 'uses', to: 'PostgreSQL' },
      ])
      expect((await run(test, session, '/graph "Project X" worked_on')).result).toEqual({
        kind: 'success',
        text: 'Project X —worked_on→ Alice',
      })
      expect((await run(test, session, '/graph "Project X" owns')).result).toEqual({
        kind: 'success',
        text: "Project X has no 'owns' relation.",
      })
      const connections = await run(test, session, '/graph "Project X"')
      expect(connections.result).toMatchObject({ kind: 'success' })
      expect((connections.result as { text: string }).text).toContain('- worked_on → Alice')
      expect((connections.result as { text: string }).text).toContain('- uses → PostgreSQL')
      // An unquoted single-word entity needs no quoting; an unquoted
      // multi-word one is a grammar error, not a silent partial name.
      expect((await run(test, session, '/graph alice')).result).toMatchObject({ kind: 'success' })
      expect((await run(test, session, '/graph Project X worked_on')).result).toEqual({
        kind: 'error',
        text: 'Usage: /graph <entity> [relation]',
      })
      expect((await run(test, session, '/graph Unknown')).result).toEqual({
        kind: 'success',
        text: "No entity matching 'Unknown' in this scope's graph.",
      })
      expect((await run(test, session, '/graph Unknown worked_on')).result).toEqual({
        kind: 'success',
        text: "No entity matching 'Unknown' in this scope's graph.",
      })
    } finally {
      await shutdown(test)
    }
  })

})

describe('/claims human command', () => {
  it('says so when the graph is not mounted', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'claims-unmounted')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/claims')).result).toEqual({
        kind: 'error',
        text: 'The knowledge graph is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists active claims most believed first and drops a retired one', async () => {
    const test = await harness(true, undefined, { graph: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'claims')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const scope = test.scope('ws-1')
      await test.ctx.evolutionGraph.recordClaims(scope, [
        { statement: 'The build is green', supportedBy: [{ source: 's1', quality: 0.9, reliability: 0.9 }] },
        { statement: 'The build is green', supportedBy: [{ source: 's2', quality: 0.9, reliability: 0.9 }] },
        { statement: 'The build is red', supportedBy: [{ source: 's3', quality: 0.2, reliability: 0.2 }] },
      ])
      const listed = await run(test, session, '/claims build')
      if (listed.result.kind !== 'success' || listed.result.text === undefined) {
        throw new Error(`expected a successful claim listing, got ${JSON.stringify(listed.result)}`)
      }
      const text = listed.result.text
      // Two independent sources beat one weak source, so the supported claim
      // is listed first with its support counted.
      expect(text.indexOf('The build is green')).toBeLessThan(text.indexOf('The build is red'))
      expect(text).toContain('2 supporting / 0 contradicting source(s)')
      // A retired claim stops answering, and the query says so rather than
      // reporting an empty scope.
      await test.ctx.evolutionGraph.recordClaims(scope, [
        {
          statement: 'The build is red today',
          supportedBy: [{ source: 's4', quality: 0.5, reliability: 0.5 }],
          supersedes: ['The build is green'],
        },
      ])
      expect((await run(test, session, '/claims green')).result).toEqual({
        kind: 'success',
        text: "No active claim matching 'green' in this scope.",
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/reflection human command', () => {
  it('reports usage for a non-positive or non-numeric limit', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'reflection-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /reflection [limit]' } as const
      expect((await run(test, session, '/reflection 0')).result).toEqual(usage)
      expect((await run(test, session, '/reflection many')).result).toEqual(usage)
      expect((await run(test, session, '/reflection 3 extra')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('says so when the feedback store is not mounted', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'reflection-unmounted')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/reflection')).result).toEqual({
        kind: 'error',
        text: 'The evolution feedback store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('renders the stored reflections with the heuristic the loop reuses', async () => {
    const test = await harness(true, undefined, { reflection: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'reflection')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/reflection')).result).toEqual({
        kind: 'success',
        text: 'No reflections stored for this scope.',
      })
      test.reflection.rows = [{
        symptom: 'ripgrep: no such file',
        violatedExpectation: 'the call succeeds',
        rootCause: null,
        correctedStrategy: 'change the call before repeating it',
        antiPattern: 'do not repeat a call whose result was ripgrep: no such file',
        reusableWhen: 'when the call is about to be repeated',
        candidateTest: 'replaying the run no longer repeats the call',
        confidence: 0.875,
      }]
      expect((await run(test, session, '/reflection 1')).result).toEqual({
        kind: 'success',
        text: [
          '1 reflection (newest first):',
          '- ripgrep: no such file (confidence 0.88)',
          '  expected: the call succeeds',
          '  avoid: do not repeat a call whose result was ripgrep: no such file (when the call is about to be repeated)',
          '  instead: change the call before repeating it',
          '  check: replaying the run no longer repeats the call',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/journey human command', () => {
  it('reports usage for an unknown range and trailing arguments', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'journey-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /journey [today | 7d | 30d | all]' } as const
      expect((await run(test, session, '/journey nope')).result).toEqual(usage)
      expect((await run(test, session, '/journey 7d extra')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('refuses sessions outside any workspace scope', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('journey-homeless'))
      expect((await run(test, homeless, '/journey')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('renders the default seven-day window with the scope record behind it', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'journey')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionMemory.recordOutputs(id, [
        { path: 'src/a.ts', tool: 'write', sessionId: 's-output', at: new Date().toISOString() },
      ])
      await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setInstructions',
        payload: { text: 'rules from turn 1' }, originSessionId: 's1', gist: 'rules from turn 1',
      })
      const usage = test.ctx.evolutionMemory.usage(id)
      const today = dayKeyUTC7(Date.now())
      const start = dayKeyUTC7(Date.now() - 6 * 86_400_000)
      const percent = Math.round((usage.usedBytes / usage.capacityBytes) * 100)
      const execution = await run(test, session, '/journey')
      expect(execution.result).toEqual({
        kind: 'success',
        text: [
          `Journey (7d) · ${start}..${today}`,
          `${today}  outputs 1 · staged 1`,
          `Memory ${usage.usedBytes}/${usage.capacityBytes} bytes (${percent}%) · lessons 0 · profile 0 · digest ${test.ctx.evolutionMemory.digest(id)}`,
          '1 staged write; run /memory pending.',
        ].join('\n'),
      })
      expectLifecycle(test, session, 'journey', '', execution.result)
    } finally {
      await shutdown(test)
    }
  })

  it('reports the unbounded range with its active-day count', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'journey-all')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionMemory.recordOutputs(id, [
        { path: 'src/old.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' },
      ])
      const execution = await run(test, session, '/journey all')
      expect(execution.result.kind).toBe('success')
      const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
      expect(text.split('\n')).toEqual([
        'Journey (all) · all (1 active day)',
        '2026-01-02  outputs 1',
        text.split('\n')[2],
        'No staged writes.',
      ])
      expect(text.split('\n')[2]).toContain('digest ')
    } finally {
      await shutdown(test)
    }
  })

  it('exports journey timeline and session log to a zip file', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'journey-export')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionMemory.recordOutputs(id, [
        { path: 'src/a.ts', tool: 'write', sessionId: 's-output', at: new Date().toISOString() },
      ])
      const outPath = join(test.dir, 'journey-test.zip')
      const execution = await run(test, session, `/journey export --out ${outPath}`)
      expect(execution.result).toEqual({
        kind: 'success',
        text: `Journey exported to ${outPath}`,
      })

      // Verify the zip structure and content
      const archive = unzipSync(new Uint8Array(await readFile(outPath)))
      expect(Object.keys(archive).sort()).toEqual(['session-log.jsonl', 'timeline.json'])

      const timeline = JSON.parse(strFromU8(archive['timeline.json']!)) as unknown
      expect(timeline).toHaveProperty('days')
      expect(timeline).toHaveProperty('cumulative')
      expect(timeline).toHaveProperty('pending')

      const sessionLog = strFromU8(archive['session-log.jsonl']!)
      const lines = sessionLog.trim().split('\n')
      expect(lines.length).toBeGreaterThan(0)
      const header = JSON.parse(lines[0]!) as { type: string; id: string }
      expect(header.type).toBe('session')
      expect(header.id).toBe('journey-export')
    } finally {
      await shutdown(test)
    }
  })
})

describe('/skills human command', () => {
  it('reports usage for malformed invocations', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /skills pending | approve <id>' } as const
      expect((await run(test, session, '/skills pending extra')).result).toEqual(usage)
      expect((await run(test, session, '/skills approve')).result).toEqual(usage)
      expect((await run(test, session, '/skills approve a b')).result).toEqual(usage)
      expect((await run(test, session, '/skills diff abc')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('reports the honest empty state and lists only skill proposals', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-pending')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/skills pending')).result).toEqual({
        kind: 'success',
        text: 'No pending skill proposals. Background review proposes skills once the reviewer fork lands; write one directly with skill_manage.',
      })
      // The bare command reports the same list: `pending` is the default verb.
      expect((await run(test, session, '/skills')).result).toEqual({
        kind: 'success',
        text: 'No pending skill proposals. Background review proposes skills once the reviewer fork lands; write one directly with skill_manage.',
      })

      await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setInstructions',
        payload: { text: 'rules from turn 1' }, originSessionId: 's1', gist: 'rules from turn 1',
      })
      expect((await run(test, session, '/skills pending')).result).toEqual({
        kind: 'success',
        text: 'No pending skill proposals. Background review proposes skills once the reviewer fork lands; write one directly with skill_manage.',
      })

      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'create',
        payload: { name: 'polish' }, originSessionId: 's2', gist: 'new skill polish',
      })
      expect((await run(test, session, '/skills pending')).result).toEqual({
        kind: 'success',
        text: `1 pending skill proposal:\n- ${staged.id} [skill:create] new skill polish (session 's2', ${staged.createdAt})`,
      })
    } finally {
      await shutdown(test)
    }
  })

  it('approves a staged skill after its write and drops the entry', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-approve')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'create',
        payload: {
          name: 'polish',
          contract: {
            capability: 'polish prose',
            procedureRefs: ['/w/draft.md'],
            validationRefs: ['session s2 replay'],
            validationSummary: 'replay passed',
            limitations: 'none known',
          },
        }, originSessionId: 's2', gist: 'new skill polish',
      })
      expect((await run(test, session, `/skills approve ${staged.id}`)).result).toEqual({
        kind: 'success',
        text: 'Approved staged skill create (new skill polish). The skill file itself is written by skill_manage; approve only after that write landed.',
      })
      expect(test.ctx.evolutionMemory.read(id)?.staged).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('approves a staged patch, whose evidence is the measurement it carries', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-approve-patch')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'patch',
        payload: {
          skill: 'writer',
          body: '---\nname: writer\ndescription: writer.\n---\n# writer v2',
          operator: 'rewrite',
          baseline: { pass: true, tokens: 10, wallTimeMs: 5 },
          winner: { pass: true, tokens: 3, wallTimeMs: 5 },
        },
        originSessionId: 's1', gist: "optimizer patch for 'writer' by rewrite: pass true, 3 tokens",
      })
      expect((await run(test, session, `/skills approve ${staged.id}`)).result).toEqual({
        kind: 'success',
        text: "Approved staged skill patch (optimizer patch for 'writer' by rewrite: pass true, 3 tokens). The skill file itself is written by skill_manage; approve only after that write landed.",
      })
      expect(test.ctx.evolutionMemory.read(id)?.staged).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('reports what evidence a blocked skill proposal is missing', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-blocked')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'create',
        payload: { name: 'polish' }, originSessionId: 's2', gist: 'new skill polish',
      })
      const result = (await run(test, session, `/skills approve ${staged.id}`)).result
      expect(result).toEqual({
        kind: 'error',
        text: `Cannot approve '${staged.id}' (evolution/staged-blocked): staged evolution write '${staged.id}' is blocked: contract must be an object. The entry stays staged.`,
      })
      expect(test.ctx.evolutionMemory.read(id)?.staged[0]).toMatchObject({
        blockedReason: 'capture-contract',
        neededEvidence: ['contract must be an object'],
      })
    } finally {
      await shutdown(test)
    }
  })

  it('refuses ids that are not staged skills and reports usage for diffs', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-refuse')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const memory = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setInstructions',
        payload: { text: 'rules' }, originSessionId: 's1', gist: 'rules',
      })
      expect((await run(test, session, `/skills approve ${memory.id}`)).result).toEqual({
        kind: 'error',
        text: `No staged skill '${memory.id}'.`,
      })
      expect((await run(test, session, '/skills approve nope')).result).toEqual({
        kind: 'error',
        text: "No staged skill 'nope'.",
      })
      expect((await run(test, session, `/skills diff ${memory.id}`)).result).toEqual({
        kind: 'error',
        text: 'Usage: /skills pending | approve <id>',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/curator human command', () => {
  it('reports usage for malformed invocations', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]' } as const
      expect((await run(test, session, '/curator')).result).toEqual(usage)
      expect((await run(test, session, '/curator status extra')).result).toEqual(usage)
      expect((await run(test, session, '/curator run extra')).result).toEqual(usage)
      expect((await run(test, session, '/curator run --dry-run --dry-run')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing curator without resolving a scope', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('curator-homeless'))
      expect((await run(test, homeless, '/curator status')).result).toEqual({
        kind: 'error',
        text: 'The evolution curator is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports bookkeeping, tracked-skill counts, and the newest recorded pass', async () => {
    const test = await harness(true, {
      lastRunAt: '2026-09-12T00:00:00.000Z',
      passes: [
        { passId: 'pass-2', at: '2026-09-12T00:00:00.000Z', snapshot: 'pass-2.tar.gz', transitions: 2 },
        { passId: 'pass-1', at: '2026-09-05T00:00:00.000Z', snapshot: 'pass-1.tar.gz', transitions: 1 },
      ],
      entries: [
        { name: 'alpha', usage: usageRecord({ state: 'active' }) },
        { name: 'beta', usage: usageRecord({ state: 'stale', pinned: true }) },
        { name: 'gamma', usage: usageRecord({ state: 'archived' }) },
        { name: 'delta', usage: usageRecord({ state: 'active' }) },
      ],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator')
      expect((await run(test, session, '/curator status')).result).toEqual({
        kind: 'success',
        text: [
          'Curator: last pass 2026-09-12T00:00:00.000Z',
          'Tracked skills: 4 (active 2, suspect 0, stale 1, archived 1, pinned 1) · trust: 0 provisional, 4 trusted',
          'Cache hit (today): unavailable (usage ledger is not mounted).',
          'Skill failure rate: no recorded loads.',
          'Staged for review: 0',
          'Recorded passes: 2 · newest pass-2 at 2026-09-12T00:00:00.000Z (2 transitions)',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('runs one pass and reports its movements, skips, and snapshot', async () => {
    const runs: boolean[] = []
    const test = await harness(true, {
      runs, scanned: 5, passId: 'pass-3', skippedPinned: 1, skippedExcluded: 3,
      transitions: [{ name: 'drafts', from: 'stale', to: 'archived', reason: 'idle 95d' }],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-run')
      expect((await run(test, session, '/curator run')).result).toEqual({
        kind: 'success',
        text: [
          'Curator pass complete at 2026-09-12T01:00:00.000Z: 5 tracked skills, 1 transition',
          '- drafts: stale → archived',
          'Staged for review: none',
          'Skipped: 1 pinned, 0 protected, 3 bundled or hub',
          'Snapshot: pass-3',
        ].join('\n'),
      })
      expect(runs).toEqual([false])
    } finally {
      await shutdown(test)
    }
  })

  it('previews a pass with --dry-run and writes nothing', async () => {
    const runs: boolean[] = []
    const test = await harness(true, {
      runs, scanned: 2,
      transitions: [{ name: 'notes', from: 'active', to: 'stale', reason: 'idle 31d' }],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-dry-run')
      expect((await run(test, session, '/curator run --dry-run')).result).toEqual({
        kind: 'success',
        text: [
          'Curator pass previewed at 2026-09-12T01:00:00.000Z: 2 tracked skills, 1 transition (no writes)',
          '- notes: active → stale',
          'Staged for review: none',
          'Skipped: 0 pinned, 0 protected, 0 bundled or hub',
          'Snapshot: none',
        ].join('\n'),
      })
      expect(runs).toEqual([true])
    } finally {
      await shutdown(test)
    }
  })

  it('reports a pass without movements and a missing curator for run', async () => {
    const test = await harness(true, { scanned: 1 })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-quiet')
      expect((await run(test, session, '/curator run')).result).toEqual({
        kind: 'success',
        text: [
          'Curator pass complete at 2026-09-12T01:00:00.000Z: 1 tracked skill, 0 transitions',
          'Staged for review: none',
          'Skipped: 0 pinned, 0 protected, 0 bundled or hub',
          'Snapshot: none',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
    const bare = await harness()
    try {
      const homeless = bare.ctx.sessions.create(SessionId('curator-run-unmounted'))
      expect((await run(bare, homeless, '/curator run')).result).toEqual({
        kind: 'error',
        text: 'The evolution curator is not mounted.',
      })
    } finally {
      await shutdown(bare)
    }
  })

  it('reports a single newest-pass transition in the singular', async () => {
    const test = await harness(true, {
      lastRunAt: '2026-09-12T00:00:00.000Z',
      passes: [{ passId: 'pass-9', at: '2026-09-12T00:00:00.000Z', snapshot: 'pass-9.tar.gz', transitions: 1 }],
      entries: [],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-single')
      const execution = await run(test, session, '/curator status')
      expect(execution.result.kind).toBe('success')
      const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
      expect(text.split('\n')).toEqual([
        'Curator: last pass 2026-09-12T00:00:00.000Z',
        'Tracked skills: 0 (active 0, suspect 0, stale 0, archived 0, pinned 0) · trust: 0 provisional, 0 trusted',
        'Cache hit (today): unavailable (usage ledger is not mounted).',
        'Skill failure rate: no recorded loads.',
        'Staged for review: 0',
        'Recorded passes: 1 · newest pass-9 at 2026-09-12T00:00:00.000Z (1 transition)',
      ])
    } finally {
      await shutdown(test)
    }
  })

  it('reports bookkeeping without telemetry and before the first pass', async () => {
    const test = await harness(true, { lastRunAt: null, passes: [] })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-fresh')
      expect((await run(test, session, '/curator status')).result).toEqual({
        kind: 'success',
        text: [
          'Curator: last pass never',
          'Tracked skills: unavailable (skill telemetry is not mounted).',
          'Cache hit (today): unavailable (usage ledger is not mounted).',
          'Skill failure rate: unavailable (skill telemetry is not mounted).',
          'Staged for review: 0',
          'Recorded passes: 0',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports the dashboard rates from the ledger and telemetry', async () => {
    const test = await harness(true, {
      lastRunAt: null,
      passes: [],
      entries: [
        { name: 'alpha', usage: usageRecord({ useCount: 10, failureCount: 2 }) },
        { name: 'beta', usage: usageRecord({ useCount: 4 }) },
      ],
    })
    test.ctx.provide('usageLedger', {
      summary: async () => ({ totals: { cacheHitAvg: 0.731, requests: 142 } }),
    } as never)
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-rates')
      expect((await run(test, session, '/curator status')).result).toEqual({
        kind: 'success',
        text: [
          'Curator: last pass never',
          'Tracked skills: 2 (active 2, suspect 0, stale 0, archived 0, pinned 0) · trust: 0 provisional, 2 trusted',
          'Cache hit (today): 73% (142 requests)',
          'Skill failure rate: 13% across 2 skills (16 loads)',
          'Staged for review: 0',
          'Recorded passes: 0',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('counts provisional and trusted skills', async () => {
    const test = await harness(true, {
      lastRunAt: null,
      passes: [],
      entries: [
        { name: 'draft', usage: usageRecord({ trust: 'provisional', revision: 2 }) },
        { name: 'alpha', usage: usageRecord({}) },
        { name: 'beta', usage: usageRecord({ trust: 'provisional' }) },
      ],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-trust')
      const result = (await run(test, session, '/curator status')).result
      expect(result.kind).toBe('success')
      const text = result.kind === 'success' ? result.text ?? '' : ''
      expect(text.split('\n')[1])
        .toBe('Tracked skills: 3 (active 3, suspect 0, stale 0, archived 0, pinned 0) · trust: 2 provisional, 1 trusted')
    } finally {
      await shutdown(test)
    }
  })

  it('names the skill bodies a rollback restored', async () => {
    const test = await harness(true, {
      rollbackCalls: [],
      rollbackResult: {
        at: '2026-09-12T04:00:00.000Z',
        label: "pass 'pass-4'",
        restored: [],
        preRollback: 'sha256',
        restoredDirs: [],
        restoredFiles: ['drafts', 'notes'],
      },
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-rollback-bodies')
      expect((await run(test, session, '/curator rollback --id pass-4')).result).toEqual({
        kind: 'success',
        text: [
          "Rolled back pass 'pass-4' at 2026-09-12T04:00:00.000Z: 0 skills restored",
          'Restored bodies: drafts, notes',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('refuses adopt without a name', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-adopt-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]' } as const
      expect((await run(test, session, '/curator adopt')).result).toEqual(usage)
      expect((await run(test, session, '/curator adopt a b')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('adopts a skill and reports success', async () => {
    const adoptCalls: string[] = []
    const test = await harness(true, { adoptCalls })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-adopt')
      expect((await run(test, session, '/curator adopt draft-skill')).result).toEqual({
        kind: 'success',
        text: 'Adopted \'draft-skill\' (state: active)',
      })
      expect(adoptCalls).toEqual(['draft-skill'])
    } finally {
      await shutdown(test)
    }
  })

  it('reports an error from adopt', async () => {
    const adoptCalls: string[] = []
    const test = await harness(true, { adoptCalls, adoptResult: new Error('curator: adopt failed') })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-adopt-err')
      expect((await run(test, session, '/curator adopt bad')).result).toEqual({
        kind: 'error',
        text: 'curator: adopt failed',
      })
      expect(adoptCalls).toEqual(['bad'])
    } finally {
      await shutdown(test)
    }
  })

  it('refuses purge with extra arguments', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-purge-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]' } as const
      expect((await run(test, session, '/curator purge extra')).result).toEqual(usage)
      expect((await run(test, session, '/curator purge --dry-run extra')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('purges skills and reports the list', async () => {
    const purgeCalls: boolean[] = []
    const test = await harness(true, {
      purgeCalls,
      purgeResult: {
        at: '2026-09-12T03:00:00.000Z',
        dryRun: false,
        purged: [
          { name: 'old-stale', dir: null },
          { name: 'orphaned', dir: '/path/to/orphaned' },
        ],
        skippedPinned: 1,
      },
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-purge')
      expect((await run(test, session, '/curator purge')).result).toEqual({
        kind: 'success',
        text: [
          'Purge complete at 2026-09-12T03:00:00.000Z: 2 skills removed, 1 skipped (pinned)',
          '- old-stale',
          '- orphaned (/path/to/orphaned)',
        ].join('\n'),
      })
      expect(purgeCalls).toEqual([false])
    } finally {
      await shutdown(test)
    }
  })

  it('previews purge with --dry-run', async () => {
    const purgeCalls: boolean[] = []
    const test = await harness(true, {
      purgeCalls,
      purgeResult: {
        at: '2026-09-12T03:00:00.000Z',
        dryRun: true,
        purged: [{ name: 'old-stale', dir: null }],
        skippedPinned: 0,
      },
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-purge-dry')
      expect((await run(test, session, '/curator purge --dry-run')).result).toEqual({
        kind: 'success',
        text: 'Purge previewed at 2026-09-12T03:00:00.000Z: 1 skill, 0 skipped (pinned), no writes\n- old-stale',
      })
      expect(purgeCalls).toEqual([true])
    } finally {
      await shutdown(test)
    }
  })

  it('refuses rollback without --id', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-rollback-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]' } as const
      expect((await run(test, session, '/curator rollback')).result).toEqual(usage)
      expect((await run(test, session, '/curator rollback --id')).result).toEqual(usage)
      expect((await run(test, session, '/curator rollback --id a b')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('rolls back a pass and reports restored skills', async () => {
    const rollbackCalls: string[] = []
    const test = await harness(true, {
      rollbackCalls,
      rollbackResult: {
        at: '2026-09-12T04:00:00.000Z',
        label: "pass 'pass-3'",
        restored: [
          { name: 'drafts', from: 'archived', to: 'stale' },
          { name: 'notes', from: 'stale', to: 'active' },
        ],
        preRollback: 'sha256',
        restoredDirs: [],
        restoredFiles: [],
      },
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-rollback')
      expect((await run(test, session, '/curator rollback --id pass-3')).result).toEqual({
        kind: 'success',
        text: [
          "Rolled back pass 'pass-3' at 2026-09-12T04:00:00.000Z: 2 skills restored",
          '- drafts: archived → stale',
          '- notes: stale → active',
        ].join('\n'),
      })
      expect(rollbackCalls).toEqual(['pass-3'])
    } finally {
      await shutdown(test)
    }
  })

  it('reports an error from rollback', async () => {
    const rollbackCalls: string[] = []
    const test = await harness(true, { rollbackCalls, rollbackResult: new Error('curator: unknown pass') })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-rollback-err')
      expect((await run(test, session, '/curator rollback --id ghost')).result).toEqual({
        kind: 'error',
        text: 'curator: unknown pass',
      })
      expect(rollbackCalls).toEqual(['ghost'])
    } finally {
      await shutdown(test)
    }
  })

  it('lists recorded passes via ledger', async () => {
    const test = await harness(true, {
      passes: [
        { passId: 'pass-2', at: '2026-09-12T00:00:00.000Z', snapshot: 'pass-2.tar.gz', transitions: 2 },
        { passId: 'pass-1', at: '2026-09-05T00:00:00.000Z', snapshot: 'pass-1.tar.gz', transitions: 1 },
      ],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-ledger')
      expect((await run(test, session, '/curator ledger')).result).toEqual({
        kind: 'success',
        text: [
          '2 passes:',
          '- pass-2 at 2026-09-12T00:00:00.000Z: 2 transitions',
          '- pass-1 at 2026-09-05T00:00:00.000Z: 1 transition',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports empty ledger', async () => {
    const test = await harness(true, { passes: [] })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-ledger-empty')
      expect((await run(test, session, '/curator ledger')).result).toEqual({
        kind: 'success',
        text: 'No recorded passes.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists staged skills worst first through staged and status', async () => {
    const staged: StagedSkill[] = [
      { name: 'flaky', useCount: 1, failureCount: 4, failureRate: 0.8, reason: 'failures 4/5 exceed 30%', at: '2026-09-12T00:00:00.000Z' },
      { name: 'mild', useCount: 6, failureCount: 4, failureRate: 0.4, reason: 'failures 4/10 exceed 30%', at: '2026-09-12T00:00:00.000Z' },
    ]
    const test = await harness(true, { staged })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-staged')
      expect((await run(test, session, '/curator staged')).result).toEqual({
        kind: 'success',
        text: [
          '2 staged skills:',
          '- flaky: failures 4/5 exceed 30% (staged 2026-09-12T00:00:00.000Z)',
          '- mild: failures 4/10 exceed 30% (staged 2026-09-12T00:00:00.000Z)',
        ].join('\n'),
      })
      const status = await run(test, session, '/curator status')
      expect(status.result.kind === 'success' ? status.result.text?.split('\n')[4] : '').toBe(
        'Staged for review: 2 · worst flaky (80%)',
      )
    } finally {
      await shutdown(test)
    }
  })

  it('refuses optimize without a skill and scenarios', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-optimize-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]' } as const
      expect((await run(test, session, '/curator optimize')).result).toEqual(usage)
      expect((await run(test, session, '/curator optimize writer')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing optimizer without resolving a scope', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-optimize-homeless')
      expect((await run(test, session, '/curator optimize writer s1')).result).toEqual({
        kind: 'error',
        text: 'The evolution optimizer is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports optimize outside any workspace scope', async () => {
    const test = await harness(true, {})
    test.ctx.provide('evolutionOptimizer', { optimize: async () => ({}) } as never)
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-optimize-outside')
      expect((await run(test, session, '/curator optimize writer s1')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports optimizer outcomes honestly', async () => {
    const test = await harness(true, {})
    let report: unknown = { status: 'skipped', reason: 'below trigger' }
    test.ctx.provide('evolutionOptimizer', { optimize: async () => report } as never)
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-optimize')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/curator optimize writer s1')).result).toEqual({
        kind: 'success',
        text: 'Optimized \'writer\': below trigger.',
      })
      report = { status: 'staged', stagedId: 'staged-9', holdout: null }
      expect((await run(test, session, '/curator optimize writer s1')).result).toEqual({
        kind: 'success',
        text: 'Optimized \'writer\': staged skill patch staged-9. Write the skill with skill_manage, then \'/skills approve staged-9\' to drop the entry.',
      })
      report = {
        status: 'staged',
        stagedId: 'staged-9',
        holdout: { winner: { pass: true, tokens: 4, wallTimeMs: 4 }, baseline: { pass: true, tokens: 10, wallTimeMs: 9 } },
      }
      expect((await run(test, session, '/curator optimize writer s1')).result).toEqual({
        kind: 'success',
        text: 'Optimized \'writer\': staged skill patch staged-9. Holdout: true pass at 4 tokens vs baseline true pass at 10 tokens. Write the skill with skill_manage, then \'/skills approve staged-9\' to drop the entry.',
      })
      report = { status: 'no-improvement', reason: 'no variant beats' }
      expect((await run(test, session, '/curator optimize writer s1')).result).toEqual({
        kind: 'success',
        text: 'Optimized \'writer\': no variant beats.',
      })
      report = { status: 'no-improvement', reason: 'no variant beats', stagnant: true }
      expect((await run(test, session, '/curator optimize writer s1')).result).toEqual({
        kind: 'success',
        text: "Optimized 'writer': no variant beats. Recent runs promoted nothing, so it drew candidates from the operators they had not used.",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports the optimizer ledger, or its absence, per scope and skill', async () => {
    const test = await harness(true, {})
    let rows: unknown[] = []
    test.ctx.provide('evolutionOptimizer', { experiments: () => rows } as never)
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-experiments')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/curator experiments')).result).toEqual({
        kind: 'success',
        text: 'No optimizations recorded in this scope.',
      })
      expect((await run(test, session, '/curator experiments writer')).result).toEqual({
        kind: 'success',
        text: 'No optimizations recorded for \'writer\'.',
      })
      rows = [{
        at: '2026-09-15T10:00:00.000Z',
        skill: 'writer',
        outcome: 'staged',
        operators: ['rewrite', 'compress'],
        winnerOperator: 'compress',
        stagedId: 'staged-4',
        addedLines: 3,
        removedLines: 1,
        confidence: { runs: 2, wins: 2 },
        reason: null,
      }]
      expect((await run(test, session, '/curator experiments')).result).toEqual({
        kind: 'success',
        text: 'Experiments (newest first): 1\n2026-09-15T10:00:00.000Z writer: staged [rewrite+compress] staged-4 via compress +3/-1 2/2',
      })
      rows = [{
        at: '2026-09-15T10:00:00.000Z',
        skill: 'writer',
        outcome: 'no-improvement',
        operators: [],
        winnerOperator: null,
        stagedId: null,
        confidence: null,
        reason: 'no variant beats the baseline',
      }]
      expect((await run(test, session, '/curator experiments')).result).toEqual({
        kind: 'success',
        text: 'Experiments (newest first): 1\n2026-09-15T10:00:00.000Z writer: no-improvement — no variant beats the baseline',
      })
      expect((await run(test, session, '/curator experiments writer extra')).result).toEqual({
        kind: 'error',
        text: 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing optimizer for experiments without resolving a scope', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-experiments-unmounted')
      expect((await run(test, session, '/curator experiments')).result).toEqual({
        kind: 'error',
        text: 'The evolution optimizer is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports experiments outside any workspace scope', async () => {
    const test = await harness(true, {})
    test.ctx.provide('evolutionOptimizer', { experiments: () => [] } as never)
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-experiments-outside')
      expect((await run(test, session, '/curator experiments')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports optimizer failures as errors', async () => {
    const test = await harness(true, {})
    test.ctx.provide('evolutionOptimizer', { optimize: async () => { throw new Error('llm is down') } } as never)
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-optimize-fail')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/curator optimize writer s1')).result).toEqual({
        kind: 'error',
        text: 'llm is down',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports no staged skills and refuses extra words', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-staged-empty')
      expect((await run(test, session, '/curator staged')).result).toEqual({
        kind: 'success',
        text: 'No staged skills.',
      })
      expect((await run(test, session, '/curator staged now')).result).toEqual({
        kind: 'error',
        text: 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('names a single staged skill in the singular', async () => {
    const test = await harness(true, {
      staged: [
        { name: 'flaky', useCount: 1, failureCount: 4, failureRate: 0.8, reason: 'failures 4/5 exceed 30%', at: '2026-09-12T00:00:00.000Z' },
      ],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-staged-one')
      expect((await run(test, session, '/curator staged')).result).toEqual({
        kind: 'success',
        text: [
          '1 staged skill:',
          '- flaky: failures 4/5 exceed 30% (staged 2026-09-12T00:00:00.000Z)',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('names staged skills in the pass report', async () => {
    const test = await harness(true, {
      scanned: 3,
      stagedSkills: [{ name: 'flaky', useCount: 1, failureCount: 4, failureRate: 0.8, reason: 'failures 4/5 exceed 30%' }],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-run-staged')
      const execution = await run(test, session, '/curator run')
      const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
      expect(text.split('\n')).toContain('Staged for review: 1 skill (flaky)')
    } finally {
      await shutdown(test)
    }
  })

  it('pins a tracked skill', async () => {
    const setPinnedCalls: { name: string; pinned: boolean }[] = []
    const test = await harness(true, { setPinnedCalls })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-pin')
      expect((await run(test, session, '/curator pin draft-skill')).result).toEqual({
        kind: 'success',
        text: 'Pinned \'draft-skill\'',
      })
      expect(setPinnedCalls).toEqual([{ name: 'draft-skill', pinned: true }])
    } finally {
      await shutdown(test)
    }
  })

  it('refuses pin without a name', async () => {
    const test = await harness(true, { setPinnedCalls: [] })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-pin-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]' } as const
      expect((await run(test, session, '/curator pin')).result).toEqual(usage)
      expect((await run(test, session, '/curator pin a b')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('reports an error from pin', async () => {
    const setPinnedCalls: { name: string; pinned: boolean }[] = []
    const test = await harness(true, { setPinnedCalls, setPinnedError: new Error('telemetry: no record') })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-pin-err')
      expect((await run(test, session, '/curator pin ghost')).result).toEqual({
        kind: 'error',
        text: 'telemetry: no record',
      })
      expect(setPinnedCalls).toEqual([{ name: 'ghost', pinned: true }])
    } finally {
      await shutdown(test)
    }
  })

  it('unpins a tracked skill', async () => {
    const setPinnedCalls: { name: string; pinned: boolean }[] = []
    const test = await harness(true, { setPinnedCalls })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-unpin')
      expect((await run(test, session, '/curator unpin draft-skill')).result).toEqual({
        kind: 'success',
        text: 'Unpinned \'draft-skill\'',
      })
      expect(setPinnedCalls).toEqual([{ name: 'draft-skill', pinned: false }])
    } finally {
      await shutdown(test)
    }
  })

  it('lists a skill\'s revision history with its lineage', async () => {
    const test = await harness(true, {
      versionsResult: [
        { name: 'draft', revision: 1, contentSha: 'a'.repeat(64), parentRevisionSha: null, at: '2026-09-01T00:00:00.000Z' },
        { name: 'draft', revision: 2, contentSha: 'b'.repeat(64), parentRevisionSha: 'a'.repeat(64), at: '2026-09-02T00:00:00.000Z' },
      ],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-history')
      expect((await run(test, session, '/curator history draft')).result).toEqual({
        kind: 'success',
        text: [
          "2 revisions for 'draft':",
          '- r1 aaaaaaaa (2026-09-01T00:00:00.000Z)',
          '- r2 bbbbbbbb ← r1 aaaaaaaa (2026-09-02T00:00:00.000Z)',
        ].join('\n'),
      })
      // Only the named skill's rows render.
      expect((await run(test, session, '/curator history other')).result).toEqual({
        kind: 'success',
        text: "No recorded revisions for 'other'.",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports usage and a missing store for the history verb', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-history-usage')
      const usage = 'Usage: /curator status | run [--dry-run] | staged | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name> | history <name> | optimize <skill> <scenario...> | experiments [skill]'
      expect((await run(test, session, '/curator history')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(test, session, '/curator history a b')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(test, session, '/curator history draft')).result).toEqual({
        kind: 'error',
        text: 'Skill telemetry is not mounted. Pin, unpin, and history require the telemetry store.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing curator for verbs that need it', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('curator-missing'))
      expect((await run(test, homeless, '/curator adopt x')).result).toEqual({
        kind: 'error',
        text: 'The evolution curator is not mounted.',
      })
      expect((await run(test, homeless, '/curator ledger')).result).toEqual({
        kind: 'error',
        text: 'The evolution curator is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/trajectory human command', () => {
  it('reports usage for arguments outside the grammar', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trajectory-usage')
      const usage = { kind: 'error', text: 'Usage: /trajectory [--out <path>] [--all]' } as const
      expect((await run(test, session, '/trajectory extra')).result).toEqual(usage)
      expect((await run(test, session, '/trajectory --out')).result).toEqual(usage)
      expect((await run(test, session, '/trajectory --out --all')).result).toEqual(usage)
      expect((await run(test, session, '/trajectory --out a --out b')).result).toEqual(usage)
      expect((await run(test, session, '/trajectory --all --all')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing exporter without resolving a scope', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('trajectory-homeless'))
      expect((await run(test, homeless, '/trajectory')).result).toEqual({
        kind: 'error',
        text: 'The evolution trajectory exporter is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('exports the invoking session with and without an output path', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trajectory-session')
      const first = await run(test, session, '/trajectory')
      expect(first.result).toEqual({ kind: 'success', text: 'Trajectory written to session.zip (1 conversation, 10 bytes).' })
      expectLifecycle(test, session, 'trajectory', '', first.result)
      await run(test, session, '/trajectory --out out/session.zip')
      expect(test.trajectory.sessions).toEqual([
        { sessionId: session.id, options: {} },
        { sessionId: session.id, options: { out: 'out/session.zip' } },
      ])
    } finally {
      await shutdown(test)
    }
  })

  it('exports the whole scope with --all and pluralizes its counts', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trajectory-scope')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      test.trajectory.result = { path: 'scope.zip', conversations: 3, bytes: 2048 }
      expect((await run(test, session, '/trajectory --all')).result).toEqual({
        kind: 'success',
        text: 'Trajectory written to scope.zip (3 conversations, 2048 bytes).',
      })
      expect(test.trajectory.scopes).toEqual([{ scopeId: test.scope('ws-1'), options: {} }])
    } finally {
      await shutdown(test)
    }
  })

  it('refuses --all outside every workspace scope', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const homeless = test.ctx.sessions.create(SessionId('trajectory-scope-homeless'))
      expect((await run(test, homeless, '/trajectory --all --out x.zip')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
      expect(test.trajectory.scopes).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('maps documented export failures and propagates unexpected ones', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trajectory-failure')
      test.trajectory.failure = new RemoteError('evolution/export-failed' as never, 'no events', {} as never)
      expect((await run(test, session, '/trajectory')).result).toEqual({
        kind: 'error',
        text: 'Trajectory export failed (evolution/export-failed): no events.',
      })
      test.trajectory.failure = new Error('disk on fire')
      await expect(run(test, session, '/trajectory')).rejects.toThrow('disk on fire')
    } finally {
      await shutdown(test)
    }
  })
})

describe('/trace human command', () => {
  it('reports usage for anything but one session id', async () => {
    const test = await harness(true, undefined, { trace: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trace-usage')
      expect((await run(test, session, '/trace')).result).toEqual({ kind: 'error', text: 'Usage: /trace <sessionId>' })
      expect((await run(test, session, '/trace a b')).result).toEqual({ kind: 'error', text: 'Usage: /trace <sessionId>' })
      expect(test.trace.asked).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('reports the store being unmounted', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'trace-missing')
      expect((await run(test, session, '/trace s1')).result).toEqual({
        kind: 'error',
        text: 'The evolution trace store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports a session storage holds no trace for', async () => {
    const test = await harness(true, undefined, { trace: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trace-absent')
      expect((await run(test, session, '/trace s9')).result).toEqual({
        kind: 'error',
        text: "No trace for session 's9'.",
      })
      expect(test.trace.asked).toEqual(['s9'])
    } finally {
      await shutdown(test)
    }
  })

  it('renders the structured trace with ranked failure causes', async () => {
    const test = await harness(true, undefined, { trace: true })
    try {
      const at = '2026-06-01T00:00:00.000Z'
      test.trace.record = {
        sessionId: 's1',
        updatedAt: at,
        turnCount: 1,
        usage: null,
        evaluations: [],
        feedback: [],
        turns: [{
          turn: 0,
          startedAt: at,
          endedAt: '2026-06-01T00:00:02.000Z',
          endReason: 'completed',
          latencyMs: 2000,
          request: 'deploy the app',
          subgoals: null,
          retrievals: [],
          finalAnswer: null,
          steps: [{
            turn: 0,
            step: 0,
            startedAt: at,
            finishedAt: '2026-06-01T00:00:01.000Z',
            interrupted: false,
            retries: 1,
            usage: null,
            context: null,
            calls: [
              { callId: 'c1', name: 'bash', ok: true, errorName: null, errorCode: null, message: null, snapshot: null, at },
              { callId: 'c2', name: 'bash', ok: false, errorName: 'bash', errorCode: 'EXIT_1', message: 'boom', snapshot: null, at },
            ],
            failures: 1,
          }],
          failures: [{
            callId: 'c2',
            tool: 'bash',
            message: 'boom',
            at,
            causes: [
              { kind: 'tool', turn: 0, step: 0, tool: 'bash', reason: 'the call itself failed' },
              { kind: 'tool', turn: 0, step: 0, tool: 'bash', reason: 'an earlier call in the same step may have produced the failing input' },
            ],
          }],
        }],
      }
      const session = sessionIn(test.ctx, test.dir, 'trace-render')
      expect((await run(test, session, '/trace s1')).result).toEqual({
        kind: 'success',
        text: [
          'Trace of s1: 1 turn, updated 2026-06-01T00:00:00.000Z',
          'Turn 0 [completed (2000ms)]: deploy the app',
          '  · bash ok',
          '  · bash failed: boom',
          '    ← the call itself failed',
          '    ← an earlier call in the same step may have produced the failing input',
        ].join('\n'),
      })
      expect(test.trace.asked).toEqual(['s1'])
    } finally {
      await shutdown(test)
    }
  })

  it('maps a service failure onto an error result', async () => {
    const test = await harness(true, undefined, { trace: true })
    try {
      test.trace.failure = new Error('corrupt log')
      const session = sessionIn(test.ctx, test.dir, 'trace-failure')
      expect((await run(test, session, '/trace s1')).result).toEqual({ kind: 'error', text: 'corrupt log' })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/curriculum human command', () => {
  it('reports the store being unmounted and rejects extra words', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'curriculum-usage')
      expect((await run(test, session, '/curriculum')).result).toEqual({
        kind: 'error',
        text: 'The evolution curriculum store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { curriculum: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'curriculum-extra')
      expect((await run(mounted, session, '/curriculum x y')).result).toEqual({
        kind: 'error',
        text: 'Usage: /curriculum [retire <id>]',
      })
      expect((await run(mounted, session, '/curriculum retire')).result).toEqual({
        kind: 'error',
        text: 'Usage: /curriculum [retire <id>]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('stages tasks from the measured gaps and lists open proposals', async () => {
    const test = await harness(true, undefined, { curriculum: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curriculum-run')
      test.curriculum.staged = [{
        id: 'aa-bb-cc',
        capability: 'writer',
        task: "Reproduce and recover from the recurring failure: 'boom'",
        sourceSessions: ['s1'],
        gists: ['boom'],
        at: '2026-09-12T00:00:00.000Z',
        state: 'open',
      }]
      test.curriculum.open = test.curriculum.staged
      expect((await run(test, session, '/curriculum')).result).toEqual({
        kind: 'success',
        text: [
          'Staged 1 new task.',
          '- aa-bb-cc writer: Reproduce and recover from the recurring failure: \'boom\'',
        ].join('\n'),
      })
      expect(test.curriculum.gapsCalls).toBe(1)
    } finally {
      await shutdown(test)
    }
  })

  it('reports when no gap staged anything and retires a task by id', async () => {
    const test = await harness(true, undefined, { curriculum: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curriculum-empty')
      expect((await run(test, session, '/curriculum')).result).toEqual({
        kind: 'success',
        text: ['No new tasks staged from the measured gaps.', 'No open curriculum tasks.'].join('\n'),
      })
      test.curriculum.retireError = new Error("unknown proposal 'ghost'")
      expect((await run(test, session, '/curriculum retire ghost')).result).toEqual({
        kind: 'error',
        text: "unknown proposal 'ghost'",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('retires a task by id', async () => {
    const test = await harness(true, undefined, { curriculum: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curriculum-retire')
      expect((await run(test, session, '/curriculum retire aa-bb-cc')).result).toEqual({
        kind: 'success',
        text: "Retired curriculum task 'aa-bb-cc' (x).",
      })
      expect(test.curriculum.retired).toEqual(['aa-bb-cc'])
    } finally {
      await shutdown(test)
    }
  })
})

describe('/benchmark human command', () => {
  it('reports the store being unmounted and rejects unknown verbs', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'benchmark-usage')
      expect((await run(test, session, '/benchmark')).result).toEqual({
        kind: 'error',
        text: 'The evolution benchmark store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { benchmark: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'benchmark-extra')
      expect((await run(mounted, session, '/benchmark nope')).result).toEqual({
        kind: 'error',
        text: 'Usage: /benchmark [admit | promote <id> [state] | retire <id>]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('lists the benchmark by state with fresh tasks', async () => {
    const test = await harness(true, undefined, { benchmark: true })
    try {
      test.benchmark.tasks = [{
        id: 'aa-bb-cc',
        hash: 'h1',
        capability: 'writer',
        task: 'Recover from boom',
        gists: ['boom'],
        sourceSessions: ['s1'],
        at: '2026-09-12T00:00:00.000Z',
        state: 'fresh',
      }, {
        id: 'dd-ee-ff',
        hash: 'h2',
        capability: 'polish',
        task: 'Recover from stale',
        gists: ['stale'],
        sourceSessions: ['s1'],
        at: '2026-09-12T00:00:00.000Z',
        state: 'retired',
      }]
      const session = sessionIn(test.ctx, test.dir, 'benchmark-list')
      expect((await run(test, session, '/benchmark')).result).toEqual({
        kind: 'success',
        text: [
          'Benchmark: 1 fresh, 0 search, 0 validation, 0 holdout, 0 contaminated, 1 retired.',
          '- aa-bb-cc writer: Recover from boom',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('admits open curriculum proposals as fresh tasks', async () => {
    const test = await harness(true, undefined, { benchmark: true, curriculum: true })
    try {
      test.curriculum.open = [{
        id: 'p1',
        capability: 'writer',
        task: 'Recover from boom',
        sourceSessions: ['s1'],
        gists: ['boom'],
        at: '2026-09-12T00:00:00.000Z',
        state: 'open',
      }, {
        id: 'p2',
        capability: 'polish',
        task: 'Recover from stale',
        sourceSessions: ['s1'],
        gists: ['stale'],
        at: '2026-09-12T00:00:00.000Z',
        state: 'retired',
      }]
      test.benchmark.admittedCount = 1
      test.benchmark.duplicates = ['dup']
      const session = sessionIn(test.ctx, test.dir, 'benchmark-admit')
      expect((await run(test, session, '/benchmark admit')).result).toEqual({
        kind: 'success',
        text: 'Admitted 1 benchmark task, 1 duplicate skipped.',
      })
      // Only the open proposal is offered.
      expect(test.benchmark.admitted[0]?.map(input => input.capability)).toEqual(['writer'])
    } finally {
      await shutdown(test)
    }
  })

  it('requires the curriculum store for admit and promotes along the ladder', async () => {
    const test = await harness(true, undefined, { benchmark: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'benchmark-promote')
      expect((await run(test, session, '/benchmark admit')).result).toEqual({
        kind: 'error',
        text: 'The evolution curriculum store is not mounted; admit needs open proposals.',
      })
      test.benchmark.tasks = [{
        id: 'aa-bb-cc',
        hash: 'h1',
        capability: 'writer',
        task: 'Recover from boom',
        gists: ['boom'],
        sourceSessions: ['s1'],
        at: '2026-09-12T00:00:00.000Z',
        state: 'fresh',
      }, {
        id: 'zz-zz-zz',
        hash: 'h2',
        capability: 'polish',
        task: 'Recover from stale',
        gists: ['stale'],
        sourceSessions: ['s1'],
        at: '2026-09-12T00:00:00.000Z',
        state: 'holdout',
      }]
      // Auto-promote uses the next ladder step.
      expect((await run(test, session, '/benchmark promote aa-bb-cc')).result).toEqual({
        kind: 'success',
        text: "Promoted 'aa-bb-cc' to 'search'.",
      })
      expect(test.benchmark.transitions).toEqual([{ id: 'aa-bb-cc', to: 'search' }])
      // No promotion from the final learnable state.
      expect((await run(test, session, '/benchmark promote zz-zz-zz')).result).toEqual({
        kind: 'error',
        text: "No promotion from 'holdout' for 'zz-zz-zz'",
      })
      // Explicit state and unknown id.
      expect((await run(test, session, '/benchmark promote aa-bb-cc validation')).result).toEqual({
        kind: 'success',
        text: "Promoted 'aa-bb-cc' to 'validation'.",
      })
      expect((await run(test, session, '/benchmark promote ghost')).result).toEqual({
        kind: 'error',
        text: "evolution-benchmark: unknown task 'ghost'",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('retires and maps transition failures', async () => {
    const test = await harness(true, undefined, { benchmark: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'benchmark-retire')
      expect((await run(test, session, '/benchmark retire aa-bb-cc')).result).toEqual({
        kind: 'success',
        text: "Retired 'aa-bb-cc'.",
      })
      expect(test.benchmark.transitions).toEqual([{ id: 'aa-bb-cc', to: 'retired' }])
      test.benchmark.transitionError = new Error('illegal transition')
      expect((await run(test, session, '/benchmark retire aa-bb-cc')).result).toEqual({
        kind: 'error',
        text: 'illegal transition',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/evaluators human command', () => {
  it('reports the store being unmounted and rejects extra words', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'evaluators-usage')
      expect((await run(test, session, '/evaluators')).result).toEqual({
        kind: 'error',
        text: 'The evaluator-health store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { evaluatorHealth: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'evaluators-extra')
      expect((await run(mounted, session, '/evaluators runs a b')).result).toEqual({
        kind: 'error',
        text: 'Usage: /evaluators [runs [<skill>]]',
      })
      expect((await run(mounted, session, '/evaluators nope')).result).toEqual({
        kind: 'error',
        text: 'Usage: /evaluators [runs [<skill>]]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('summarizes evaluator health with rates, drift, and channels', async () => {
    const test = await harness(true, undefined, { evaluatorHealth: true })
    try {
      test.evaluatorHealth.summary = {
        runs: 4,
        unanimousRate: 0.5,
        approvalRate: 0.25,
        recentApprovalRate: 0.5,
        drift: 0.25,
        falsePositiveRate: 0,
        channels: [
          { channel: 'contract', runs: 4, approved: 3, approvalRate: 0.75 },
          { channel: 'routing', runs: 4, approved: 2, approvalRate: 0.5 },
          { channel: 'replay', runs: 4, approved: 1, approvalRate: 0.25 },
        ],
      }
      const session = sessionIn(test.ctx, test.dir, 'evaluators-summary')
      expect((await run(test, session, '/evaluators')).result).toEqual({
        kind: 'success',
        text: [
          'Evaluator health: 4 verdicts, approved 25% (recent 50%, drift +25 points), unanimous 50%, false positives 0% of approvals.',
          'Channels: contract 75%, routing 50%, replay 25%.',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists recorded verdicts, filtering by skill', async () => {
    const test = await harness(true, undefined, { evaluatorHealth: true })
    try {
      test.evaluatorHealth.runs = [{
        id: 'aa-bb-cc',
        skill: 'writer',
        unanimous: true,
        status: 'evaluated',
        approved: true,
        approving: ['contract', 'routing', 'replay'],
        dissenting: [],
        at: '2026-09-12T00:00:00.000Z',
      }, {
        id: 'dd-ee-ff',
        skill: 'polish',
        unanimous: false,
        status: 'evaluated',
        approved: false,
        approving: ['contract', 'routing'],
        dissenting: ['replay'],
        at: '2026-09-11T00:00:00.000Z',
      }]
      const session = sessionIn(test.ctx, test.dir, 'evaluators-runs')
      expect((await run(test, session, '/evaluators runs')).result).toEqual({
        kind: 'success',
        text: [
          '2 verdicts:',
          '- aa-bb-cc writer: evaluated approved unanimous at 2026-09-12T00:00:00.000Z',
          '- dd-ee-ff polish: evaluated (split: replay) at 2026-09-11T00:00:00.000Z',
        ].join('\n'),
      })
      // Filter by skill; unknown skill has no verdicts.
      expect((await run(test, session, '/evaluators runs writer')).result).toEqual({
        kind: 'success',
        text: [
          '1 verdict:',
          '- aa-bb-cc writer: evaluated approved unanimous at 2026-09-12T00:00:00.000Z',
        ].join('\n'),
      })
      expect((await run(test, session, '/evaluators runs absent')).result).toEqual({
        kind: 'success',
        text: 'No recorded evaluator verdicts.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/population human command', () => {
  const candidate = (overrides: Partial<PopulationCandidate> & { candidateId: string }): PopulationCandidate => ({
    skill: 'writer',
    parentCandidateId: null,
    operator: 'rewrite',
    generation: 1,
    novelty: 0.5,
    triple: { pass: true, tokens: 3, wallTimeMs: 5 },
    status: 'staged',
    at: '2026-09-12T00:00:00.000Z',
    ...overrides,
  })

  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'population-usage')
      expect((await run(test, session, '/population')).result).toEqual({
        kind: 'error',
        text: 'The evolution population store is not mounted.',
      })
      expect((await run(test, session, '/population writer')).result).toEqual({
        kind: 'error',
        text: 'The evolution population store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { population: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'population-grammar')
      expect((await run(mounted, session, '/population')).result).toEqual({
        kind: 'error',
        text: 'Usage: /population <skill> [lineage <id> | approve <id> | reject <id>]',
      })
      expect((await run(mounted, session, '/population writer approve')).result).toEqual({
        kind: 'error',
        text: 'Usage: /population <skill> [lineage <id> | approve <id> | reject <id>]',
      })
      expect((await run(mounted, session, '/population writer bogus staged-0')).result).toEqual({
        kind: 'error',
        text: 'Usage: /population <skill> [lineage <id> | approve <id> | reject <id>]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('lists a skill\'s population with generations, standings, and elite', async () => {
    const test = await harness(true, undefined, { population: true })
    try {
      test.population.candidates = {
        writer: [
          candidate({ candidateId: 'staged-2', generation: 3, parentCandidateId: 'staged-1', triple: null }),
          candidate({ candidateId: 'staged-1', generation: 2, parentCandidateId: 'staged-0', operator: 'compress', triple: { pass: true, tokens: 7, wallTimeMs: 9 }, status: 'approved' }),
          candidate({ candidateId: 'staged-0', generation: 1 }),
        ],
      }
      const session = sessionIn(test.ctx, test.dir, 'population-list')
      expect((await run(test, session, '/population writer')).result).toEqual({
        kind: 'success',
        text: [
          "Population 'writer': generation 3, 3 candidates.",
          '- g3 staged-2 [staged] rewrite: unmeasured ← staged-1',
          '- g2 staged-1 [approved] compress: true pass, 7 tokens, 9ms ← staged-0',
          '- g1 staged-0 [staged] rewrite: true pass, 3 tokens, 5ms · root',
          'Elite: staged-1 (g2).',
        ].join('\n'),
      })
      // A skill with no candidates says so.
      expect((await run(test, session, '/population absent')).result).toEqual({
        kind: 'success',
        text: "No candidates recorded for 'absent'.",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('walks one candidate\'s lineage oldest first', async () => {
    const test = await harness(true, undefined, { population: true })
    try {
      test.population.lineages['writer/staged-2'] = [
        candidate({ candidateId: 'staged-0', generation: 1 }),
        candidate({ candidateId: 'staged-1', generation: 2, parentCandidateId: 'staged-0' }),
        candidate({ candidateId: 'staged-2', generation: 3, parentCandidateId: 'staged-1', triple: null }),
      ]
      const session = sessionIn(test.ctx, test.dir, 'population-lineage')
      expect((await run(test, session, '/population writer lineage staged-2')).result).toEqual({
        kind: 'success',
        text: [
          "Lineage of 'staged-2' in 'writer':",
          '- g1 staged-0 [staged] rewrite',
          '- g2 staged-1 [staged] rewrite',
          '- g3 staged-2 [staged] rewrite ← newest',
        ].join('\n'),
      })
      expect(test.population.lineageCalls).toEqual([{ skill: 'writer', candidateId: 'staged-2' }])
      expect((await run(test, session, '/population writer lineage ghost')).result).toEqual({
        kind: 'error',
        text: "No candidate 'ghost' for skill 'writer'.",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('approves and rejects staged candidates, propagating store errors', async () => {
    const test = await harness(true, undefined, { population: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'population-status')
      expect((await run(test, session, '/population writer approve staged-1')).result).toEqual({
        kind: 'success',
        text: "Marked candidate 'staged-1' (g1 writer) as 'approved'.",
      })
      expect((await run(test, session, '/population writer reject staged-0')).result).toEqual({
        kind: 'success',
        text: "Marked candidate 'staged-0' (g1 writer) as 'rejected'.",
      })
      expect(test.population.statusCalls).toEqual([
        { candidateId: 'staged-1', status: 'approved' },
        { candidateId: 'staged-0', status: 'rejected' },
      ])
      test.population.statusError = new Error("evolution-population: unknown candidate 'ghost'")
      expect((await run(test, session, '/population writer approve ghost')).result).toEqual({
        kind: 'error',
        text: "evolution-population: unknown candidate 'ghost'",
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/routes human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'routes-unmounted')
      expect((await run(test, session, '/routes')).result).toEqual({
        kind: 'error',
        text: 'The evolution model-routes store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { routes: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'routes-grammar')
      expect((await run(mounted, session, '/routes pin')).result).toEqual({
        kind: 'error',
        text: 'Usage: /routes [pin <role> <provider> <model> | evidence [<role>]]',
      })
      expect((await run(mounted, session, '/routes pin bogus deepseek chat')).result).toEqual({
        kind: 'error',
        text: 'Usage: /routes [pin <role> <provider> <model> | evidence [<role>]]',
      })
      expect((await run(mounted, session, '/routes bogus')).result).toEqual({
        kind: 'error',
        text: 'Usage: /routes [pin <role> <provider> <model> | evidence [<role>]]',
      })
      expect((await run(mounted, session, '/routes evidence bogus')).result).toEqual({
        kind: 'error',
        text: 'Usage: /routes [pin <role> <provider> <model> | evidence [<role>]]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('lists per-role assignments with evidence and the recommended route', async () => {
    const test = await harness(true, undefined, { routes: true })
    try {
      test.routes.summaries = [
        { role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat', origin: 'observed', runs: 2, passRate: 1, meanTokens: 3, lastAt: '2026-09-12T00:00:00.000Z' },
        { role: 'evaluation', provider: 'deepseek', model: 'deepseek-reasoner', origin: 'pinned', runs: 0, passRate: 0, meanTokens: 0, lastAt: null },
      ]
      test.routes.recommend = role => role === 'candidate-generation'
        ? { provider: 'deepseek', model: 'deepseek-chat' }
        : undefined
      const session = sessionIn(test.ctx, test.dir, 'routes-list')
      expect((await run(test, session, '/routes')).result).toEqual({
        kind: 'success',
        text: [
          'Routes:',
          'candidate-generation: deepseek/deepseek-chat: 2 runs, 100% pass, 3 tokens avg → recommended deepseek/deepseek-chat',
          'evaluation: deepseek/deepseek-reasoner (pinned): 0 runs, 0% pass, 0 tokens avg',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
    const empty = await harness(true, undefined, { routes: true })
    try {
      const session = sessionIn(empty.ctx, empty.dir, 'routes-empty')
      expect((await run(empty, session, '/routes')).result).toEqual({
        kind: 'success',
        text: 'No route assignments yet. The optimizer records candidate-generation routes; pin the rest.',
      })
    } finally {
      await shutdown(empty)
    }
  })

  it('pins a route for a role and propagates store errors', async () => {
    const test = await harness(true, undefined, { routes: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'routes-pin')
      expect((await run(test, session, '/routes pin candidate-generation deepseek deepseek-chat')).result).toEqual({
        kind: 'success',
        text: "Pinned 'candidate-generation' to deepseek/deepseek-chat.",
      })
      expect(test.routes.pins).toEqual([{ role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat' }])
      test.routes.pinError = new Error('routes disk on fire')
      expect((await run(test, session, '/routes pin evaluation deepseek deepseek-reasoner')).result).toEqual({
        kind: 'error',
        text: 'routes disk on fire',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists recorded evidence, optionally filtered by role', async () => {
    const test = await harness(true, undefined, { routes: true })
    try {
      test.routes.evidence = [{
        id: 'aa-bb-cc',
        role: 'candidate-generation',
        provider: 'deepseek',
        model: 'deepseek-chat',
        pass: true,
        tokens: 10,
        wallTimeMs: 100,
        at: '2026-09-12T00:00:00.000Z',
      }, {
        id: 'dd-ee-ff',
        role: 'evaluation',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        pass: false,
        tokens: 8,
        wallTimeMs: 80,
        at: '2026-09-11T00:00:00.000Z',
      }]
      const session = sessionIn(test.ctx, test.dir, 'routes-evidence')
      expect((await run(test, session, '/routes evidence')).result).toEqual({
        kind: 'success',
        text: [
          '2 evidence rows:',
          '- aa-bb-cc candidate-generation: deepseek/deepseek-chat true pass, 10 tokens at 2026-09-12T00:00:00.000Z',
          '- dd-ee-ff evaluation: deepseek/deepseek-reasoner false pass, 8 tokens at 2026-09-11T00:00:00.000Z',
        ].join('\n'),
      })
      expect((await run(test, session, '/routes evidence evaluation')).result).toEqual({
        kind: 'success',
        text: [
          '1 evidence row:',
          '- dd-ee-ff evaluation: deepseek/deepseek-reasoner false pass, 8 tokens at 2026-09-11T00:00:00.000Z',
        ].join('\n'),
      })
      expect((await run(test, session, '/routes evidence promotion-review')).result).toEqual({
        kind: 'success',
        text: 'No recorded route evidence.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/canary human command', () => {
  const record = (overrides: Partial<DeploymentRecord> & { id: string }): DeploymentRecord => ({
    skill: 'writer',
    state: 'shadow',
    triple: null,
    at: '2026-09-12T00:00:00.000Z',
    enteredAt: '2026-09-12T00:00:00.000Z',
    decidedAt: null,
    ...overrides,
  })

  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'canary-unmounted')
      expect((await run(test, session, '/canary')).result).toEqual({
        kind: 'error',
        text: 'The evolution canary store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { canary: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'canary-grammar')
      expect((await run(mounted, session, '/canary rollout')).result).toEqual({
        kind: 'error',
        text: 'Usage: /canary [status [<skill>] | rollout <id> | promote <id> | reject <id> | rollback <id>]',
      })
      expect((await run(mounted, session, '/canary bogus aa')).result).toEqual({
        kind: 'error',
        text: 'Usage: /canary [status [<skill>] | rollout <id> | promote <id> | reject <id> | rollback <id>]',
      })
      expect((await run(mounted, session, '/canary status a b')).result).toEqual({
        kind: 'error',
        text: 'Usage: /canary [status [<skill>] | rollout <id> | promote <id> | reject <id> | rollback <id>]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('lists deployment states with their next ladder step', async () => {
    const test = await harness(true, undefined, { canary: true })
    try {
      test.canary.records = [
        record({ id: 'aa-bb-cc', skill: 'writer', state: 'shadow', triple: { pass: true, tokens: 3, wallTimeMs: 5 } }),
        record({ id: 'dd-ee-ff', skill: 'polish', state: 'canary' }),
        record({ id: 'ee-ff-00', skill: 'writer', state: 'promoted', decidedAt: '2026-09-12T00:00:00.000Z' }),
        record({ id: '00-11-22', skill: 'writer', state: 'rejected', decidedAt: '2026-09-12T00:00:00.000Z' }),
      ]
      const session = sessionIn(test.ctx, test.dir, 'canary-list')
      expect((await run(test, session, '/canary')).result).toEqual({
        kind: 'success',
        text: [
          'Canary: 1 shadow, 1 canary, 1 promoted, 0 rolled-back, 1 rejected.',
          '- aa-bb-cc writer: shadow → next canary (true pass, 3 tokens)',
          '- dd-ee-ff polish: canary → next promoted',
          '- ee-ff-00 writer: promoted',
          '- 00-11-22 writer: rejected',
        ].join('\n'),
      })
      // Filtering by skill rescopes both the counts and the rows.
      expect((await run(test, session, '/canary status writer')).result).toEqual({
        kind: 'success',
        text: [
          'Canary: 1 shadow, 0 canary, 1 promoted, 0 rolled-back, 1 rejected.',
          '- aa-bb-cc writer: shadow → next canary (true pass, 3 tokens)',
          '- ee-ff-00 writer: promoted',
          '- 00-11-22 writer: rejected',
        ].join('\n'),
      })
      expect((await run(test, session, '/canary status absent')).result).toEqual({
        kind: 'success',
        text: "No deployments for 'absent'.",
      })
    } finally {
      await shutdown(test)
    }
    const empty = await harness(true, undefined, { canary: true })
    try {
      const session = sessionIn(empty.ctx, empty.dir, 'canary-empty')
      expect((await run(empty, session, '/canary')).result).toEqual({
        kind: 'success',
        text: 'No deployments yet. The optimizer records staged writes as shadow.',
      })
    } finally {
      await shutdown(empty)
    }
  })

  it('rolls a deployment forward or exits it, propagating store errors', async () => {
    const test = await harness(true, undefined, { canary: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'canary-advance')
      expect((await run(test, session, '/canary rollout aa-bb-cc')).result).toEqual({
        kind: 'success',
        text: "Deployment 'aa-bb-cc' (writer) moved to 'canary'.",
      })
      expect((await run(test, session, '/canary promote aa-bb-cc')).result).toEqual({
        kind: 'success',
        text: "Deployment 'aa-bb-cc' (writer) moved to 'promoted'.",
      })
      expect((await run(test, session, '/canary reject dd-ee-ff')).result).toEqual({
        kind: 'success',
        text: "Deployment 'dd-ee-ff' (writer) moved to 'rejected'.",
      })
      expect((await run(test, session, '/canary rollback ee-ff-00')).result).toEqual({
        kind: 'success',
        text: "Deployment 'ee-ff-00' (writer) moved to 'rolled-back'.",
      })
      expect(test.canary.advances).toEqual([
        { id: 'aa-bb-cc', to: 'canary' },
        { id: 'aa-bb-cc', to: 'promoted' },
        { id: 'dd-ee-ff', to: 'rejected' },
        { id: 'ee-ff-00', to: 'rolled-back' },
      ])
      test.canary.advanceError = new Error("evolution-canary: unknown deployment 'ghost'")
      expect((await run(test, session, '/canary rollout ghost')).result).toEqual({
        kind: 'error',
        text: "evolution-canary: unknown deployment 'ghost'",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('amends the matching lineage envelope\'s outcome when a deployment exits to rejected or rolled-back', async () => {
    const test = await harness(true, undefined, { canary: true, lineage: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'canary-lineage-amend')
      await run(test, session, '/canary reject dd-ee-ff')
      await run(test, session, '/canary rollback ee-ff-00')
      expect(test.lineage.amendments).toEqual([
        { id: 'dd-ee-ff', outcome: 'regressed', rejectedReason: 'deployment rejected by an operator after promotion' },
        { id: 'ee-ff-00', outcome: 'regressed', rejectedReason: 'deployment rolled-back by an operator after promotion' },
      ])
      // Rolling out or promoting never touches lineage: only the two exits do.
      await run(test, session, '/canary rollout aa-bb-cc')
      expect(test.lineage.amendments).toHaveLength(2)
      // A lineage amendment failure must not surface as a canary error: the
      // transition already landed, and lineage bookkeeping is optional (§58.12).
      test.lineage.amendError = new Error('evolution-lineage: unknown experiment \'ghost-id\'')
      expect((await run(test, session, '/canary reject ghost-id')).result).toEqual({
        kind: 'success',
        text: "Deployment 'ghost-id' (writer) moved to 'rejected'.",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('refuses a promotion the proposing identity would also review', async () => {
    const test = await harness(true, undefined, { canary: true, routes: true })
    test.ctx.provide('evolutionOptimizer', {
      optimize: async () => ({ status: 'staged', stagedId: 'aa-bb-cc', holdout: null }),
    } as never)
    try {
      const proposer = sessionIn(test.ctx, test.dir, 'canary-proposer')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [proposer.id] })
      // The optimization that stages the patch records the identity that
      // proposed it, against the run the deployment shares its id with.
      expect((await run(test, proposer, '/curator optimize writer s1')).result).toMatchObject({ kind: 'success' })
      expect(test.routes.duties).toEqual([
        { runId: 'aa-bb-cc', role: 'candidate-generation', identity: 'canary-proposer', at: '2026-09-12T00:00:00.000Z' },
      ])
      // One identity may not both propose a candidate and review its
      // promotion: the refusal is the operator-visible sentence, the reviewing
      // fill is recorded beside it, and the deployment never leaves `canary`.
      expect((await run(test, proposer, '/canary promote aa-bb-cc')).result).toEqual({
        kind: 'error',
        text: "Promotion of 'aa-bb-cc' refused: identity 'canary-proposer' filled both candidate-generation and promotion-review for run 'aa-bb-cc'",
      })
      expect(test.canary.advances).toEqual([])
      expect(test.routes.duties).toContainEqual({
        runId: 'aa-bb-cc',
        role: 'promotion-review',
        identity: 'canary-proposer',
        at: '2026-09-12T00:00:00.000Z',
      })
      // A distinct identity reviewing the same run promotes it.
      const reviewer = sessionIn(test.ctx, test.dir, 'canary-reviewer')
      expect((await run(test, reviewer, '/canary promote aa-bb-cc')).result).toEqual({
        kind: 'success',
        text: "Deployment 'aa-bb-cc' (writer) moved to 'promoted'.",
      })
      expect(test.canary.advances).toEqual([{ id: 'aa-bb-cc', to: 'promoted' }])
      // A run whose proposing identity was never recorded is refused as
      // unknown rather than read as separated.
      expect((await run(test, reviewer, '/canary promote dd-ee-ff')).result).toEqual({
        kind: 'error',
        text: "Promotion of 'dd-ee-ff' refused: run 'dd-ee-ff' records no candidate-generation identity, so candidate-generation and promotion-review cannot be shown to be separate identities",
      })
      // A reviewing fill that cannot be written refuses too, rather than
      // leaving the promotion to an identity an earlier attempt recorded.
      test.routes.dutyError = new Error('duty store is down')
      expect((await run(test, reviewer, '/canary promote ee-ff-00')).result).toEqual({
        kind: 'error',
        text: "Promotion of 'ee-ff-00' refused: the promotion-review identity could not be recorded (Error: duty store is down)",
      })
      expect(test.canary.advances).toEqual([{ id: 'aa-bb-cc', to: 'promoted' }])
    } finally {
      await shutdown(test)
    }
  })
})

describe('/novelty human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'novelty-unmounted')
      expect((await run(test, session, '/novelty')).result).toEqual({
        kind: 'error',
        text: 'The evolution novelty-search store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { novelty: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'novelty-grammar')
      expect((await run(mounted, session, '/novelty writer extra')).result).toEqual({
        kind: 'error',
        text: 'Usage: /novelty [<skill>]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('summarizes the archive across skills with mean novelty', async () => {
    const test = await harness(true, undefined, { novelty: true })
    try {
      test.novelty.entries = [
        { candidateId: 'staged-2', skill: 'writer', features: ['a', 'b'], novelty: 0.5, at: '2026-09-12T00:00:00.000Z' },
        { candidateId: 'staged-1', skill: 'writer', features: ['c'], novelty: 1, at: '2026-09-12T00:00:00.000Z' },
        { candidateId: 'staged-0', skill: 'reader', features: ['x'], novelty: 1, at: '2026-09-12T00:00:00.000Z' },
      ]
      test.novelty.means = { writer: 0.75, reader: 1 }
      const session = sessionIn(test.ctx, test.dir, 'novelty-summary')
      expect((await run(test, session, '/novelty')).result).toEqual({
        kind: 'success',
        text: [
          'Novelty archive: 3 entries across 2 skills.',
          '- reader: 1 entry, mean novelty 1.00',
          '- writer: 2 entries, mean novelty 0.75',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists one skill\'s archive entries with their novelty', async () => {
    const test = await harness(true, undefined, { novelty: true })
    try {
      test.novelty.entries = [
        { candidateId: 'staged-2', skill: 'writer', features: ['a', 'b'], novelty: 0.5, at: '2026-09-12T00:00:00.000Z' },
        { candidateId: 'staged-0', skill: 'reader', features: ['x'], novelty: 1, at: '2026-09-12T00:00:00.000Z' },
      ]
      test.novelty.means = { writer: 0.5 }
      const session = sessionIn(test.ctx, test.dir, 'novelty-skill')
      expect((await run(test, session, '/novelty writer')).result).toEqual({
        kind: 'success',
        text: [
          "Novelty archive 'writer': 1 entry, mean 0.50.",
          '- staged-2: 2 features, novelty 0.50 at 2026-09-12T00:00:00.000Z',
        ].join('\n'),
      })
      expect((await run(test, session, '/novelty absent')).result).toEqual({
        kind: 'success',
        text: "No recorded novelty archive entries for 'absent'.",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports an honest empty archive', async () => {
    const test = await harness(true, undefined, { novelty: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'novelty-empty')
      expect((await run(test, session, '/novelty')).result).toEqual({
        kind: 'success',
        text: 'No recorded novelty archive entries. The optimizer records staged writes as descriptors.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/stagnation human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'stagnation-unmounted')
      expect((await run(test, session, '/stagnation')).result).toEqual({
        kind: 'error',
        text: 'The evolution stagnation store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { stagnation: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'stagnation-grammar')
      expect((await run(mounted, session, '/stagnation bogus')).result).toEqual({
        kind: 'error',
        text: 'Usage: /stagnation [status <skill> | runs [<skill>] | reset <skill>]',
      })
      expect((await run(mounted, session, '/stagnation status')).result).toEqual({
        kind: 'error',
        text: 'Usage: /stagnation [status <skill> | runs [<skill>] | reset <skill>]',
      })
      expect((await run(mounted, session, '/stagnation reset a b')).result).toEqual({
        kind: 'error',
        text: 'Usage: /stagnation [status <skill> | runs [<skill>] | reset <skill>]',
      })
      expect((await run(mounted, session, '/stagnation runs a b')).result).toEqual({
        kind: 'error',
        text: 'Usage: /stagnation [status <skill> | runs [<skill>] | reset <skill>]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('renders one skill\'s status with its recommended strategy', async () => {
    const test = await harness(true, undefined, { stagnation: true })
    try {
      test.stagnation.statuses.writer = {
        skill: 'writer',
        runs: 6,
        bestScore: { pass: true, tokens: 3, wallTimeMs: 5 },
        generationsSinceImprovement: 5,
        stagnant: true,
        threshold: 5,
        strategy: 'diversity',
      }
      const session = sessionIn(test.ctx, test.dir, 'stagnation-status')
      expect((await run(test, session, '/stagnation status writer')).result).toEqual({
        kind: 'success',
        text: [
          "Stagnation 'writer': 6 runs, best true pass, 3 tokens, 5ms.",
          '5 generations since improvement, threshold 5.',
          'STAGNANT → strategy: diversity',
        ].join('\n'),
      })
      // A skill without runs reports the honest empty standing.
      expect((await run(test, session, '/stagnation status fresh')).result).toEqual({
        kind: 'success',
        text: [
          "Stagnation 'fresh': 0 runs, best no best yet.",
          '0 generations since improvement, threshold 5.',
          'Not stagnant — continue exploitation.',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists runs and summarizes every skill in the bare view', async () => {
    const test = await harness(true, undefined, { stagnation: true })
    try {
      test.stagnation.runs = [
        { runId: 'staged-2', skill: 'writer', generation: 2, score: { pass: true, tokens: 3, wallTimeMs: 5 }, improved: false, at: '2026-09-12T00:00:00.000Z' },
        { runId: 'staged-1', skill: 'writer', generation: 1, score: { pass: true, tokens: 3, wallTimeMs: 5 }, improved: true, at: '2026-09-12T00:00:00.000Z' },
        { runId: 'staged-0', skill: 'reader', generation: 1, score: { pass: false, tokens: 9, wallTimeMs: 9 }, improved: false, at: '2026-09-12T00:00:00.000Z' },
      ]
      test.stagnation.statuses.writer = {
        skill: 'writer',
        runs: 2,
        bestScore: { pass: true, tokens: 3, wallTimeMs: 5 },
        generationsSinceImprovement: 1,
        stagnant: false,
        threshold: 5,
        strategy: 'exploitation',
      }
      const session = sessionIn(test.ctx, test.dir, 'stagnation-runs')
      expect((await run(test, session, '/stagnation runs writer')).result).toEqual({
        kind: 'success',
        text: [
          '2 runs:',
          '- g2 staged-2 writer: true pass, 3 tokens, 5ms at 2026-09-12T00:00:00.000Z',
          '- g1 staged-1 writer: true pass, 3 tokens, 5ms improved at 2026-09-12T00:00:00.000Z',
        ].join('\n'),
      })
      expect((await run(test, session, '/stagnation runs absent')).result).toEqual({
        kind: 'success',
        text: 'No recorded stagnation runs.',
      })
      expect((await run(test, session, '/stagnation')).result).toEqual({
        kind: 'success',
        text: [
          'Stagnation:',
          '- reader: 0/5 generations since improvement — ok',
          '- writer: 1/5 generations since improvement — ok',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('resets a skill\'s history and propagates store errors', async () => {
    const test = await harness(true, undefined, { stagnation: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'stagnation-reset')
      expect((await run(test, session, '/stagnation reset writer')).result).toEqual({
        kind: 'success',
        text: "Reset stagnation history of 'writer': dropped 2 runs.",
      })
      expect(test.stagnation.resets).toEqual(['writer'])
      test.stagnation.resetError = new Error('evolution-stagnation: reset failed')
      expect((await run(test, session, '/stagnation reset writer')).result).toEqual({
        kind: 'error',
        text: 'evolution-stagnation: reset failed',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports an honest empty run log', async () => {
    const test = await harness(true, undefined, { stagnation: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'stagnation-empty')
      expect((await run(test, session, '/stagnation')).result).toEqual({
        kind: 'success',
        text: 'No recorded stagnation runs. The optimizer records staged writes as runs.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/islands human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'islands-unmounted')
      expect((await run(test, session, '/islands')).result).toEqual({
        kind: 'error',
        text: 'The evolution islands store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { islands: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'islands-grammar')
      const usage = 'Usage: /islands [list [<skill>] | register <island> <name> <objective> <skill> | migrate <from> <to> <candidate> [<reason>] | migrations [<skill>]]'
      expect((await run(mounted, session, '/islands bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/islands register a')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/islands register a Lane bogus writer')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/islands migrate a')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/islands migrate a b c bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/islands migrate a b c d e')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/islands migrations a b')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/islands list a b')).result).toEqual({ kind: 'error', text: usage })
    } finally {
      await shutdown(mounted)
    }
  })

  it('registers an island lane for a skill', async () => {
    const test = await harness(true, undefined, { islands: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'islands-register')
      expect((await run(test, session, '/islands register stable Lane conservative writer')).result).toEqual({
        kind: 'success',
        text: "Registered island 'stable' 'Lane' [conservative] for 'writer'.",
      })
      expect(test.islands.registers).toEqual([{ islandId: 'stable', name: 'Lane', objective: 'conservative', skill: 'writer' }])
      test.islands.registerError = new Error("evolution-islands: island 'stable' already exists")
      expect((await run(test, session, '/islands register stable Lane conservative writer')).result).toEqual({
        kind: 'error',
        text: "evolution-islands: island 'stable' already exists",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('records a candidate migration with a default or explicit reason', async () => {
    const test = await harness(true, undefined, { islands: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'islands-migrate')
      expect((await run(test, session, '/islands migrate stable diverse staged-0')).result).toEqual({
        kind: 'success',
        text: "Migrated candidate 'staged-0' stable → diverse (schedule).",
      })
      expect((await run(test, session, '/islands migrate stable diverse staged-1 elite')).result).toEqual({
        kind: 'success',
        text: "Migrated candidate 'staged-1' stable → diverse (elite).",
      })
      expect(test.islands.migrateCalls).toEqual([
        { fromIslandId: 'stable', toIslandId: 'diverse', candidateId: 'staged-0', reason: 'schedule' },
        { fromIslandId: 'stable', toIslandId: 'diverse', candidateId: 'staged-1', reason: 'elite' },
      ])
      test.islands.migrateError = new Error("evolution-islands: unknown island 'ghost'")
      expect((await run(test, session, '/islands migrate ghost diverse staged-0')).result).toEqual({
        kind: 'error',
        text: "evolution-islands: unknown island 'ghost'",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists islands with their migration schedule and the migration log', async () => {
    const test = await harness(true, undefined, { islands: true })
    try {
      test.islands.schedule = [
        {
          island: { islandId: 'stable', name: 'Stable lane', objective: 'conservative', skill: 'writer', generation: 3, lastActivityAt: '2026-09-12T00:00:00.000Z', at: '2026-09-01T00:00:00.000Z' },
          lastMigrationAt: '2026-09-10T00:00:00.000Z',
          due: true,
        },
        {
          island: { islandId: 'fresh', name: 'Fresh C', objective: 'cost', skill: 'writer', generation: 0, lastActivityAt: null, at: '2026-09-12T00:00:00.000Z' },
          lastMigrationAt: null,
          due: false,
        },
      ]
      test.islands.migrations = [
        { migrationId: 'mig-2', fromIslandId: 'stable', toIslandId: 'diverse', candidateId: 'staged-1', skill: 'writer', reason: 'elite', at: '2026-09-11T00:00:00.000Z' },
        { migrationId: 'mig-1', fromIslandId: 'stable', toIslandId: 'diverse', candidateId: 'staged-0', skill: 'writer', reason: 'schedule', at: '2026-09-10T00:00:00.000Z' },
      ]
      const session = sessionIn(test.ctx, test.dir, 'islands-list')
      expect((await run(test, session, '/islands list writer')).result).toEqual({
        kind: 'success',
        text: [
          "Islands 'writer':",
          "- stable 'Stable lane' [conservative] writer g3 · migration due",
          "- fresh 'Fresh C' [cost] writer g0",
        ].join('\n'),
      })
      expect((await run(test, session, '/islands migrations')).result).toEqual({
        kind: 'success',
        text: [
          '2 migrations:',
          '- mig-2 staged-1 stable → diverse (elite) at 2026-09-11T00:00:00.000Z',
          '- mig-1 staged-0 stable → diverse (schedule) at 2026-09-10T00:00:00.000Z',
        ].join('\n'),
      })
      expect((await run(test, session, '/islands list absent')).result).toEqual({
        kind: 'success',
        text: 'No islands registered. Define a skill\'s lanes with `/islands register <island> <name> <objective> <skill>`.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/selfmodel human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'selfmodel-unmounted')
      expect((await run(test, session, '/selfmodel')).result).toEqual({
        kind: 'error',
        text: 'The evolution self-model store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { selfModel: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'selfmodel-grammar')
      expect((await run(mounted, session, '/selfmodel a b')).result).toEqual({
        kind: 'error',
        text: 'Usage: /selfmodel [<skill>]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('renders one skill\'s self-assessment and the capability frontier', async () => {
    const test = await harness(true, undefined, { selfModel: true })
    try {
      test.selfModel.assessments.writer = {
        strengths: ['prose'], weaknesses: ['shell'], uncertainAreas: ['web'],
        failureModes: ['stale context'], preferredTools: ['edit'], evaluatorBlindspots: ['routing'],
        confidence: 0.8, revision: 2, at: '2026-09-12T00:00:00.000Z',
      }
      test.selfModel.gaps = [
        { capability: 'shell', score: 0.2, confidence: 0.5, coveringSkills: ['writer'], observations: 4 },
        { capability: 'prose', score: 0.9, confidence: 1, coveringSkills: ['writer'], observations: 10 },
      ]
      test.selfModel.next = { capability: 'shell' }
      const session = sessionIn(test.ctx, test.dir, 'selfmodel-render')
      expect((await run(test, session, '/selfmodel writer')).result).toEqual({
        kind: 'success',
        text: [
          "Self-model 'writer' (revision 2, confidence 0.80):",
          '- strengths: prose',
          '- weaknesses: shell',
          '- uncertain areas: web',
          '- failure modes: stale context',
          '- preferred tools: edit',
          '- evaluator blindspots: routing',
        ].join('\n'),
      })
      expect((await run(test, session, '/selfmodel absent')).result).toEqual({
        kind: 'success',
        text: "No self-assessment recorded for 'absent'.",
      })
      expect((await run(test, session, '/selfmodel')).result).toEqual({
        kind: 'success',
        text: [
          'Capability frontier (weakest first): 2',
          '- shell: score 0.20, confidence 0.50, 1 skill, 4 observations',
          '- prose: score 0.90, confidence 1.00, 1 skill, 10 observations',
          'Next to learn: shell',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports an honest empty frontier', async () => {
    const test = await harness(true, undefined, { selfModel: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'selfmodel-empty')
      expect((await run(test, session, '/selfmodel')).result).toEqual({
        kind: 'success',
        text: 'No measured capabilities yet. The optimizer records capability observations as it stages writes.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/uncertainty human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'uncertainty-unmounted')
      expect((await run(test, session, '/uncertainty')).result).toEqual({
        kind: 'error',
        text: 'The evolution uncertainty store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { uncertainty: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'uncertainty-grammar')
      expect((await run(mounted, session, '/uncertainty a b')).result).toEqual({
        kind: 'error',
        text: 'Usage: /uncertainty [<skill>]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('renders the prioritized evaluation queue, optionally per skill', async () => {
    const test = await harness(true, undefined, { uncertainty: true })
    try {
      test.uncertainty.queue = [
        { skill: 'writer', taskId: null, kinds: ['disagreement', 'instability'], priority: 0.9, signals: 4 },
        { skill: 'reader', taskId: 't1', kinds: ['low-confidence'], priority: 0.6, signals: 1 },
      ]
      const session = sessionIn(test.ctx, test.dir, 'uncertainty-queue')
      expect((await run(test, session, '/uncertainty')).result).toEqual({
        kind: 'success',
        text: [
          'Evaluation queue: 2',
          '- writer (skill-wide): priority 0.90, [disagreement, instability], 4 signals',
          '- reader task t1: priority 0.60, [low-confidence], 1 signals',
        ].join('\n'),
      })
      expect((await run(test, session, '/uncertainty writer')).result).toEqual({
        kind: 'success',
        text: [
          "Evaluation queue 'writer': 1",
          '- writer (skill-wide): priority 0.90, [disagreement, instability], 4 signals',
        ].join('\n'),
      })
      expect((await run(test, session, '/uncertainty absent')).result).toEqual({
        kind: 'success',
        text: 'No uncertainty signals. The scorer records evaluator disagreement as signals.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/adversary human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'adversary-unmounted')
      expect((await run(test, session, '/adversary')).result).toEqual({
        kind: 'error',
        text: 'The evolution adversary store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { adversary: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'adversary-grammar')
      const usage = 'Usage: /adversary [list [<skill>] | probe <skill> <category> <probe> | repair <probeId> | challenge <skill> | defenses | defense <name> <satisfied>]'
      expect((await run(mounted, session, '/adversary bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary probe')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary probe writer')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary probe writer bogus p')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary repair')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary challenge')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary defenses extra')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary defense')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary defense bogus true')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary defense multiple-evaluators maybe')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/adversary list a b')).result).toEqual({ kind: 'error', text: usage })
    } finally {
      await shutdown(mounted)
    }
  })

  it('records and repairs probes and reads the next challenge', async () => {
    const test = await harness(true, undefined, { adversary: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'adversary-probe')
      expect((await run(test, session, '/adversary probe writer prompt-injection drop the prefix')).result).toEqual({
        kind: 'success',
        text: "Recorded a 'prompt-injection' probe for 'writer'. Mark it repaired with /adversary repair <id> once the weakness is fixed.",
      })
      expect(test.adversary.probeCalls[0]).toMatchObject({
        skill: 'writer',
        category: 'prompt-injection',
        probe: 'drop the prefix',
        foundWeakness: false,
      })
      expect(() => {
        const id = (test.adversary.probeCalls[0] as { probeId: string }).probeId
        expect(id).toMatch(/^[0-9a-f-]{36}$/)
      }).not.toThrow()
      test.adversary.challenges.writer = { category: 'retrieval-trap', probed: 1, reason: 'retrieval-trap has 1 probes, below the 1 minimum' }
      expect((await run(test, session, '/adversary challenge writer')).result).toEqual({
        kind: 'success',
        text: "Next adversarial probe for 'retrieval-trap' (1 recorded): retrieval-trap has 1 probes, below the 1 minimum",
      })
      expect((await run(test, session, '/adversary repair staged-9')).result).toEqual({
        kind: 'success',
        text: "Marked probe 'staged-9' repaired.",
      })
      expect(test.adversary.repairs).toEqual(['staged-9'])
      test.adversary.repairError = new Error("evolution-adversary: unknown probe 'ghost'")
      expect((await run(test, session, '/adversary repair ghost')).result).toEqual({
        kind: 'error',
        text: "evolution-adversary: unknown probe 'ghost'",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists probes and tracks the defense checklist', async () => {
    const test = await harness(true, undefined, { adversary: true })
    try {
      test.adversary.probes = [
        { probeId: 'probe-2', skill: 'writer', category: 'edge-case', probe: 'empty input', foundWeakness: true, repaired: true },
        { probeId: 'probe-1', skill: 'writer', category: 'prompt-injection', probe: 'ignore instructions', foundWeakness: false, repaired: false },
      ]
      test.adversary.defenses = [
        { defense: 'multiple-evaluators', satisfied: true },
        { defense: 'hidden-holdout', satisfied: false },
      ]
      const session = sessionIn(test.ctx, test.dir, 'adversary-list')
      expect((await run(test, session, '/adversary list writer')).result).toEqual({
        kind: 'success',
        text: [
          "Adversarial probes 'writer': 2",
          '- probe-2 [edge-case] writer: weakness found · repaired',
          '- probe-1 [prompt-injection] writer: no weakness',
        ].join('\n'),
      })
      expect((await run(test, session, '/adversary defenses')).result).toEqual({
        kind: 'success',
        text: [
          'Evaluator-gaming defenses:',
          '- multiple-evaluators: satisfied',
          '- hidden-holdout: open',
        ].join('\n'),
      })
      expect((await run(test, session, '/adversary defense multiple-evaluators false')).result).toEqual({
        kind: 'success',
        text: "Set defense 'multiple-evaluators' to open.",
      })
      expect(test.adversary.defenseSets).toEqual([{ defense: 'multiple-evaluators', satisfied: false }])
      expect((await run(test, session, '/adversary list absent')).result).toEqual({
        kind: 'success',
        text: 'No adversarial probes recorded. Record one with /adversary probe <skill> <category> <probe>.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/lineage human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'lineage-unmounted')
      expect((await run(test, session, '/lineage')).result).toEqual({
        kind: 'error',
        text: 'The evolution lineage store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { lineage: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'lineage-grammar')
      const usage = 'Usage: /lineage [list [<skill>] | compare <idA> <idB> | replay <id>]'
      expect((await run(mounted, session, '/lineage bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/lineage compare a')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/lineage replay')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/lineage list a b')).result).toEqual({ kind: 'error', text: usage })
    } finally {
      await shutdown(mounted)
    }
  })

  it('lists experiment envelopes and compares two for comparability', async () => {
    const test = await harness(true, undefined, { lineage: true })
    try {
      test.lineage.experiments = [
        {
          experimentId: 'staged-1', skill: 'writer', operator: 'compress', outcome: 'improved',
          metrics: { pass: true, tokens: 3, wallTimeMs: 5 },
          dependencies: { evaluator: 'scorer-v1', model: 'deepseek/deepseek-chat' },
        },
        {
          experimentId: 'staged-0', skill: 'writer', operator: 'rewrite', outcome: 'improved',
          metrics: { pass: true, tokens: 9, wallTimeMs: 8 },
          dependencies: { evaluator: 'scorer-v1', model: 'deepseek/deepseek-chat' },
        },
      ]
      test.lineage.comparisons['staged-0/staged-1'] = { comparable: true, changed: [] }
      test.lineage.comparisons['staged-1/staged-0'] = { comparable: false, changed: ['model', 'skill'] }
      const session = sessionIn(test.ctx, test.dir, 'lineage-list')
      expect((await run(test, session, '/lineage list writer')).result).toEqual({
        kind: 'success',
        text: [
          "Experiments 'writer' (newest first): 2",
          '- staged-1 writer improved by compress: pass true, 3 tokens, 5ms',
          '- staged-0 writer improved by rewrite: pass true, 9 tokens, 8ms',
        ].join('\n'),
      })
      expect((await run(test, session, '/lineage compare staged-0 staged-1')).result).toEqual({
        kind: 'success',
        text: "'staged-0' vs 'staged-1': comparable — no compared dependency changed.",
      })
      expect((await run(test, session, '/lineage compare staged-1 staged-0')).result).toEqual({
        kind: 'success',
        text: "'staged-1' vs 'staged-0': incomparable — changed dependencies: model, skill.",
      })
      expect((await run(test, session, '/lineage list absent')).result).toEqual({
        kind: 'success',
        text: 'No experiment envelopes recorded. The optimizer records staged writes as envelopes.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('replays one experiment from its record', async () => {
    const test = await harness(true, undefined, { lineage: true })
    try {
      test.lineage.replays['staged-9'] = {
        experimentId: 'staged-9', skill: 'writer', operator: 'rewrite', outcome: 'improved',
        metrics: { pass: true, tokens: 3, wallTimeMs: 5 },
        dependencies: { evaluator: 'scorer-v1' }, seeds: [7, 42],
      }
      const session = sessionIn(test.ctx, test.dir, 'lineage-replay')
      expect((await run(test, session, '/lineage replay staged-9')).result).toEqual({
        kind: 'success',
        text: [
          'Experiment staged-9 (writer, improved by rewrite):',
          '- pass true, 3 tokens, 5ms',
          '- dependencies: evaluator=scorer-v1',
          '- seeds: 7, 42',
        ].join('\n'),
      })
      expect((await run(test, session, '/lineage replay ghost')).result).toEqual({
        kind: 'error',
        text: "Unknown experiment 'ghost'.",
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/sleeptime human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'sleeptime-unmounted')
      expect((await run(test, session, '/sleeptime')).result).toEqual({
        kind: 'error',
        text: 'The evolution sleeptime store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { sleeptime: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'sleeptime-grammar')
      const usage = 'Usage: /sleeptime [tasks [<domain>] | artifacts [<taskId>] | plan]'
      expect((await run(mounted, session, '/sleeptime bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/sleeptime tasks a b')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/sleeptime artifacts a b')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/sleeptime plan extra')).result).toEqual({ kind: 'error', text: usage })
    } finally {
      await shutdown(mounted)
    }
  })

  it('lists tasks, artifacts, and the offline-cost plan', async () => {
    const test = await harness(true, undefined, { sleeptime: true })
    try {
      test.sleeptime.tasks = [
        { taskId: 'summarize-log', domain: 'coding', likelihood: 0.8, expectedQueries: 3, expectedSavingTokens: 1000 },
        { taskId: 'index-retrieval', domain: 'coding', likelihood: 0.4, expectedQueries: 2, expectedSavingTokens: 500 },
      ]
      test.sleeptime.artifacts = [
        { artifactId: 'art-2', taskId: 'summarize-log', kind: 'summary', summary: 'log notes', offlineCostTokens: 2000, hits: 2, savedTokens: 1500 },
      ]
      test.sleeptime.plan = [
        { taskId: 'summarize-log', domain: 'coding', worthIt: true, expectedNet: 400, reason: 'net 400 tokens (likelihood 0.8 × 3 queries × 1000 saved − cost 2000)' },
      ]
      const session = sessionIn(test.ctx, test.dir, 'sleeptime-list')
      expect((await run(test, session, '/sleeptime tasks coding')).result).toEqual({
        kind: 'success',
        text: [
          "Anticipated tasks 'coding' (likelihood first): 2",
          '- summarize-log (coding): 80%, 3 expected queries, 1000 tokens each',
          '- index-retrieval (coding): 40%, 2 expected queries, 500 tokens each',
        ].join('\n'),
      })
      expect((await run(test, session, '/sleeptime artifacts summarize-log')).result).toEqual({
        kind: 'success',
        text: [
          "Precomputed artifacts 'summarize-log': 1",
          '- art-2 [summary] for summarize-log: 2 hits, 1500 tokens saved, cost 2000',
        ].join('\n'),
      })
      expect((await run(test, session, '/sleeptime plan')).result).toEqual({
        kind: 'success',
        text: [
          'Sleep-time plan:',
          '- summarize-log (coding): net 400 tokens — net 400 tokens (likelihood 0.8 × 3 queries × 1000 saved − cost 2000)',
        ].join('\n'),
      })
      expect((await run(test, session, '/sleeptime tasks absent')).result).toEqual({
        kind: 'success',
        text: 'No anticipated tasks. Anticipate likely future tasks to seed sleep-time compute.',
      })
      expect((await run(test, session, '/sleeptime artifacts absent')).result).toEqual({
        kind: 'success',
        text: 'No precomputed artifacts recorded.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/learn human command', () => {
  it('reports usage for a bare invocation', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'learn-usage')
      expect((await run(test, session, '/learn')).result).toEqual({ kind: 'error', text: 'Usage: /learn <anything>' })
      expect((await run(test, session, '/learn   ')).result).toEqual({ kind: 'error', text: 'Usage: /learn <anything>' })
      expect(test.followups).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('queues one ordinary turn carrying the built prompt', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'learn-prompt')
      const execution = await run(test, session, '/learn  Rust async traits  ')
      expect(execution.result).toEqual({
        kind: 'success',
        text: "Started a learning turn for 'Rust async traits'. The skill lands only through the gated skill_manage write.",
      })
      expect(test.followups).toEqual([{
        role: 'user',
        source: { kind: 'plugin', plugin: 'command-evolution' },
        content: [{ type: 'text', text: buildLearnPrompt('Rust async traits') }],
        id: expect.any(String) as unknown,
      }])
      const queued = test.followups[0] as { content: { text: string }[] }
      // The prompt names the topic, the gathering tools, and the gated save.
      expect(queued.content[0]?.text).toContain('Rust async traits')
      expect(queued.content[0]?.text).toContain('skill_manage')
      expect(queued.content[0]?.text).toContain('proposal-gated')
      // The command itself wrote no skill and logged no second turn.
      expectLifecycle(test, session, 'learn', '  Rust async traits  ', execution.result)
    } finally {
      await shutdown(test)
    }
  })
})

describe('/suggestions human command', () => {
  it('reports usage for any argument and a missing registry', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'suggestions-usage')
      expect((await run(test, session, '/suggestions now')).result).toEqual({
        kind: 'error',
        text: 'Usage: /suggestions (no arguments)',
      })
      expect((await run(test, session, '/suggestions')).result).toEqual({
        kind: 'error',
        text: 'The skill registry is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists only blueprint-backed skills and never schedules one', async () => {
    const test = await harness(true, undefined, { skills: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'suggestions')
      test.skills.summaries = [
        { name: 'plain', description: 'no blueprint' },
        { name: 'polish', description: 'Refresh the docs nightly' },
        { name: 'bad-schedule', description: 'non-string schedule' },
        { name: 'bad-prompt', description: 'non-string prompt' },
        { name: 'bad-deliver', description: 'unknown delivery mode' },
        { name: 'legacy', description: 'blueprint in the metadata bag' },
        { name: 'vanished', description: 'listed but not loadable' },
      ]
      test.skills.definitions = {
        plain: { name: 'plain', description: 'no blueprint' },
        polish: {
          name: 'polish',
          description: 'Refresh the docs nightly',
          blueprint: { schedule: '0 3 * * *', deliver: 'session', prompt: 'Refresh the docs' },
        },
        'bad-schedule': { name: 'bad-schedule', blueprint: { schedule: 7, deliver: 'session', prompt: 'x' } },
        'bad-prompt': { name: 'bad-prompt', blueprint: { schedule: '0 3 * * *', deliver: 'session', prompt: 42 } },
        'bad-deliver': { name: 'bad-deliver', blueprint: { schedule: '0 3 * * *', deliver: 'pipe', prompt: 'x' } },
        legacy: { name: 'legacy', metadata: { blueprint: { schedule: '0 4 * * *', deliver: 'file', prompt: 'Write the digest' } } },
      }
      const execution = await run(test, session, '/suggestions')
      expect(execution.result).toEqual({
        kind: 'success',
        text: [
          '2 suggested skills:',
          '- polish: Refresh the docs nightly (schedule 0 3 * * *, deliver session)',
          '- legacy: blueprint in the metadata bag (schedule 0 4 * * *, deliver file)',
          'Suggested only: this command installs no schedule; register the one a skill names when you trust it.',
        ].join('\n'),
      })
      expectLifecycle(test, session, 'suggestions', '', execution.result)
      expect(test.skills.lists).toEqual([{ cwd: test.dir, signal: expect.any(AbortSignal) as unknown }])
      expect(test.skills.gets).toEqual(['plain', 'polish', 'bad-schedule', 'bad-prompt', 'bad-deliver', 'legacy', 'vanished'])
    } finally {
      await shutdown(test)
    }
  })

  it('reports the honest empty state for a catalog without blueprints', async () => {
    const test = await harness(true, undefined, { skills: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'suggestions-empty')
      test.skills.summaries = [{ name: 'plain', description: 'no blueprint' }]
      test.skills.definitions = { plain: { name: 'plain', blueprint: 'nope' } }
      expect((await run(test, session, '/suggestions')).result).toEqual({
        kind: 'success',
        text: 'No blueprint-backed skills. A skill appears here when its frontmatter declares a blueprint; this command never installs the schedule it names.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists a single suggestion in the singular', async () => {
    const test = await harness(true, undefined, { skills: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'suggestions-one')
      test.skills.summaries = [{ name: 'polish', description: 'Refresh the docs nightly' }]
      test.skills.definitions = {
        polish: { name: 'polish', blueprint: { schedule: '0 3 * * *', deliver: 'session', prompt: 'Refresh' } },
      }
      const execution = await run(test, session, '/suggestions')
      expect(execution.result.kind).toBe('success')
      const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
      expect(text.split('\n')[0]).toBe('1 suggested skill:')
    } finally {
      await shutdown(test)
    }
  })

  it('reads a session without a cwd as a global catalog lookup', async () => {
    const test = await harness(true, undefined, { skills: true })
    try {
      const session = test.ctx.sessions.create(SessionId('suggestions-no-cwd'))
      test.skills.summaries = [{ name: 'polish', description: 'Refresh the docs nightly' }]
      test.skills.definitions = {
        polish: { name: 'polish', blueprint: { schedule: '0 3 * * *', deliver: 'session', prompt: 'Refresh' } },
      }
      await run(test, session, '/suggestions')
      expect(test.skills.lists).toEqual([{ signal: expect.any(AbortSignal) as unknown }])
    } finally {
      await shutdown(test)
    }
  })
})

describe('stagedFailureText', () => {
  it('names missing entries and codes other Remote failures with their verb', () => {
    expect(stagedFailureText('approve', 'gone', new RemoteError('evolution/staged-not-found', 'gone', { stagedId: 'gone' }))).toBe(
      "No staged write 'gone'.",
    )
    expect(stagedFailureText('reject', 'kept', new RemoteError('evolution/capacity-exceeded', 'full', { usedBytes: 9, capacityBytes: 8 }))).toBe(
      "Cannot reject 'kept' (evolution/capacity-exceeded): full. The entry stays staged.",
    )
  })
})

describe('/refine human command', () => {
  it('reports usage for invocations with arguments and refuses scopeless sessions', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'refine-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/refine now')).result).toEqual({
        kind: 'error',
        text: 'Usage: /refine (no arguments)',
      })
      const homeless = test.ctx.sessions.create(SessionId('refine-homeless'))
      expect((await run(test, homeless, '/refine')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
      expect(test.reviewer.calls).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('forwards the scope and signal to the reviewer rebuild', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'refine')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const controller = new AbortController()
      const execution = await run(test, session, '/refine', controller)
      expect(execution.result).toEqual({ kind: 'success', text: 'Memory rebuild complete.' })
      expect(test.reviewer.calls).toEqual([{ scope: test.scope('ws-1'), signal: controller.signal }])
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing reviewer without calling anything', async () => {
    const test = await harness(false)
    try {
      const session = sessionIn(test.ctx, test.dir, 'no-reviewer')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/refine')).result).toEqual({
        kind: 'error',
        text: 'The evolution reviewer is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('maps rebuild Remote failures to direct errors', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'refine-fails')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      test.reviewer.failure = new RemoteError('evolution/extraction-failed', 'no route', { scopeId: 'test:ws-1' })
      expect((await run(test, session, '/refine')).result).toEqual({
        kind: 'error',
        text: 'Memory rebuild failed (evolution/extraction-failed): no route.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('preserves cancellation and unexpected rebuild failures', async () => {
    const cancelled = await harness()
    try {
      const session = sessionIn(cancelled.ctx, cancelled.dir, 'refine-cancelled')
      cancelled.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: cancelled.dir, sessionIds: [session.id] })
      const controller = new AbortController()
      const abort = new Error('operator cancelled')
      cancelled.reviewer.operation = () => {
        controller.abort(abort)
        return Promise.reject(abort)
      }
      await expect(run(cancelled, session, '/refine', controller)).rejects.toBe(abort)
      expectLifecycle(cancelled, session, 'refine', '', { kind: 'error', text: abort.message })
    } finally {
      await shutdown(cancelled)
    }

    const unexpected = await harness()
    try {
      const session = sessionIn(unexpected.ctx, unexpected.dir, 'refine-unexpected')
      unexpected.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: unexpected.dir, sessionIds: [session.id] })
      const bug = new Error('unexpected reviewer bug')
      unexpected.reviewer.failure = bug
      await expect(run(unexpected, session, '/refine')).rejects.toBe(bug)
    } finally {
      await shutdown(unexpected)
    }
  })
})

describe('/frontier human command', () => {
  /** One ledger row carrying the fields `/frontier` reads. */
  function row(skill: string, overrides: Record<string, unknown> = {}): unknown {
    return {
      id: `${skill}-run`,
      at: '2026-09-12T00:00:00.000Z',
      scope: 'test:ws-1',
      skill,
      evidence: 'failures',
      operators: [],
      portfolio: [],
      novelOperators: [],
      scenarios: ['s1'],
      holdout: [],
      baseline: null,
      winner: null,
      confidence: null,
      samples: 1,
      outcome: 'staged',
      reason: null,
      stagedId: null,
      provider: 'p',
      model: 'm',
      bodySha: 'a',
      winnerSha: null,
      winnerOperator: null,
      ...overrides,
    }
  }

  /** Mount the optimizer and telemetry doubles behind one frontier scope. */
  function seams(
    test: Harness,
    options: {
      rows?: unknown[]
      entries?: { name: string; usage: SkillUsageRecord }[]
      failures?: Record<string, string>
      feedback?: boolean
    },
  ): void {
    const rows = options.rows ?? []
    test.ctx.provide('evolutionOptimizer', {
      experiments: (_scope: unknown, query: { skill?: string } = {}) =>
        rows.filter(entry => query.skill === undefined || (entry as { skill: string }).skill === query.skill),
    } as never)
    const entries = options.entries ?? []
    test.ctx.provide('evolutionSkillTelemetry', { entries: () => entries } as never)
    if (options.feedback === false) return
    const failures = options.failures ?? {}
    test.ctx.provide('evolutionFeedback', {
      signals: (sessionIds: readonly string[]) => {
        const hit = sessionIds.find(id => failures[id] !== undefined)
        return hit === undefined ? [] : [{ message: failures[hit] }]
      },
    } as never)
  }

  function scoped(test: Harness, session: Session): void {
    test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
  }

  it('reports usage, missing seams, and an out-of-scope session', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'frontier-guard')
      scoped(test, session)
      expect((await run(test, session, '/frontier now')).result).toEqual({
        kind: 'error',
        text: 'Usage: /frontier (no arguments)',
      })
      expect((await run(test, session, '/frontier')).result).toEqual({
        kind: 'error',
        text: 'The evolution optimizer is not mounted.',
      })
      test.ctx.provide('evolutionOptimizer', { experiments: () => [] } as never)
      expect((await run(test, session, '/frontier')).result).toEqual({
        kind: 'error',
        text: 'Skill telemetry is not mounted. The frontier needs the telemetry store.',
      })
      test.ctx.provide('evolutionSkillTelemetry', { entries: () => [] } as never)
      test.workspaces.delete('ws-1')
      expect((await run(test, session, '/frontier')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports the honest empty state with no skills anywhere', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'frontier-empty')
      scoped(test, session)
      seams(test, {})
      expect((await run(test, session, '/frontier')).result).toEqual({
        kind: 'success',
        text: 'No measured capabilities yet.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('ranks weakest first across telemetry, ledger, feedback, and catalog', async () => {
    const test = await harness(true, undefined, { skills: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'frontier-full')
      scoped(test, session)
      seams(test, {
        rows: [
          row('writer', {
            winner: { pass: false, tokens: 800, wallTimeMs: 9 },
            confidence: { wins: 2, runs: 5 },
          }),
          row('steady', {
            winner: { pass: true, tokens: 100, wallTimeMs: 2 },
            confidence: { wins: 4, runs: 5 },
          }),
          row('ghost', {}),
        ],
        entries: [
          {
            name: 'writer',
            usage: usageRecord({ useCount: 12, failureCount: 3, trustFailures: 1, sessionIds: ['s1', 's2'] }),
          },
          { name: 'steady', usage: usageRecord({ useCount: 5, sessionIds: ['s3'] }) },
          { name: 'retired', usage: usageRecord({ state: 'archived', failureCount: 9 }) },
        ],
        failures: { s1: 'command not found' },
      })
      test.skills.definitions = {
        writer: { name: 'writer', description: 'Writes files' },
        steady: { name: 'steady', description: 'Holds steady' },
      }
      expect((await run(test, session, '/frontier')).result).toEqual({
        kind: 'success',
        text: [
          'Frontier (weakest first): 3',
          "- writer: fail at 800 tokens 2/5 · 4 failures (top: 'command not found') · 12 loads in 2 sessions: Writes files",
          '- ghost: unmeasured · 0 loads in 0 sessions',
          '- steady: pass at 100 tokens 4/5 · 5 loads in 1 session: Holds steady',
          'Weakest first: failing without a passing winner, then unmeasured, then passing.',
        ].join('\n'),
      })
      expect(test.skills.gets).toEqual(['writer', 'steady', 'ghost'])
    } finally {
      await shutdown(test)
    }
  })

  it('degrades without feedback or catalog to counts alone', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'frontier-bare')
      scoped(test, session)
      seams(test, {
        rows: [row('writer', { winner: { pass: true, tokens: 50, wallTimeMs: 1 } })],
        entries: [{ name: 'writer', usage: usageRecord({ useCount: 1, sessionIds: ['s1'] }) }],
        feedback: false,
      })
      expect((await run(test, session, '/frontier')).result).toEqual({
        kind: 'success',
        text: [
          'Frontier (weakest first): 1',
          '- writer: pass at 50 tokens · 1 load in 1 session',
          'Weakest first: failing without a passing winner, then unmeasured, then passing.',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('command-evolution disposal', () => {
  it('drains in-flight handlers before plugin disposal settles', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'drain')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const started = Promise.withResolvers<undefined>()
      const allow = Promise.withResolvers<undefined>()
      test.reviewer.operation = async () => {
        started.resolve(undefined)
        await allow.promise
      }
      const execution = run(test, session, '/refine')
      await started.promise
      let disposed = false
      const disposal = test.plugin.dispose()
      void disposal.then(() => { disposed = true })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(test.ctx.commands.find(fakeAgent(session), 'refine')).toBeUndefined()
      expect(disposed).toBe(false)
      allow.resolve(undefined)
      await execution
      await disposal
      expect(disposed).toBe(true)
    } finally {
      await rm(test.dir, { recursive: true, force: true })
    }
  })
})

describe('/budget human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'budget-unmounted')
      expect((await run(test, session, '/budget')).result).toEqual({
        kind: 'error',
        text: 'The evolution budget store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { budget: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'budget-grammar')
      const usage = 'Usage: /budget [spends [<batchId>]]'
      expect((await run(mounted, session, '/budget bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/budget spends a b')).result).toEqual({ kind: 'error', text: usage })
    } finally {
      await shutdown(mounted)
    }
  })

  it('settles each batch against its allocation and lists spends', async () => {
    const test = await harness(true, undefined, { budget: true })
    try {
      test.budget.batches = [
        {
          batchId: 'b1',
          taskClass: 'writer',
          candidateClass: 'high-potential',
          maxTokens: 200,
          maxWallTimeMs: 100,
          reason: 'high-potential ×2',
          at: '2026-09-12T00:00:00.000Z',
        },
        {
          batchId: 'b2',
          taskClass: 'writer',
          candidateClass: 'low-potential',
          maxTokens: 50,
          maxWallTimeMs: 100,
          reason: 'low-potential ×0.5',
          at: '2026-09-12T00:00:00.000Z',
        },
      ]
      test.budget.spends = [
        { batchId: 'b1', tokens: 100, wallTimeMs: 50, rollouts: 2, at: '2026-09-12T00:00:00.000Z' },
        { batchId: 'b2', tokens: 80, wallTimeMs: 10, rollouts: 1, at: '2026-09-12T00:00:00.000Z' },
      ]
      const session = sessionIn(test.ctx, test.dir, 'budget-settle')
      expect((await run(test, session, '/budget')).result).toEqual({
        kind: 'success',
        text: [
          'Budget (2 batches):',
          '- b1 (high-potential, writer): 100/200 tokens, 50/100ms — 100 tokens, 50ms left',
          '- b2 (low-potential, writer): 80/50 tokens, 10/100ms — EXCEEDED by 30 tokens, 0ms',
        ].join('\n'),
      })
      expect((await run(test, session, '/budget spends b1')).result).toEqual({
        kind: 'success',
        text: [
          '1 spend:',
          '- b1: 100 tokens, 50ms, 2 rollouts at 2026-09-12T00:00:00.000Z',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('renders the cost, deadline, and concurrency margins an allocation priced', async () => {
    const test = await harness(true, undefined, { budget: true })
    try {
      test.budget.batches = [
        {
          batchId: 'b1',
          taskClass: 'writer',
          candidateClass: 'high-potential',
          maxTokens: 200,
          maxWallTimeMs: 100,
          maxCost: 8,
          timeLimitMs: 60,
          parallelism: 4,
          reason: 'high-potential ×2',
          at: '2026-09-12T00:00:00.000Z',
        },
        {
          batchId: 'b2',
          taskClass: 'writer',
          candidateClass: 'standard',
          maxTokens: 200,
          maxWallTimeMs: 100,
          maxCost: 8,
          reason: 'standard',
          at: '2026-09-12T00:00:00.000Z',
        },
      ]
      test.budget.spends = [
        { batchId: 'b1', tokens: 100, wallTimeMs: 50, rollouts: 2, cost: 3, parallelism: 2, at: '2026-09-12T00:00:00.000Z' },
        { batchId: 'b2', tokens: 10, wallTimeMs: 5, rollouts: 1, at: '2026-09-12T00:00:00.000Z' },
      ]
      const session = sessionIn(test.ctx, test.dir, 'budget-margins')
      expect((await run(test, session, '/budget')).result).toEqual({
        kind: 'success',
        text: [
          'Budget (2 batches):',
          '- b1 (high-potential, writer): 100/200 tokens, 50/100ms — 100 tokens, 50ms left'
          + ' · cost 3/8 — 5 left, time 0/60ms — 60ms left, parallelism 2/4 — 2 left',
          // A priced dimension nothing recorded is named, not shown as a zero
          // the settlement cannot prove; an unpriced one is not rendered.
          '- b2 (standard, writer): 10/200 tokens, 5/100ms — 190 tokens, 95ms left'
          + ' · cost unmeasured (ceiling 8)',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports the empty state before the optimizer has recorded a batch', async () => {
    const test = await harness(true, undefined, { budget: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'budget-empty')
      expect((await run(test, session, '/budget')).result).toEqual({
        kind: 'success',
        text: 'No recorded budget allocations. The optimizer records one allocation per candidate batch.',
      })
      expect((await run(test, session, '/budget spends')).result).toEqual({
        kind: 'success',
        text: 'No recorded budget spends.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/meta human command', () => {
  const config = { operators: 'portfolio-v1', evaluator: 'scorer-v1', budget: 'balanced-v1', routing: 'evidence-v1' }

  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'meta-unmounted')
      expect((await run(test, session, '/meta')).result).toEqual({
        kind: 'error',
        text: 'The evolution meta store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { meta: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'meta-grammar')
      const usage = 'Usage: /meta [summaries [<taskClass>] | runs [<taskClass>] | recommend <taskClass>]'
      expect((await run(mounted, session, '/meta bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/meta recommend')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/meta runs a b')).result).toEqual({ kind: 'error', text: usage })
    } finally {
      await shutdown(mounted)
    }
  })

  it('summarizes configurations, lists runs, and names the recommendation', async () => {
    const test = await harness(true, undefined, { meta: true })
    try {
      test.meta.runs = [
        {
          runId: 'run-1',
          taskClass: 'writer',
          config,
          workflow: [],
          pass: true,
          tokens: 5000,
          wallTimeMs: 60000,
          at: '2026-09-12T00:00:00.000Z',
        },
      ]
      test.meta.summaries = [
        {
          configId: 'portfolio-v1|scorer-v1|balanced-v1|evidence-v1',
          config,
          taskClass: 'writer',
          workflow: [],
          workflowId: '',
          samples: 3,
          passes: 2,
          passRate: 2 / 3,
          meanTokens: 5000,
          score: 0.5,
          lastAt: '2026-09-12T00:00:00.000Z',
        },
      ]
      test.meta.recommendations['writer'] = {
        config,
        configId: 'portfolio-v1|scorer-v1|balanced-v1|evidence-v1',
        taskClass: 'writer',
        workflow: [],
        workflowId: '',
        score: 0.5,
        samples: 3,
        passRate: 2 / 3,
        reason: '2 of 3 runs passed; samples 3 ≥ minimum 3',
      }
      const session = sessionIn(test.ctx, test.dir, 'meta-read')
      expect((await run(test, session, '/meta summaries writer')).result).toEqual({
        kind: 'success',
        text: [
          "Engine configurations for 'writer' (best score first): 1",
          '- portfolio-v1|scorer-v1|balanced-v1|evidence-v1 (writer): 67% pass over 3 runs, 5000 mean tokens, score 0.500',
        ].join('\n'),
      })
      expect((await run(test, session, '/meta runs')).result).toEqual({
        kind: 'success',
        text: [
          '1 engine run:',
          '- run-1 (writer) pass, 5000 tokens, 60000ms at 2026-09-12T00:00:00.000Z',
        ].join('\n'),
      })
      expect((await run(test, session, '/meta recommend writer')).result).toEqual({
        kind: 'success',
        text: [
          "Recommended engine configuration for 'writer': portfolio-v1|scorer-v1|balanced-v1|evidence-v1",
          'operators portfolio-v1, evaluator scorer-v1, budget balanced-v1, routing evidence-v1',
          'workflow: unrecorded',
          '2 of 3 runs passed; samples 3 ≥ minimum 3',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('names the recommended workflow when the store recorded one', async () => {
    const test = await harness(true, undefined, { meta: true })
    try {
      test.meta.recommendations['writer'] = {
        config,
        configId: 'portfolio-v1|scorer-v1|balanced-v1|evidence-v1',
        taskClass: 'writer',
        workflow: [
          { component: 'operators', choice: 'portfolio-v1' },
          { component: 'evaluator', choice: 'scorer-v1' },
        ],
        workflowId: 'workflow operators=portfolio-v1>evaluator=scorer-v1',
        score: 0.5,
        samples: 3,
        passRate: 2 / 3,
        reason: '2 of 3 runs passed',
      }
      const session = sessionIn(test.ctx, test.dir, 'meta-workflow')
      expect((await run(test, session, '/meta recommend writer')).result).toEqual({
        kind: 'success',
        text: [
          "Recommended engine configuration for 'writer': portfolio-v1|scorer-v1|balanced-v1|evidence-v1",
          'operators portfolio-v1, evaluator scorer-v1, budget balanced-v1, routing evidence-v1',
          'workflow: operators=portfolio-v1>evaluator=scorer-v1',
          '2 of 3 runs passed',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports the empty state and an under-sampled recommendation', async () => {
    const test = await harness(true, undefined, { meta: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'meta-empty')
      expect((await run(test, session, '/meta summaries')).result).toEqual({
        kind: 'success',
        text: 'No engine-configuration summaries. The optimizer records one run per staged write.',
      })
      expect((await run(test, session, '/meta runs')).result).toEqual({
        kind: 'success',
        text: 'No recorded engine runs.',
      })
      expect((await run(test, session, '/meta recommend writer')).result).toEqual({
        kind: 'success',
        text: "No configuration has enough recorded runs on 'writer' to recommend yet.",
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/operators human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'operators-unmounted')
      expect((await run(test, session, '/operators')).result).toEqual({
        kind: 'error',
        text: 'The evolution operators store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { operators: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'operators-grammar')
      expect((await run(mounted, session, '/operators writer extra')).result).toEqual({
        kind: 'error',
        text: 'Usage: /operators <artifactClass>',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('ranks one artifact class and joins the regression rate from its statistics', async () => {
    const test = await harness(true, undefined, { operators: true })
    try {
      test.operators.stats = [
        {
          operator: 'rewrite',
          artifactClass: 'writer',
          attempts: 3,
          accepted: 2,
          meanDelta: 2 / 3,
          regressionRate: 1 / 3,
          lastAt: '2026-09-12T00:00:00.000Z',
        },
      ]
      test.operators.rankings['writer'] = [
        { operator: 'rewrite', attempts: 3, acceptanceRate: 2 / 3, meanDelta: 2 / 3, instructionAdjustment: 0, score: 0.75, reason: 'observed' },
      ]
      const session = sessionIn(test.ctx, test.dir, 'operators-rank')
      expect((await run(test, session, '/operators writer')).result).toEqual({
        kind: 'success',
        text: [
          "Operator ranking for 'writer' (best first):",
          '- rewrite: 3 attempts, 67% accepted, mean delta 0.67, 33% regressions, score 0.750',
        ].join('\n'),
      })
      expect((await run(test, session, '/operators')).result).toEqual({
        kind: 'success',
        text: [
          'Operator statistics span 1 artifact class: writer.',
          'Name one class to rank its operators.',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports the empty states', async () => {
    const test = await harness(true, undefined, { operators: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'operators-empty')
      expect((await run(test, session, '/operators')).result).toEqual({
        kind: 'success',
        text: "No recorded operator statistics. The optimizer records every staged write's operator and outcome.",
      })
      expect((await run(test, session, '/operators writer')).result).toEqual({
        kind: 'success',
        text: "No operator statistics recorded for 'writer'.",
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/router human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'router-unmounted')
      expect((await run(test, session, '/router')).result).toEqual({
        kind: 'error',
        text: 'The evolution router store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { router: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'router-grammar')
      const usage = 'Usage: /router [effectiveness [<taskClass>] [<role>] | recommend <taskClass> <role>]'
      expect((await run(mounted, session, '/router bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/router recommend writer')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/router recommend writer bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/router effectiveness writer bogus')).result).toEqual({ kind: 'error', text: usage })
    } finally {
      await shutdown(mounted)
    }
  })

  it('lists measured effectiveness and names the recommended route', async () => {
    const test = await harness(true, undefined, { router: true })
    try {
      test.router.effectiveness = [
        {
          taskClass: 'writer',
          role: 'evaluation',
          provider: 'deepseek',
          model: 'chat',
          samples: 5,
          passes: 4,
          passRate: 0.8,
          meanTokens: 1000,
          meanWallTimeMs: 2000,
          lastAt: '2026-09-12T00:00:00.000Z',
        },
      ]
      test.router.recommendations['writer/evaluation'] = {
        provider: 'deepseek',
        model: 'chat',
        samples: 5,
        passRate: 0.8,
        meanTokens: 1000,
        meanWallTimeMs: 2000,
        score: 0.75,
        reason: '4 of 5 outcomes passed; samples 5 ≥ minimum 3',
      }
      const session = sessionIn(test.ctx, test.dir, 'router-read')
      expect((await run(test, session, '/router effectiveness')).result).toEqual({
        kind: 'success',
        text: [
          '1 route row:',
          '- deepseek/chat (evaluation, writer): 80% pass over 5, 1000 mean tokens, 2000ms mean',
        ].join('\n'),
      })
      expect((await run(test, session, '/router recommend writer evaluation')).result).toEqual({
        kind: 'success',
        text: [
          "Recommended route for evaluation on 'writer': deepseek/chat",
          '4 of 5 outcomes passed; samples 5 ≥ minimum 3',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports the empty state and an under-sampled recommendation', async () => {
    const test = await harness(true, undefined, { router: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'router-empty')
      expect((await run(test, session, '/router')).result).toEqual({
        kind: 'success',
        text: 'No recorded route outcomes. The optimizer records the evaluation route of every staged write.',
      })
      expect((await run(test, session, '/router recommend writer evaluation')).result).toEqual({
        kind: 'success',
        text: "No route has enough recorded outcomes on 'writer' for evaluation to recommend yet.",
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/evaluator-strategy human command', () => {
  it('reports usage for malformed invocations and a missing store', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'evaluator-strategy-unmounted')
      expect((await run(test, session, '/evaluator-strategy')).result).toEqual({
        kind: 'error',
        text: 'The evolution evaluator-strategy store is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { evaluatorStrategy: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'evaluator-strategy-grammar')
      const usage = 'Usage: /evaluator-strategy [strategies [<taskClass>] | rank <taskClass>]'
      expect((await run(mounted, session, '/evaluator-strategy bogus')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/evaluator-strategy rank')).result).toEqual({ kind: 'error', text: usage })
      expect((await run(mounted, session, '/evaluator-strategy strategies a b')).result).toEqual({ kind: 'error', text: usage })
    } finally {
      await shutdown(mounted)
    }
  })

  it('lists recorded trust and ranks one task class', async () => {
    const test = await harness(true, undefined, { evaluatorStrategy: true })
    try {
      test.evaluatorStrategy.strategies = [
        {
          evaluator: 'scorer-v1',
          taskClass: 'writer',
          samples: 4,
          independentSamples: 3,
          corroborations: 2,
          weight: 0.7,
          lastAt: '2026-09-12T00:00:00.000Z',
        },
      ]
      test.evaluatorStrategy.rankings['writer'] = [
        { evaluator: 'scorer-v1', samples: 4, independentSamples: 3, corroborations: 2, weight: 0.7, reason: 'observed' },
      ]
      const session = sessionIn(test.ctx, test.dir, 'evaluator-strategy-read')
      expect((await run(test, session, '/evaluator-strategy strategies writer')).result).toEqual({
        kind: 'success',
        text: [
          '1 evaluator strategy row:',
          '- scorer-v1 (writer): 2/3 independent corroborations over 4 verdicts, weight 0.700 at 2026-09-12T00:00:00.000Z',
        ].join('\n'),
      })
      expect((await run(test, session, '/evaluator-strategy rank writer')).result).toEqual({
        kind: 'success',
        text: [
          "Evaluator ranking for 'writer' (most trusted first):",
          '- scorer-v1: 2/3 independent corroborations over 4 verdicts, weight 0.700',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports the empty states', async () => {
    const test = await harness(true, undefined, { evaluatorStrategy: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'evaluator-strategy-empty')
      expect((await run(test, session, '/evaluator-strategy')).result).toEqual({
        kind: 'success',
        text: 'No evaluator strategy recorded. The optimizer pairs each verdict with its holdout ground truth.',
      })
      expect((await run(test, session, '/evaluator-strategy rank writer')).result).toEqual({
        kind: 'success',
        text: "No evaluator strategy recorded for 'writer'.",
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/metrics human command', () => {
  /** One recorded engine run, newest first as the store returns them. */
  const engineRun = (runId: string, hour: number, pass: boolean): EngineRun => ({
    runId,
    taskClass: 'writer',
    config: { operators: 'portfolio-v1', evaluator: 'scorer-v1', budget: 'balanced-v1', routing: 'evidence-v1' },
    workflow: [],
    pass,
    tokens: 100,
    wallTimeMs: 1000,
    at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + hour * 3_600_000).toISOString(),
  })

  it('reports usage for extra arguments and a missing layer', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'metrics-unmounted')
      expect((await run(test, session, '/metrics')).result).toEqual({
        kind: 'error',
        text: 'The evolution metric layer is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
    const mounted = await harness(true, undefined, { metrics: true })
    try {
      const session = sessionIn(mounted.ctx, mounted.dir, 'metrics-grammar')
      expect((await run(mounted, session, '/metrics writer extra')).result).toEqual({
        kind: 'error',
        text: 'Usage: /metrics [<taskClass>]',
      })
    } finally {
      await shutdown(mounted)
    }
  })

  it('measures the north star over the engine runs and names what it cannot measure', async () => {
    const test = await harness(true, undefined, { metrics: true, meta: true })
    try {
      // Newest first, as `runs()` returns them: the older half passes once, the
      // newer half always, so the gain is half a pass rate.
      test.meta.runs = [engineRun('r4', 3, true), engineRun('r3', 2, true), engineRun('r2', 1, true), engineRun('r1', 0, false)]
      const session = sessionIn(test.ctx, test.dir, 'metrics-read')
      const result = (await run(test, session, '/metrics')).result
      expect(result.kind).toBe('success')
      const text = result.kind === 'success' ? result.text ?? '' : ''
      expect(text.split('\n')[0]).toBe(
        'Metric window: 4 runs from 2026-01-01T00:00:00.000Z to 2026-01-01T03:00:00.000Z',
      )
      expect(text).toContain('Capability: 50.0% → 100.0% over 2 older and 2 newer runs')
      // gain 0.5 over 400 tokens, 4000ms of compute, and 0.125 of a day.
      expect(text).toContain('- capability-gain-per-million-tokens: 1250')
      expect(text).toContain('- capability-gain-per-compute-hour: 450')
      expect(text).toContain('- learning-velocity: 4')
      // A store left unmounted is a reason, not an absent entry.
      expect(text).toContain('- rollback-rate: not measured — the evolution canary store is not mounted')
      // A metric no store can answer names the missing record instead.
      expect(text).toContain('- benchmark-robustness: not measured — no record scores a benchmark task')
    } finally {
      await shutdown(test)
    }
  })

  it('narrows the window to one task class and reads a supporting metric from its own store', async () => {
    const test = await harness(true, undefined, { metrics: true, meta: true, evaluatorHealth: true })
    try {
      test.meta.runs = [engineRun('r2', 1, true), engineRun('r1', 0, false)]
      test.evaluatorHealth.summary = {
        runs: 10,
        unanimousRate: 0.8,
        approvalRate: 0.9,
        recentApprovalRate: 0.9,
        drift: 0,
        falsePositiveRate: 0.25,
        channels: [],
      }
      const session = sessionIn(test.ctx, test.dir, 'metrics-class')
      const scoped = (await run(test, session, '/metrics writer')).result
      expect(scoped.kind === 'success' ? scoped.text : '').toContain("Metric window for 'writer': 2 runs")
      expect(scoped.kind === 'success' ? scoped.text : '').toContain('- evaluator-reliability: 75.0%')

      const empty = (await run(test, session, '/metrics alpha')).result
      const emptyText = empty.kind === 'success' ? empty.text : ''
      expect(emptyText).toContain("Metric window for 'alpha': 0 runs")
      expect(emptyText).toContain('Capability: not measured — the window holds 0 older and 0 newer runs')
      expect(emptyText).toContain('- capability-gain-per-million-tokens: not measured'
        + ' — the window holds 0 older and 0 newer runs; 2 runs are needed on each side of the split')
      // The supporting metrics are host-wide, so they still answer for a class with no runs.
      expect(emptyText).toContain('- evaluator-reliability: 75.0%')
    } finally {
      await shutdown(test)
    }
  })
})
