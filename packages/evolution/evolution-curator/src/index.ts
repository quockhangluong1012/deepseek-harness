/**
 * Idle-triggered skill lifecycle curation (`ctx.evolutionCurator`): automatic
 * `active → stale → archived` transitions over skill telemetry, with dry-run
 * previews and first-run deferral, over the `evolution_curator` domain, plus
 * opt-in LLM consolidation of agent-created skills.
 *
 * The plugin is mounted once per host and owns the maintenance schedule
 * itself: it observes host-wide session activity, runs one start-time
 * due-check, and then ticks every `tickMinutes`, running a pass only when the
 * interval elapsed and enough idleness was observed. A pass examines every
 * tracked skill and moves idle ones along, skipping pinned skills, protected
 * names, and bundled or hub sources. The idle-gated entry seeds the
 * bookkeeping on its first call and defers one interval. Stored objects never
 * leak by reference.
 * @module @deepseek-ai/dsh-evolution-curator
 */

import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm'
import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { SkillLifecycleState, SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { EvolutionSkillTelemetry } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { curatorDomainSpec } from './spec.ts'
import { driftReason, driftSignals } from './drift.ts'
import type { DriftFloors, DriftSignals, RecordedExperiment } from './drift.ts'
import {
  appendLedger,
  curatorHome,
  pathExists,
  readBlob,
  readLedger,
  readTextBlob,
  recordSha,
  resolveBackupDir,
  reverseMoves,
  snapshotPass,
  snapshotPreRollback,
  writeBlob,
} from './safety.ts'
import type { LedgerEntry } from './safety.ts'
import { orderStaged, stageCandidate } from './stage.ts'
import {
  applyConsolidation,
  executeConsolidationTool,
  frameConsolidationInput,
  runConsolidationFork,
} from './consolidate.ts'
import type {
  ConsolidationReport,
  ConsolidationSurvey,
  ConsolidationVerdict,
  CuratorMaybeRunOptions,
  CuratorReport,
  CuratorRunOptions,
  CuratorTransition,
  PassSummary,
  PurgeReport,
  RegressionDebt,
  RollbackOptions,
  RollbackReport,
  StagedCandidate,
  StagedSkill,
  SurveyCandidate,
} from './types.ts'

export type {
  ConsolidationCost,
  ConsolidationRefusal,
  ConsolidationReport,
  ConsolidationSurvey,
  ConsolidationVerdict,
  CuratorMaybeRunOptions,
  CuratorReport,
  CuratorRunOptions,
  CuratorTransition,
  PassSummary,
  PurgeReport,
  RegressionDebt,
  RollbackOptions,
  RollbackReport,
  StageThresholds,
  StagedCandidate,
  StagedSkill,
} from './types.ts'
export { curatorDomainSpec } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Idle-triggered automatic skill lifecycle owner. */
    evolutionCurator: EvolutionCurator
  }
}

/** Single bookkeeping key in the `meta` table. */
const STATE_KEY = 'state'

/**
 * The identity one regression debt merges under: its skill and its failure.
 * Skill names are kebab-case without whitespace, so no merge key — which
 * starts after the separator — collides with another skill's prefix.
 * @param name - skill carrying the failure.
 * @param mergeKey - tool-and-message identity of the failure.
 * @returns the debt-table key.
 */
/** Debt-table key separator: one NUL, the same identity merge keys use. */
const DEBT_KEY_SEPARATOR = String.fromCharCode(0)

function debtKeyOf(name: string, mergeKey: string): string {
  return `${name}${DEBT_KEY_SEPARATOR}${mergeKey}`
}

/** Timeout reason code for one consolidation run. */
export const EVOLUTION_CONSOLIDATE_TIMEOUT = 'EVOLUTION_CONSOLIDATE_TIMEOUT'

/**
 * Read one required string from ledger evidence. Hand-edited ledger lines
 * fail loudly instead of rolling back the wrong skill.
 * @param entry - ledger entry.
 * @param key - evidence key.
 * @returns the evidence value.
 */
function reqEvidence(entry: LedgerEntry, key: string): string {
  const value = entry.evidence[key]
  if (value === undefined) throw new Error(`evolution-curator: ledger entry '${entry.id}' is missing evidence '${key}'`)
  return value
}

/** Deployment choices for automatic skill lifecycle curation. */
export interface Config {
  /** Master switch; removal-equivalent off state skips every pass and starts no timer. */
  enabled?: boolean
  /** Minimum hours between two passes. */
  intervalHours?: number
  /** Minimum observed idle hours before a pass runs. */
  minIdleHours?: number
  /** Minutes between host-wide due-checks. */
  tickMinutes?: number
  /** Idle days moving `active` to `stale`. */
  staleAfterDays?: number
  /** Idle days moving `stale` to `archived`. */
  archiveAfterDays?: number
  /** Attributed trust failures moving `active` to `stale`, regardless of idleness. */
  staleTrustFailureFloor?: number
  /** Days a graded failure stays recent for the §22 failure-spike signal. */
  driftWindowDays?: number
  /**
   * Utility excess at or below which §22 counts a skill's measured utility as
   * low, where the excess is the skill's clean-outcome share minus its
   * peers'. Zero is the pooled baseline; a deployment that wants more slack
   * raises it.
   */
  lowUtilityFloor?: number
  /** Skill names exempt from automatic transitions, such as schedule references. */
  protectedNames?: string[]
  /** Whether bundled built-in skills are pruned from passes; hub sources are always exempt. */
  pruneBuiltins?: boolean
  /** Per-pass snapshot backups. */
  backup?: {
    /** Master switch for snapshots and ledger writes. */
    enabled?: boolean
    /** Snapshot tarballs retained after pruning. */
    keep?: number
  }
  /** Idle days an archived skill waits before purge eligibility; zero never purges. */
  archiveTtlDays?: number
  /** Opt-in LLM consolidation of agent-created skills. */
  consolidate?: boolean
  /** Provider route for consolidation; set with `model`. */
  provider?: string
  /** Model id for consolidation; set with `provider`. */
  model?: string
  /** Byte budget for the framed consolidation survey. */
  maxInputBytes?: number
  /** Output-token cap per consolidation request. */
  maxOutputTokens?: number
  /** Consolidation requests the bounded tool loop may spend. */
  maxSteps?: number
  /** Recorded failures carried per survey candidate as reflection evidence. */
  maxCandidateFailures?: number
  /** Per-consolidation-request deadline in milliseconds. */
  timeoutMs?: number
  /** Recorded loads required before a failure rate stages a skill. */
  stageMinUses?: number
  /** Failure share a skill must exceed to be staged, in 0..1. */
  stageFailureRate?: number
  /** Total changed-line ceiling (added plus removed) a consolidation `patch` body may not exceed; `0` leaves it unbounded. */
  maxDiffLines?: number
  /**
   * Refuse a consolidation `patch` the verifier ladder did not fully pass —
   * an abstention as well as a failure — instead of committing on levels 0
   * and 1 alone. Default `false` keeps today's behavior.
   */
  requireVerifierPass?: boolean
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().step(1).min(1).default(168),
  minIdleHours: z.number().step(1).min(0).default(2),
  tickMinutes: z.number().step(1).min(1).default(15),
  staleAfterDays: z.number().step(1).min(1).default(30),
  archiveAfterDays: z.number().step(1).min(1).default(90),
  staleTrustFailureFloor: z.number().step(1).min(1).default(3),
  driftWindowDays: z.number().step(1).min(1).default(14),
  lowUtilityFloor: z.number().min(-1).max(1).default(0),
  protectedNames: z.array(z.string()).default([]),
  pruneBuiltins: z.boolean().default(true),
  backup: z.object({
    enabled: z.boolean().default(true),
    keep: z.number().step(1).min(1).default(5),
  }),
  archiveTtlDays: z.number().step(1).min(0).default(0),
  consolidate: z.boolean().default(false),
  provider: z.string(),
  model: z.string(),
  maxInputBytes: z.number().step(1).min(1).default(65536),
  maxOutputTokens: z.number().step(1).min(1).default(2048),
  maxSteps: z.number().step(1).min(1).default(4),
  maxCandidateFailures: z.number().step(1).min(0).default(5),
  timeoutMs: z.number().step(1).min(1).default(60000),
  stageMinUses: z.number().step(1).min(1).default(20),
  stageFailureRate: z.number().min(0).max(1).default(0.3),
  maxDiffLines: z.number().step(1).min(0).default(0),
  requireVerifierPass: z.boolean().default(false),
})

