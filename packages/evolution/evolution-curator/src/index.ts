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
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { SkillLifecycleState, SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { curatorDomainSpec } from './spec.ts'
import {
  appendLedger,
  curatorHome,
  pathExists,
  readBlob,
  readLedger,
  recordSha,
  resolveBackupDir,
  reverseMoves,
  snapshotPass,
  snapshotPreRollback,
  writeBlob,
} from './safety.ts'
import type { LedgerEntry } from './safety.ts'
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
  RollbackOptions,
  RollbackReport,
  SurveyCandidate,
} from './types.ts'

export type {
  ConsolidationCost,
  ConsolidationReport,
  ConsolidationSurvey,
  ConsolidationVerdict,
  CuratorMaybeRunOptions,
  CuratorReport,
  CuratorRunOptions,
  CuratorTransition,
  PassSummary,
  PurgeReport,
  RollbackOptions,
  RollbackReport,
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
  /** Per-consolidation-request deadline in milliseconds. */
  timeoutMs?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().step(1).min(1).default(168),
  minIdleHours: z.number().step(1).min(0).default(2),
  tickMinutes: z.number().step(1).min(1).default(15),
  staleAfterDays: z.number().step(1).min(1).default(30),
  archiveAfterDays: z.number().step(1).min(1).default(90),
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
  timeoutMs: z.number().step(1).min(1).default(60000),
})

/** Normalized configuration used by the curator. */
export interface ResolvedConfig {
  enabled: boolean
  intervalHours: number
  minIdleHours: number
  tickMinutes: number
  staleAfterDays: number
  archiveAfterDays: number
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
  timeoutMs: number
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
    timeoutMs = 60000,
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
    timeoutMs,
  }
}

/**
 * Decide one skill's automatic movement from its idle age.
 * @param state - current lifecycle state.
 * @param idleMs - milliseconds since last use, or seeding when never used.
 * @param staleMs - idle threshold leaving `active`.
 * @param archiveMs - idle threshold leaving `stale`.
 * @returns the next state, or undefined when the skill stays put.
 */
function decideTransition(state: SkillLifecycleState, idleMs: number, staleMs: number, archiveMs: number): SkillLifecycleState | undefined {
  if (state === 'active' && idleMs > staleMs) return 'stale'
  if (state === 'stale' && idleMs > archiveMs) return 'archived'
  return undefined
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
  private readonly resolved: ResolvedConfig
  /** Newest host-wide session activity this process observed, or null before any. */
  private lastActivityAt: number | null = null
  /** Cancellation for the consolidation run in flight, aborted at teardown. */
  private active: AbortController | undefined

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
   * schedule. The start-time due-check runs first and awaits, so a short-lived
   * CLI process cannot exit before a due pass ran; the repeating tick is
   * `unref()`ed and disposed through `ctx.effect`.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(curatorDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-curator.domainClose')
    this.table = domain.table('meta')
    this.ctx.on('session/event', () => {
      this.lastActivityAt = Date.now()
    })
    if (!this.resolved.enabled) return
    this.ctx.effect(() => () => this.active?.abort(), 'evolution-curator.abort')
    await this.maybeRun()
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        void this.maybeRun().catch((error: unknown) => {
          this.ctx.logger.warn(`evolution curator scheduled pass failed: ${String(error)}`)
        })
      }, this.resolved.tickMinutes * 60_000)
      timer.unref()
      return () => {
        clearInterval(timer)
      }
    }, 'evolution-curator.tick')
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
   */
  async run(options: CuratorRunOptions = {}): Promise<CuratorReport> {
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
    for (const { name, usage } of telemetry.entries()) {
      report.scanned += 1
      if (usage.pinned) {
        report.skippedPinned += 1
        continue
      }
      if (this.resolved.protectedNames.includes(name)) {
        report.skippedProtected += 1
        continue
      }
      const source = sourceOf.get(name) ?? 'custom'
      // Hub sources are always outside curation; bundled built-ins follow
      // `pruneBuiltins`.
      if (source.startsWith('hub') || (this.resolved.pruneBuiltins && source === 'bundled')) {
        report.skippedExcluded += 1
        continue
      }
      const idleMs = now - Date.parse(usage.lastUsedAt ?? usage.createdAt)
      const to = decideTransition(usage.state, idleMs, staleMs, archiveMs)
      if (to === undefined) continue
      const transition: CuratorTransition = {
        name,
        from: usage.state,
        to,
        reason: `idle ${Math.floor(idleMs / 86400000)}d exceeds ${to === 'stale' ? this.resolved.staleAfterDays : this.resolved.archiveAfterDays}d`,
      }
      if (dryRun) {
        report.transitions.push(transition)
      } else {
        const after = await telemetry.setState(name, to)
        report.transitions.push(transition)
        applied.push({ transition, before: usage, after })
      }
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
   */
  async maybeRun(options: CuratorMaybeRunOptions = {}): Promise<CuratorReport | undefined> {
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
   * catalog routing, lifecycle state, idle age, and use counters, sorted by
   * name. The verdict itself (keep, patch, consolidate, archive) arrives
   * separately; the survey never writes.
   * @param options - clock override.
   * @returns the verdict evidence per skill.
   */
  async surveyCandidates(options: CuratorRunOptions = {}): Promise<ConsolidationSurvey> {
    const now = options.now ?? Date.now()
    const at = new Date(now).toISOString()
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    if (telemetry === undefined) return { at, candidates: [] }
    const summaries = new Map((await this.ctx.skills.list()).map(skill => [skill.name, skill] as const))
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
   */
  async consolidate(options: CuratorRunOptions = {}): Promise<ConsolidationReport | undefined> {
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
    const controller = new AbortController()
    this.active = controller
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
      this.active = undefined
    }
    const applied = await applyConsolidation({ at, passId, home, telemetry, candidates, dirs }, verdicts)
    let snapshot: string | null = null
    if (applied.transitions.length > 0 && this.resolved.backup.enabled) {
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
      steps,
    }
  }

  private async stampLastRun(at: string): Promise<void> {
    await this.requireTable().put(STATE_KEY, { lastRunAt: at })
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
    const transitions = entries.filter(entry => entry.action === 'transition' && entry.evidence['passId'] === passId)
    const report = await this.applyRollback(curatorHome(), label, transitions, options.now ?? Date.now())
    return { ...report, restoredDirs }
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
    return { ...report, restoredDirs: [] }
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

  private async applyRollback(home: string, label: string, transitions: LedgerEntry[], now: number): Promise<Omit<RollbackReport, 'restoredDirs'>> {
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
}

export default EvolutionCurator