/** Normalized configuration used by the curator. */
export interface ResolvedConfig {
  enabled: boolean
  intervalHours: number
  minIdleHours: number
  tickMinutes: number
  staleAfterDays: number
  archiveAfterDays: number
  staleTrustFailureFloor: number
  driftWindowDays: number
  lowUtilityFloor: number
  protectedNames: string[]
  pruneBuiltins: boolean
  backup: {
    enabled: boolean
    keep: number
  }
  archiveTtlDays: number
  consolidate: boolean
  provider: string | undefined
  model: string | undefined
  maxInputBytes: number
  maxOutputTokens: number
  maxSteps: number
  maxCandidateFailures: number
  timeoutMs: number
  stageMinUses: number
  stageFailureRate: number
  maxDiffLines: number
  requireVerifierPass: boolean
}

/**
 * Resolve defaults for optional fields. An archive threshold below the stale
 * threshold fails loudly: stale skills would archive on sight. A half-set
 * consolidation route, or an opted-in consolidation without one, fails loudly
 * too: a fork that cannot name a model would otherwise skip silently.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const {
    enabled = true,
    intervalHours = 168,
    minIdleHours = 2,
    tickMinutes = 15,
    staleAfterDays = 30,
    archiveAfterDays = 90,
    staleTrustFailureFloor = 3,
    driftWindowDays = 14,
    lowUtilityFloor = 0,
    protectedNames = [],
    pruneBuiltins = true,
    backup: { enabled: backupEnabled = true, keep: backupKeep = 5 } = {},
    archiveTtlDays = 0,
    consolidate = false,
    provider,
    model,
    maxInputBytes = 65536,
    maxOutputTokens = 2048,
    maxSteps = 4,
    maxCandidateFailures = 5,
    timeoutMs = 60000,
    stageMinUses = 20,
    stageFailureRate = 0.3,
    maxDiffLines = 0,
    requireVerifierPass = false,
  } = config
  if (archiveAfterDays < staleAfterDays) {
    throw new Error(`evolution-curator: archiveAfterDays (${archiveAfterDays}) must not be below staleAfterDays (${staleAfterDays})`)
  }
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('evolution-curator: provider and model must be set together')
  }
  if (consolidate && (provider === undefined || model === undefined)) {
    throw new Error('evolution-curator: consolidate requires both provider and model')
  }
  return {
    enabled,
    intervalHours,
    minIdleHours,
    tickMinutes,
    staleAfterDays,
    archiveAfterDays,
    staleTrustFailureFloor,
    driftWindowDays,
    lowUtilityFloor,
    protectedNames,
    pruneBuiltins,
    backup: { enabled: backupEnabled, keep: backupKeep },
    archiveTtlDays,
    consolidate,
    provider,
    model,
    maxInputBytes,
    maxOutputTokens,
    maxSteps,
    maxCandidateFailures,
    timeoutMs,
    stageMinUses,
    stageFailureRate,
    maxDiffLines,
    requireVerifierPass,
  }
}

/**
 * Failure evidence beyond idleness, read off the telemetry record the pass
 * already holds. Absent counters read as zero, never as movement.
 */
interface StalenessEvidence {
  /** Times attributed evidence demoted this skill. */
  trustFailures: number
  /** An attributed failure with no newer load answering it. */
  failureUnanswered: boolean
  /** `skill`-tool loads and failures observed, for the rate rule. */
  loads: number
  /** Failed `skill`-tool loads. */
  failureCount: number
  /** Outcome of the most recent load, or undefined when never loaded. */
  lastOutcome: 'ok' | 'failed' | undefined
  /** Whether the most recent load is newer than the last attributed failure. */
  usedAfterFailure: boolean
  /**
   * Whether the most recent load succeeded and is newer than the instant the
   * skill entered `suspect`: the load that answers the evidence behind it.
   */
  usedAfterSuspect: boolean
  /** The §22 drift signals the pass read from this skill's records. */
  drift: DriftSignals
}

/** Floors behind the failure-driven movements. */
interface StalenessFloors {
  /** Attributed failures moving `active` to `stale`. */
  trustFailureFloor: number
  /** Loads required before a failure rate can move a skill. */
  minUses: number
  /** Failure share a skill must exceed to move, in 0..1. */
  failureRate: number
}

/**
 * Decide one skill's automatic movement from its idle age and its evidence.
 * Idleness still moves skills down on its own; every evidence-driven movement
 * lands on `suspect`, the §22 rung between `active` and `stale`, because a
 * single pass of evidence questions a skill rather than retiring it: drift
 * signals §22 names, attributed trust failures, and a bad load rate each move
 * an `active` skill to `suspect` even while it is used — but only while the
 * evidence is unanswered, so a later successful load quiets the rule instead
 * of oscillating against the revivals below. `suspect` ages into `stale` on
 * the same idle threshold `active` does, and a `suspect` skill whose most
 * recent load succeeded while still inside the stale window answers its drift
 * and returns to `active`. A `stale` skill whose most recent load succeeded —
 * recently enough to still be inside the stale window, and newer than its
 * last attributed failure — also returns to `active`; past the archive
 * horizon it archives instead, so no successful load resurrects the long dead.
 * @param state - current lifecycle state.
 * @param idleMs - milliseconds since last use, or seeding when never used.
 * @param staleMs - idle threshold leaving `active`.
 * @param archiveMs - idle threshold leaving `stale`.
 * @param evidence - failure and drift evidence off the skill's records.
 * @param floors - floors behind the failure-driven movements.
 * @returns the next state with its reason, or undefined when the skill stays put.
 */
function decideTransition(
  state: SkillLifecycleState,
  idleMs: number,
  staleMs: number,
  archiveMs: number,
  evidence: StalenessEvidence,
  floors: StalenessFloors,
): { state: SkillLifecycleState; reason: string } | undefined {
  if (state === 'active') {
    if (idleMs > staleMs) {
      return { state: 'stale', reason: `idle ${Math.floor(idleMs / 86400000)}d exceeds ${Math.floor(staleMs / 86400000)}d` }
    }
    const drift = driftReason(evidence.drift)
    if (drift !== undefined) return { state: 'suspect', reason: drift }
    if (evidence.trustFailures >= floors.trustFailureFloor && evidence.failureUnanswered) {
      return { state: 'suspect', reason: `trust failures ${evidence.trustFailures} reach ${floors.trustFailureFloor}` }
    }
    if (evidence.lastOutcome === 'failed' && evidence.loads >= floors.minUses && evidence.failureCount / evidence.loads > floors.failureRate) {
      return {
        state: 'suspect',
        reason: `failures ${evidence.failureCount}/${evidence.loads} exceed ${Math.round(floors.failureRate * 100)}%`,
      }
    }
    return undefined
  }
  if (state === 'suspect') {
    if (idleMs > staleMs) {
      return { state: 'stale', reason: `idle ${Math.floor(idleMs / 86400000)}d exceeds ${Math.floor(staleMs / 86400000)}d` }
    }
    if (evidence.usedAfterSuspect) {
      return { state: 'active', reason: `last load ok ${Math.floor(idleMs / 86400000)}d ago` }
    }
    return undefined
  }
  if (state === 'stale') {
    if (idleMs > archiveMs) {
      return { state: 'archived', reason: `idle ${Math.floor(idleMs / 86400000)}d exceeds ${Math.floor(archiveMs / 86400000)}d` }
    }
    if (evidence.lastOutcome === 'ok' && idleMs <= staleMs && evidence.usedAfterFailure) {
      return { state: 'active', reason: `last load ok ${Math.floor(idleMs / 86400000)}d ago` }
    }
    return undefined
  }
  return undefined
}

/**
 * The slice of `ctx.evolutionUncertainty` the drift rules read. Declared
 * structurally rather than imported so the curator keeps no dependency on the
 * uncertainty package: the store is an optional source, and a host without it
 * still runs the other three signals.
 */
interface UncertaintySeam {
  /**
   * @param skill - skill to read signals for.
   * @returns the recorded signals of that skill.
   */
  signals(skill?: string): readonly { kind: string; at: string }[]
}

/**
 * Whether a context value offers the uncertainty reads the drift rules call.
 * Absent and foreign values answer false instead of throwing.
 * @param value - the value read from `ctx.get('evolutionUncertainty')`.
 * @returns whether the value can report signals.
 */
function isUncertaintySeam(value: unknown): value is UncertaintySeam {
  return typeof Reflect.get(Object(value), 'signals') === 'function'
}

/**
 * The slice of `ctx.evolutionLineage` the drift rules read. Declared
 * structurally rather than imported, for the same reason as
 * {@link UncertaintySeam}: the lineage store is an optional source, and a host
 * without it reports no version change rather than guessing one.
 */
interface LineageSeam {
  /**
   * @param skill - optional skill filter.
   * @returns the recorded experiment envelopes.
   */
  experiments(skill?: string): readonly {
    skill: string
    at: string
    dependencies: Readonly<Record<string, string>>
  }[]
}

/**
 * Whether a context value offers the lineage reads the drift rules call.
 * @param value - the value read from `ctx.get('evolutionLineage')`.
 * @returns whether the value can report experiment envelopes.
 */
function isLineageSeam(value: unknown): value is LineageSeam {
  return typeof Reflect.get(Object(value), 'experiments') === 'function'
}

/**
 * Idle-triggered automatic skill lifecycle curator. Opens the
 * `evolution_curator` domain at init and closes it through `ctx.effect`.
 * Transitions apply through skill telemetry, which stays optional: without
 * the store a pass only advances the bookkeeping.
 */
export class EvolutionCurator extends Service {
  static inject = ['storageDomain', 'skills']

  private table?: KvTable<string, { lastRunAt: string | null }>
  private debts?: KvTable<string, RegressionDebt>
  private readonly resolved: ResolvedConfig
  /** Newest host-wide session activity this process observed, or null before any. */
  private lastActivityAt: number | null = null
  /** Cancellation for every consolidation run in flight. */
  private readonly active = new Set<AbortController>()
  /** Public maintenance operations that teardown must await. */
  private readonly inFlight = new Set<Promise<unknown>>()
  /** Set before teardown cancels runs and blocks new work. */
  private stopping = false

  /**
   * @param ctx - Host context carrying the storage domain and skill registry.
   * @param config - intervals, thresholds, and protected names.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionCurator')
    this.resolved = resolveConfig(config)
  }

  /**
   * Open the domain, observe host-wide activity, and own the maintenance
   * schedule. No consumer can trigger a pass before this method's
   * `ctx.provide` takes effect, so the start-time due-check runs
   * fire-and-forget, matching the interval tick, and plugin startup never
   * waits on a background pass. Teardown stops the timer, aborts active
   * consolidation, awaits in-flight passes, then closes the domain.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(curatorDomainSpec)
    this.table = domain.table('meta')
    this.debts = domain.table('debt')
    this.ctx.on('session/event', () => {
      this.lastActivityAt = Date.now()
    })
    const timer: { handle?: ReturnType<typeof setInterval> } = {}
    this.ctx.effect(() => async () => {
      clearInterval(timer.handle)
      await this.drain()
      await domain.close()
    }, 'evolution-curator.lifecycle')
    if (!this.resolved.enabled) return
    const runScheduledPass = (): void => {
      void this.maybeRun().catch((error: unknown) => {
        this.ctx.logger.warn(`evolution curator scheduled pass failed: ${String(error)}`)
      })
    }
    runScheduledPass()
    const handle = setInterval(runScheduledPass, this.resolved.tickMinutes * 60_000)
    timer.handle = handle
    handle.unref()
  }

  /**
   * Read the last pass instant.
   * @returns the ISO-8601 instant, or null before the first pass.
   */
  lastRunAt(): string | null {
    return this.requireTable().get(STATE_KEY)?.lastRunAt ?? null
  }

  /**
   * Run one pass over every tracked skill, applying or previewing idle
   * lifecycle movements. A real pass with movements writes one snapshot
   * tarball plus pass and transition ledger entries when backups are on.
   * @param options - clock override and dry-run preview flag.
   * @returns the pass report with every movement.
   * @throws when teardown has begun.
   */
  run(options: CuratorRunOptions = {}): Promise<CuratorReport> {
    if (this.stopping) return Promise.reject(new Error('evolution-curator: service is disposing'))
    return this.track(this.runPass(options))
  }

  private async runPass(options: CuratorRunOptions = {}): Promise<CuratorReport> {
    const now = options.now ?? Date.now()
    const dryRun = options.dryRun ?? false
    const at = new Date(now).toISOString()
    const report: CuratorReport = {
      at,
      dryRun,
      scanned: 0,
      transitions: [],
      skippedPinned: 0,
      skippedProtected: 0,
      skippedExcluded: 0,
      passId: null,
      snapshot: null,
      staged: [],
      regressionDebt: [],
    }
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    if (telemetry === undefined) {
      await this.stampLastRun(at)
      return report
    }
    const staleMs = this.resolved.staleAfterDays * 24 * 3600 * 1000
    const archiveMs = this.resolved.archiveAfterDays * 24 * 3600 * 1000
    const summaries = await this.ctx.skills.list()
    const sourceOf = new Map(summaries.map(skill => [skill.name, skill.source] as const))
    const applied: { transition: CuratorTransition; before: SkillUsageRecord; after: SkillUsageRecord }[] = []
    const thresholds = { minUses: this.resolved.stageMinUses, failureRate: this.resolved.stageFailureRate }
    const entries = telemetry.entries()
    // The utility reading's baseline arm is every other tracked skill, so the
    // pass holds all records rather than reading the store again per skill.
    const usages = entries.map(entry => entry.usage)
    const experiments = this.experiments()
    const uncertainty: unknown = this.ctx.get('evolutionUncertainty')
    const conflicts = isUncertaintySeam(uncertainty) ? uncertainty : undefined
    const floors: DriftFloors = {
      windowDays: this.resolved.driftWindowDays,
      utilityFloor: this.resolved.lowUtilityFloor,
    }
    for (const [index, { name, usage }] of entries.entries()) {
      report.scanned += 1
      const source = sourceOf.get(name) ?? 'custom'
      // Hub sources are always outside curation; bundled built-ins follow
      // `pruneBuiltins`. Protected names are the operator's explicit opt-out.
      if (source.startsWith('hub') || (this.resolved.pruneBuiltins && source === 'bundled')) {
        report.skippedExcluded += 1
        continue
      }
      if (this.resolved.protectedNames.includes(name)) {
        report.skippedProtected += 1
        continue
      }
      // Staging is evidence, never movement, so a pinned skill still stages:
      // the pin protects a skill from being moved, not from being looked at.
      const candidate = stageCandidate(name, usage, thresholds)
      if (candidate !== undefined) report.staged.push(candidate)
      if (usage.pinned) {
        report.skippedPinned += 1
        continue
      }
      // The trust pass and the §22 failure-spike signal read the same graded
      // failures, so they are read once before either runs.
      const signals = this.signalsFor(name, usage)
      if (!dryRun && signals !== undefined) {
        await this.recordTrust(telemetry, name, usage, at, signals)
        await this.recordRegressionDebt(name, usage, signals, at)
      }
      const idleMs = now - Date.parse(usage.lastUsedAt ?? usage.createdAt)
      const failureCount = usage.failureCount ?? 0
      const loads = usage.useCount + failureCount
      const lastUsedMs = usage.lastUsedAt === null ? null : Date.parse(usage.lastUsedAt)
      const failureMs = usage.lastTrustFailure === null ? null : Date.parse(usage.lastTrustFailure.at)
      const moved = decideTransition(usage.state, idleMs, staleMs, archiveMs, {
        trustFailures: usage.trustFailures,
        failureUnanswered: failureMs !== null && (lastUsedMs === null || failureMs > lastUsedMs),
        loads,
        failureCount,
        lastOutcome: usage.lastOutcome,
        usedAfterFailure: lastUsedMs !== null && (failureMs === null || lastUsedMs > failureMs),
        // A suspect record always carries the instant it entered the state;
        // an unstamped one falls back to its creation instant, so any
        // successful load since then answers it.
        usedAfterSuspect: usage.lastOutcome === 'ok'
          && lastUsedMs !== null
          && lastUsedMs > Date.parse(usage.suspectAt ?? usage.createdAt),
        drift: driftSignals(
          usage,
          usages.filter((_, other) => other !== index),
          signals ?? [],
          conflicts?.signals(name).filter(signal => signal.kind === 'conflicting-evidence').map(signal => signal.at) ?? [],
          experiments.filter(experiment => experiment.skill === name),
          now,
          floors,
        ),
      }, {
        trustFailureFloor: this.resolved.staleTrustFailureFloor,
        minUses: this.resolved.stageMinUses,
        failureRate: this.resolved.stageFailureRate,
      })
      if (moved === undefined) continue
      const transition: CuratorTransition = {
        name,
        from: usage.state,
        to: moved.state,
        reason: moved.reason,
      }
      if (dryRun) {
        report.transitions.push(transition)
      } else {
        const after = await telemetry.setState(name, moved.state)
        report.transitions.push(transition)
        applied.push({ transition, before: usage, after })
      }
    }
    report.staged = orderStaged(report.staged)
    report.regressionDebt = this.debt()
    if (!dryRun && report.staged.length > 0 && this.resolved.backup.enabled) {
      await this.recordStaging(at, report.staged)
    }
    if (!dryRun && applied.length > 0 && this.resolved.backup.enabled) {
      const passId = randomUUID()
      const dirs = new Map<string, string>()
      for (const a of applied) {
        const dir = resolveBackupDir(summaries, a.transition.name)
        if (dir !== undefined) dirs.set(a.transition.name, dir)
      }
      report.snapshot = await this.backupPass(at, passId, applied.map(a => ({
        name: a.transition.name,
        reason: a.transition.reason,
        before: a.before,
        after: a.after,
      })), dirs)
      report.passId = passId
    }
    if (!dryRun && this.resolved.consolidate) {
      const consolidation = await this.consolidate({ now })
      if (consolidation !== undefined) report.consolidation = consolidation
    }
    await this.stampLastRun(at)
    return report
  }

  /**
   * Run a pass only when enabled, the interval elapsed since the last pass,
   * and enough idleness was observed. The first call only seeds the
   * bookkeeping and defers one interval. Idleness defaults to the newest
   * host-wide session activity this process observed; before any activity is
   * observed the host counts as idle.
   * @param options - clock and idleness overrides plus the dry-run flag.
   * @returns the pass report, or undefined when this call defers.
   * @throws when teardown has begun.
   */
  maybeRun(options: CuratorMaybeRunOptions = {}): Promise<CuratorReport | undefined> {
    if (this.stopping) return Promise.reject(new Error('evolution-curator: service is disposing'))
    return this.track(this.maybeRunPass(options))
  }

  private async maybeRunPass(options: CuratorMaybeRunOptions = {}): Promise<CuratorReport | undefined> {
    if (!this.resolved.enabled) return undefined
    const now = options.now ?? Date.now()
    const last = this.lastRunAt()
    if (last === null) {
      await this.stampLastRun(new Date(now).toISOString())
      return undefined
    }
    if (now - Date.parse(last) < this.resolved.intervalHours * 3600 * 1000) return undefined
    const idleMs = options.idleMs ?? (this.lastActivityAt === null ? Number.POSITIVE_INFINITY : now - this.lastActivityAt)
    if (idleMs < this.resolved.minIdleHours * 3600 * 1000) return undefined
    return this.run({ now, dryRun: options.dryRun })
  }

  /**
   * Survey agent-created skills for a future consolidation verdict: names,
   * catalog routing, lifecycle state, idle age, use counters, and the failures
   * recorded in the sessions that loaded each one. The verdict itself (keep,
   * patch, consolidate, archive) arrives separately; the survey never writes.
   * @param options - clock override.
   * @returns the verdict evidence per skill.
   */
  async surveyCandidates(options: CuratorRunOptions = {}): Promise<ConsolidationSurvey> {
    const now = options.now ?? Date.now()
    const at = new Date(now).toISOString()
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    if (telemetry === undefined) return { at, candidates: [] }
    const summaries = new Map((await this.ctx.skills.list()).map(skill => [skill.name, skill] as const))
    const feedback = this.ctx.get('evolutionFeedback')
    const candidates: SurveyCandidate[] = []
    for (const { name, usage } of telemetry.entries()) {
      if (usage.createdBy !== 'agent' || usage.state === 'archived') continue
      const summary = summaries.get(name)
      candidates.push({
        name,
        description: summary?.description ?? '',
        source: summary?.source ?? 'custom',
        state: usage.state,
        idleDays: Math.floor((now - Date.parse(usage.lastUsedAt ?? usage.createdAt)) / 86400000),
        useCount: usage.useCount,
        viewCount: usage.viewCount,
        patchCount: usage.patchCount,
        lastUsedAt: usage.lastUsedAt,
        failures: feedback === undefined
          ? []
          : feedback.signals(usage.sessionIds, this.resolved.maxCandidateFailures),
        trust: usage.trust,
        revision: usage.revision,
        contentSha: usage.contentSha,
        lastTrustFailure: usage.lastTrustFailure,
      })
    }
    candidates.sort((a, b) => (a.name < b.name ? -1 : 1))
    return { at, candidates }
  }

  /**
   * Run one opt-in LLM consolidation over the agent-created skills this
   * curator tracks. Returns undefined when consolidation is off, when the
   * seam is unmounted, or when no candidate awaits a verdict. A cost row
   * reaches the ledger before the fork starts; the fork runs as a bounded
   * in-package tool loop over `ctx.llm`; the returned verdicts apply under
   * the full-package rule and land in the same snapshot, ledger, and rollback
   * machinery as an automatic pass.
   * @param options - clock override.
   * @returns the consolidation report, or undefined when no run happened.
   * @throws when teardown has begun.
   */
  consolidate(options: CuratorRunOptions = {}): Promise<ConsolidationReport | undefined> {
    if (this.stopping) return Promise.reject(new Error('evolution-curator: service is disposing'))
    return this.track(this.consolidatePass(options))
  }

  private async consolidatePass(options: CuratorRunOptions = {}): Promise<ConsolidationReport | undefined> {
    if (!this.resolved.consolidate) return undefined
    const llm = this.ctx.get('llm')
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    const provider = this.resolved.provider
    const model = this.resolved.model
    if (llm === undefined || telemetry === undefined || provider === undefined || model === undefined) {
      throw new Error('evolution-curator: consolidation requires the llm seam, the telemetry store, and a provider/model route')
    }
    const now = options.now ?? Date.now()
    const at = new Date(now).toISOString()
    const survey = await this.surveyCandidates({ now })
    if (survey.candidates.length === 0) return undefined
    const candidates = new Map(survey.candidates.map(candidate => [candidate.name, candidate] as const))
    const summaries = await this.ctx.skills.list()
    // Every writable catalog directory, so a merge can find an umbrella that
    // is not itself a consolidation candidate.
    const dirs = new Map<string, string>()
    for (const summary of summaries) {
      const dir = resolveBackupDir(summaries, summary.name)
      if (dir !== undefined) dirs.set(summary.name, dir)
    }
    const framed = frameConsolidationInput(survey.candidates, this.resolved.maxInputBytes)
    const cost = {
      inputBytes: framed.inputBytes,
      maxOutputTokens: this.resolved.maxOutputTokens,
      provider,
      model,
      truncated: framed.truncated,
    }
    const home = curatorHome()
    const passId = randomUUID()
    await appendLedger(home, {
      id: randomUUID(),
      at,
      actor: 'curator',
      action: 'cost',
      evidence: {
        passId,
        inputBytes: String(cost.inputBytes),
        maxOutputTokens: String(cost.maxOutputTokens),
        provider,
        model,
        truncated: String(cost.truncated),
      },
      before: null,
      after: null,
    })
    telemetry.recordConsolidationCost(cost)
    const verdicts: ConsolidationVerdict[] = []
    if (this.stopping) throw new Error('evolution-curator: service is disposing')
    const controller = new AbortController()
    this.active.add(controller)
    let steps: number
    try {
      using callDeadline = deadline(controller.signal, this.resolved.timeoutMs, EVOLUTION_CONSOLIDATE_TIMEOUT)
      steps = await runConsolidationFork({
        stream: request => llm.stream(request),
        execute: (name, args) => executeConsolidationTool({ candidates, dirs, verdicts }, name, args),
      }, {
        provider,
        model,
        maxOutputTokens: cost.maxOutputTokens,
        maxSteps: this.resolved.maxSteps,
        input: framed.text,
        signal: callDeadline.signal,
      })
    } finally {
      this.active.delete(controller)
    }
    const applied = await applyConsolidation(
      {
        at, passId, home, telemetry, candidates, dirs,
        maxDiffLines: this.resolved.maxDiffLines,
        requireVerifierPass: this.resolved.requireVerifierPass,
      },
      verdicts,
    )
    let snapshot: string | null = null
    // A pass that only patched bodies still records its `pass` row: that row
    // is the anchor `/curator rollback --id` resolves, and each patch row
    // carries the preimage its rollback restores.
    if ((applied.transitions.length > 0 || applied.patched > 0) && this.resolved.backup.enabled) {
      const movedDirs = new Map(applied.transitions.map(transition => [transition.name, transition.dir] as const))
      snapshot = await this.backupPass(at, passId, applied.transitions.map(transition => ({
        name: transition.name,
        reason: 'consolidation',
        before: transition.before,
        after: transition.after,
      })), movedDirs)
    }
    return {
      at,
      passId: snapshot === null ? null : passId,
      snapshot,
      cost,
      verdicts,
      skipped: applied.skipped,
      refusals: applied.refusals,
      steps,
    }
  }

  /** Track a maintenance operation until its full storage and filesystem work settles. */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation)
    void operation.then(
      () => { this.inFlight.delete(operation) },
      () => { this.inFlight.delete(operation) },
    )
    return operation
  }

  /** Abort consolidation requests and await every pass before storage closes. */
  private async drain(): Promise<void> {
    this.stopping = true
    for (const controller of this.active) controller.abort(new Error('evolution-curator: service disposed'))
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
  }

  private async stampLastRun(at: string): Promise<void> {
    await this.requireTable().put(STATE_KEY, { lastRunAt: at })
  }

  /**
   * The graded failures recorded for one skill's sessions. Both the drift
   * signal and the pass's trust pass read them, so they are read once. An
   * unmounted feedback store is no signals rather than a failure; a store that
   * throws yields undefined, which keeps the trust pass's own rule — a skill
   * whose failures could not be read is not credited for them — while the
   * drift signal reads no signals either.
   * @param name - skill name.
   * @param usage - the skill's usage record.
   * @returns the graded signals, or undefined when the read failed.
   */
  private signalsFor(name: string, usage: SkillUsageRecord): readonly FeedbackSignal[] | undefined {
    try {
      const feedback = this.ctx.get('evolutionFeedback')
      return feedback === undefined ? [] : feedback.signals(usage.sessionIds, this.resolved.maxCandidateFailures)
    } catch (error) {
      this.ctx.logger.warn(`evolution curator could not read failures for '${name}': ${String(error)}`)
      return undefined
    }
  }

  /**
   * The recorded experiment envelopes this pass reads, each reduced to the
   * skill, instant, and dependency versions the §22 version rule compares.
   * The lineage store is an optional source: unmounted, the rule sees no
   * envelopes and reports no version change rather than guessing one.
   * @returns one row per recorded envelope.
   */
  private experiments(): readonly RecordedExperiment[] {
    const lineage: unknown = this.ctx.get('evolutionLineage')
    if (!isLineageSeam(lineage)) return []
    return lineage.experiments().map(envelope => ({
      skill: envelope.skill,
      at: envelope.at,
      dependencies: envelope.dependencies,
    }))
  }

  /**
   * Record what the correlated evidence says about one skill's trust. An
   * attributable failure demotes it; without one, every session that loaded it
   * counts as an independent success observation. A failing telemetry store
   * must not break the lifecycle pass, so one skill's error is logged and the
   * pass continues.
   * @param telemetry - store receiving the observation.
   * @param name - skill name.
   * @param usage - the record as the pass found it.
   * @param at - ISO-8601 instant the pass ran.
   * @param signals - the pass's graded failures for this skill's sessions.
   */
  private async recordTrust(
    telemetry: EvolutionSkillTelemetry,
    name: string,
    usage: SkillUsageRecord,
    at: string,
    signals: readonly FeedbackSignal[],
  ): Promise<void> {
    try {
      const attributable = signals.find(signal => signal.actionability === 'trigger_review')
      if (attributable === undefined) {
        for (const sessionId of usage.sessionIds) {
          await telemetry.recordTrustObservation(name, 'success', sessionId)
        }
        return
      }
      const newest = usage.sessionIds[0]
      if (newest === undefined) return
      await telemetry.recordTrustObservation(name, 'failure', newest, {
        mergeKey: attributable.mergeKey,
        message: attributable.message,
        at,
      })
    } catch (error) {
      this.ctx.logger.warn(`evolution curator could not record trust for '${name}': ${String(error)}`)
    }
  }

  /**
   * Maintain one skill's regression debt against the pass's decisive
   * failures. Every repeated failure deepens its open debt; a failure gone
   * silent closes its debt even while another persists; a skill revised since
   * a debt opened closes that debt and opens a fresh one, because the new
   * body has not answered the old failure. Debt writes share the pass's fate
   * like staging writes: the table is the curator's own domain, so a failure
   * there is systemic rather than per-skill.
   * @param name - skill name.
   * @param usage - the record as the pass found it.
   * @param signals - the pass's graded failures for this skill's sessions.
   * @param at - ISO-8601 instant the pass ran.
   */
  private async recordRegressionDebt(
    name: string,
    usage: SkillUsageRecord,
    signals: readonly FeedbackSignal[],
    at: string,
  ): Promise<void> {
    const debts = this.requireDebts()
    const prefix = debtKeyOf(name, '')
    const decisive = new Map(signals
      .filter(signal => signal.actionability === 'trigger_review')
      .map(signal => [signal.mergeKey, signal] as const))
    for (const key of debts.keys()) {
      if (key.startsWith(prefix) && !decisive.has(key.slice(prefix.length))) await debts.delete(key)
    }
    for (const attributable of decisive.values()) {
      const key = debtKeyOf(name, attributable.mergeKey)
      const open = debts.get(key)
      if (open !== undefined && open.revision !== usage.revision) await debts.delete(key)
      const current = open !== undefined && open.revision === usage.revision ? open : undefined
      if (current === undefined) {
        await debts.put(key, {
          name,
          mergeKey: attributable.mergeKey,
          message: attributable.message,
          firstSeenAt: at,
          lastSeenAt: at,
          passes: 1,
          sessions: attributable.sessions,
          revision: usage.revision,
        })
        continue
      }
      await debts.put(key, {
        ...current,
        message: attributable.message,
        lastSeenAt: at,
        passes: current.passes + 1,
        sessions: Math.max(current.sessions, attributable.sessions),
      })
    }
  }

  /**
   * Append one ledger line per newly staged skill. A skill still failing at
   * counters already on the ledger is staged already, so re-appending would
   * grow the ledger by one line every pass forever; the counters are the
   * comparison, and they only move when the skill was used again.
   * @param at - ISO-8601 instant of the pass.
   * @param staged - this pass's staged candidates.
   */
  private async recordStaging(at: string, staged: readonly StagedCandidate[]): Promise<void> {
    const home = curatorHome()
    const latest = new Map<string, string>()
    for (const entry of await readLedger(home)) {
      if (entry.action !== 'stage') continue
      latest.set(reqEvidence(entry, 'name'), `${reqEvidence(entry, 'useCount')}:${reqEvidence(entry, 'failureCount')}`)
    }
    for (const candidate of staged) {
      if (latest.get(candidate.name) === `${candidate.useCount}:${candidate.failureCount}`) continue
      await appendLedger(home, {
        id: randomUUID(),
        at,
        actor: 'curator',
        action: 'stage',
        evidence: {
          name: candidate.name,
          useCount: String(candidate.useCount),
          failureCount: String(candidate.failureCount),
          failureRate: String(candidate.failureRate),
          reason: candidate.reason,
        },
        before: null,
        after: null,
      })
    }
  }

  /**
   * List the skills the ledger currently stages, worst failure rate first
   * with ties by ascending name. Only the newest entry per skill counts, so a
   * skill restaged after further failures appears once at its latest rate.
   * @returns one row per staged skill.
   */
  async staged(): Promise<StagedSkill[]> {
    const latest = new Map<string, StagedSkill>()
    for (const entry of await readLedger(curatorHome())) {
      if (entry.action !== 'stage') continue
      const name = reqEvidence(entry, 'name')
      latest.set(name, {
        name,
        useCount: Number(reqEvidence(entry, 'useCount')),
        failureCount: Number(reqEvidence(entry, 'failureCount')),
        failureRate: Number(reqEvidence(entry, 'failureRate')),
        reason: reqEvidence(entry, 'reason'),
        at: entry.at,
      })
    }
    return orderStaged([...latest.values()])
  }

  /**
   * Adopt one agent-created skill into user-directed standing, recording the
   * movement in the ledger. Manual only: clocks never reset.
   * @param name - skill name.
   * @returns the stored record with user-directed provenance.
   */
  async adopt(name: string): Promise<SkillUsageRecord> {
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    if (telemetry === undefined) throw new Error('evolution-curator: adopt requires the telemetry store')
    const before = telemetry.read(name)
    if (before === undefined) throw new Error(`evolution-curator: adopt has no record for '${name}'`)
    const next = await telemetry.markAdopted(name)
    const home = curatorHome()
    const at = new Date().toISOString()
    await writeBlob(home, recordSha(next), JSON.stringify(next))
    await appendLedger(home, {
      id: randomUUID(),
      at,
      actor: 'operator',
      action: 'adopt',
      evidence: { name },
      before: recordSha(before),
      after: recordSha(next),
    })
    return next
  }

  /**
   * Purge archived skills past their time-to-live: remove the skill directory
   * when resolvable, forget the record, and ledger each removal. Pinned
   * skills stay, a zero TTL purges nothing, and dry runs preview only.
   * @param options - clock override and dry-run preview flag.
   * @returns the purge report.
   */
  async purge(options: CuratorRunOptions = {}): Promise<PurgeReport> {
    const now = options.now ?? Date.now()
    const dryRun = options.dryRun ?? false
    const at = new Date(now).toISOString()
    const report: PurgeReport = { at, dryRun, purged: [], skippedPinned: 0 }
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    if (telemetry === undefined) return report
    const ttlMs = this.resolved.archiveTtlDays * 24 * 3600 * 1000
    if (ttlMs <= 0) return report
    const summaries = await this.ctx.skills.list()
    const home = curatorHome()
    for (const { name, usage } of telemetry.entries()) {
      if (usage.state !== 'archived') continue
      if (usage.pinned) {
        report.skippedPinned += 1
        continue
      }
      // A missing stamp parses to NaN, which never exceeds the TTL: unstamped
      // records stay instead of purging on sight.
      if (now - Date.parse(usage.archivedAt as string) <= ttlMs) continue
      const dir = resolveBackupDir(summaries, name)
      if (!dryRun) {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true })
        await telemetry.drop(name)
        await writeBlob(home, recordSha(usage), JSON.stringify(usage))
        await appendLedger(home, {
          id: randomUUID(),
          at,
          actor: 'operator',
          action: 'purge',
          evidence: { name, dir: dir ?? '' },
          before: recordSha(usage),
          after: null,
        })
      }
      report.purged.push({ name, dir: dir ?? null })
    }
    return report
  }

  /**
   * List recorded passes newest-first for status surfaces and rollback picks.
   * @returns one summary per ledger pass entry.
   */
  async passes(): Promise<PassSummary[]> {
    const entries = await readLedger(curatorHome())
    const transitions = entries.filter(entry => entry.action === 'transition')
    return entries
      .filter(entry => entry.action === 'pass')
      .map((entry) => {
        const passId = reqEvidence(entry, 'passId')
        return {
          passId,
          at: entry.at,
          snapshot: reqEvidence(entry, 'snapshot'),
          transitions: transitions.filter(t => reqEvidence(t, 'passId') === passId).length,
        }
      })
      .reverse()
  }

  /**
   * Roll back one whole recorded pass, restoring every transitioned skill's
   * lifecycle state and moving every package a consolidation run relocated
   * back to its original path. Verifies all evidence and every move before
   * writing anything, and snapshots current records first so the rollback
   * stays reversible.
   * @param passId - pass identity from the report or {@link passes}.
   * @param options - clock override.
   * @returns the rollback report.
   */
  async rollbackPass(passId: string, options: RollbackOptions = {}): Promise<RollbackReport> {
    const entries = await readLedger(curatorHome())
    const pass = entries.find(entry => entry.action === 'pass' && entry.evidence['passId'] === passId)
    if (pass === undefined) throw new Error(`evolution-curator: unknown pass '${passId}'`)
    const label = `pass '${passId}'`
    const moves = entries
      .filter(entry => entry.action === 'move' && entry.evidence['passId'] === passId)
      .map(entry => ({ name: reqEvidence(entry, 'name'), from: reqEvidence(entry, 'from'), to: reqEvidence(entry, 'to') }))
    const restoredDirs = await this.reversePackageMoves(label, moves, options.now ?? Date.now())
    const patches = entries.filter(entry => entry.action === 'patch' && entry.evidence['passId'] === passId)
    const restoredFiles = await this.revertPatchedBodies(label, patches, options.now ?? Date.now())
    const transitions = entries.filter(entry => entry.action === 'transition' && entry.evidence['passId'] === passId)
    const report = await this.applyRollback(curatorHome(), label, transitions, options.now ?? Date.now())
    return { ...report, restoredDirs, restoredFiles }
  }

  /**
   * Roll back one ledger transition entry. Fails closed on unknown ids,
   * missing blobs, and untracked skills, before any write.
   * @param entryId - ledger entry identity.
   * @param options - clock override.
   * @returns the rollback report.
   */
  async rollbackEntry(entryId: string, options: RollbackOptions = {}): Promise<RollbackReport> {
    const entries = await readLedger(curatorHome())
    const entry = entries.find(candidate => candidate.id === entryId && candidate.action === 'transition')
    if (entry === undefined) throw new Error(`evolution-curator: unknown ledger entry '${entryId}'`)
    const report = await this.applyRollback(curatorHome(), `entry '${entryId}'`, [entry], options.now ?? Date.now())
    return { ...report, restoredDirs: [], restoredFiles: [] }
  }

  private async backupPass(
    at: string,
    passId: string,
    applied: readonly { name: string; reason: string; before: SkillUsageRecord; after: SkillUsageRecord }[],
    dirs: ReadonlyMap<string, string>,
  ): Promise<string> {
    const home = curatorHome()
    const records = new Map(applied.map(a => [a.name, { before: a.before, after: a.after }]))
    const { archive, unresolved } = await snapshotPass(home, passId, at, records, dirs, this.resolved.backup.keep)
    const names = applied.map(a => a.name).join(',')
    await appendLedger(home, {
      id: randomUUID(),
      at,
      actor: 'curator',
      action: 'pass',
      evidence: { passId, snapshot: archive, names, unresolved: unresolved.join(',') },
      before: null,
      after: null,
    })
    for (const a of applied) {
      await appendLedger(home, {
        id: randomUUID(),
        at,
        actor: 'curator',
        action: 'transition',
        evidence: { passId, name: a.name, reason: a.reason, snapshot: archive },
        before: recordSha(a.before),
        after: recordSha(a.after),
      })
    }
    return archive
  }

  /** Reverse one pass's recorded package relocations and ledger each reversal. */
  private async reversePackageMoves(
    label: string,
    moves: readonly { name: string; from: string; to: string }[],
    now: number,
  ): Promise<string[]> {
    if (moves.length === 0) return []
    await reverseMoves(moves)
    const home = curatorHome()
    const at = new Date(now).toISOString()
    const restored: string[] = []
    for (const move of moves) {
      await appendLedger(home, {
        id: randomUUID(),
        at,
        actor: 'operator',
        action: 'rollback',
        evidence: { rollbackOf: label, name: move.name, dir: move.from },
        before: null,
        after: null,
      })
      restored.push(move.name)
    }
    return restored
  }

  /**
   * Restore the SKILL.md bodies one pass's patch rows replaced, then ledger
   * each restoration. Fails closed like {@link applyRollback}: every preimage
   * is verified before any file is written.
   * @param label - human label of the rolled-back unit.
   * @param patches - patch rows of that unit, in ledger order.
   * @param now - epoch milliseconds the rollback reasons about.
   * @returns the skill names whose body was restored, in ledger order.
   */
  private async revertPatchedBodies(label: string, patches: readonly LedgerEntry[], now: number): Promise<string[]> {
    if (patches.length === 0) return []
    const home = curatorHome()
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    if (telemetry === undefined) throw new Error(`evolution-curator: rollback ${label} requires the telemetry store`)
    const verified: { entry: LedgerEntry; name: string; file: string; body: string; current: SkillUsageRecord }[] = []
    for (const entry of patches) {
      const entryName = reqEvidence(entry, 'name')
      const file = entry.evidence['file']
      // A patch row written before bodies were snapshotted has no preimage to
      // restore, so that skill keeps the body its patch produced.
      if (entry.before === null || file === undefined) continue
      if (!(await pathExists(join(home, 'blobs', `${entry.before}.md`)))) {
        throw new Error(`evolution-curator: rollback ${label} is missing the body blob for '${entryName}'`)
      }
      const current = telemetry.read(entryName)
      if (current === undefined) {
        throw new Error(`evolution-curator: rollback ${label} cannot restore untracked skill '${entryName}'`)
      }
      verified.push({ entry, name: entryName, file, body: await readTextBlob(home, entry.before), current })
    }
    const at = new Date(now).toISOString()
    const restored: string[] = []
    for (const v of verified) {
      await writeFile(v.file, v.body)
      await telemetry.markRevised(v.name, v.body)
      await appendLedger(home, {
        id: randomUUID(),
        at,
        actor: 'operator',
        action: 'rollback',
        evidence: { rollbackOf: label, name: v.name, file: v.file },
        before: v.current.contentSha,
        after: v.entry.before,
      })
      restored.push(v.name)
    }
    return restored
  }

  private async applyRollback(home: string, label: string, transitions: LedgerEntry[], now: number): Promise<Omit<RollbackReport, 'restoredDirs' | 'restoredFiles'>> {
    const at = new Date(now).toISOString()
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    if (telemetry === undefined) throw new Error(`evolution-curator: rollback ${label} requires the telemetry store`)
    const verified: { entry: LedgerEntry; name: string; current: SkillUsageRecord; before: SkillUsageRecord }[] = []
    for (const entry of transitions) {
      const entryName = reqEvidence(entry, 'name')
      const current = telemetry.read(entryName)
      if (current === undefined) {
        throw new Error(`evolution-curator: rollback ${label} cannot restore untracked skill '${entryName}'`)
      }
      if (entry.before === null) {
        throw new Error(`evolution-curator: rollback ${label} entry '${entry.id}' holds no before state`)
      }
      const blob = join(home, 'blobs', `${entry.before}.json`)
      if (!(await pathExists(blob))) {
        throw new Error(`evolution-curator: rollback ${label} is missing the before blob for '${entryName}'`)
      }
      verified.push({ entry, name: entryName, current, before: JSON.parse(await readBlob(home, entry.before)) as SkillUsageRecord })
    }
    const preRollback = await snapshotPreRollback(home, new Map(verified.map(v => [v.name, v.current])))
    const restored: RollbackReport['restored'] = []
    for (const v of verified) {
      const next = await telemetry.setState(v.name, v.before.state, v.before.absorbedInto)
      await writeBlob(home, recordSha(next), JSON.stringify(next))
      await appendLedger(home, {
        id: randomUUID(),
        at,
        actor: 'operator',
        action: 'rollback',
        evidence: { rollbackOf: label, name: v.name, reason: reqEvidence(v.entry, 'reason'), preRollback },
        before: recordSha(v.current),
        after: recordSha(next),
      })
      restored.push({ name: v.name, from: v.current.state, to: next.state })
    }
    return { at, label, restored, preRollback }
  }

  private requireTable(): KvTable<string, { lastRunAt: string | null }> {
    if (this.table === undefined) throw new Error('evolution curator is not started yet')
    return this.table
  }

  private requireDebts(): KvTable<string, RegressionDebt> {
    if (this.debts === undefined) throw new Error('evolution curator is not started yet')
    return this.debts
  }

  /**
   * List every open regression debt, worst first: most passes, then most
   * sessions, then name and merge key. Passes count consecutive sightings, so
   * two co-open debts with equal passes opened on the same pass — the order
   * stays total through the key without reading timestamps. Synchronous: the
   * debt table is an in-memory read over the open domain, unlike the
   * filesystem-backed `staged()` listing.
   * @returns the open debts, detached from the store.
   */
  debt(): RegressionDebt[] {
    const rows = [...this.requireDebts().entries()].map(([, row]) => structuredClone(row))
    rows.sort((left, right) =>
      right.passes - left.passes
      || right.sessions - left.sessions
      || left.name.localeCompare(right.name)
      || left.mergeKey.localeCompare(right.mergeKey))
    return rows
  }
}

export default EvolutionCurator
