/**
 * Dreaming consolidation (`ctx.evolutionDreaming`): the three-phase cycle that
 * turns repeated observations into durable scope memory.
 *
 * Light gathers failure observations and stages what survives deduplication.
 * REM summarizes the staged candidates as themes and writes the narrative.
 * Deep is the only phase that writes durable memory: it scores every candidate
 * with the six-signal composite, admits those that clear every gate and whose
 * evidence it can attribute, folds a restatement into the narrative it
 * restates, retires the predecessor a correction replaces, and drops
 * promotions the decay rule has outlived. Every promotion write keeps its
 * preimage in the scope's ledger, so {@link EvolutionDreaming.rollback}
 * restores what the pass replaced.
 *
 * The cycle consumes the feedback seam and publishes into its own domain, so a
 * scope's promoted dreams are never a second writer on the model-owned lessons
 * document.
 * @module @deepseek-ai/dsh-evolution-dreaming
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-evolution-feedback'
import type {} from '@deepseek-ai/dsh-evolution-heartbeat'
import type {} from '@deepseek-ai/dsh-evolution-memory'
import type {} from '@deepseek-ai/dsh-workspace'
import type { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import { storageKey } from '@deepseek-ai/dsh-evolution-memory'
import { conceptOverlap, countConcepts, scoreCandidate } from './signals.ts'
import {
  decidePromotion,
  evolveNarratives,
  mergeProvenance,
  narrativeId,
} from './narrative.ts'
import type { QualifiedCandidate } from './narrative.ts'
import { dreamsDomainSpec } from './spec.ts'
import type {
  DreamCandidate,
  DreamLedgerEntry,
  DreamNarrative,
  DreamPhase,
  DreamPhaseReport,
  DreamPromotion,
  DreamProvenance,
  DreamRefusalReason,
  DreamReport,
  DreamRollbackReport,
  DreamsRecord,
} from './types.ts'

export type * from './types.ts'
export { DREAM_WEIGHTS, FREQUENCY_HALF_POINT, conceptOverlap, countConcepts, scoreCandidate } from './signals.ts'
export type { CandidateEvidence, DreamSignals } from './signals.ts'
export { narrativeId } from './narrative.ts'
export { dreamsDomainSpec, dreamsRecordSchema } from './spec.ts'

/** Heartbeat task name carrying the automatic cycle. */
export const DREAMING_TASK_NAME = 'dreaming'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Three-phase dreaming consolidation over recorded failures. */
    evolutionDreaming: EvolutionDreaming
  }
}

/** Deployment choices for the dreaming cycle. */
export interface Config {
  /** Composite a candidate must reach to be promoted. */
  minScore?: number
  /** Sighting count a candidate must reach to be promoted. */
  minRecallCount?: number
  /** Distinct sessions a candidate must appear in to be promoted. */
  minUniqueQueries?: number
  /** Days a promotion stays durable without being seen again. */
  staleAfterDays?: number
  /** Share of `maxPromotions` above which the decay rule runs. */
  capacityTriggerRatio?: number
  /** Hours between two automatic cycles. */
  intervalHours?: number
  /** Narratives retained per scope. */
  maxNarratives?: number
  /** Promotions retained per scope. */
  maxPromotions?: number
  /** Candidates one cycle scores. */
  maxCandidates?: number
  /** Concept overlap at or above which a candidate restates a narrative the scope holds. */
  mergeOverlap?: number
  /** Lower overlap at or above which a candidate corrects the narrative it shares a tool with. */
  supersedeOverlap?: number
  /** Statements one narrative retains as the restatements it absorbed. */
  maxRestatements?: number
  /** Promotion passes retained per scope for rollback. */
  maxLedgerEntries?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  minScore: z.number().min(0).max(1).default(0.65),
  minRecallCount: z.number().step(1).min(1).default(3),
  minUniqueQueries: z.number().step(1).min(1).default(2),
  staleAfterDays: z.number().step(1).min(1).default(30),
  capacityTriggerRatio: z.number().min(0).max(1).default(0.8),
  intervalHours: z.number().step(1).min(1).default(6),
  maxNarratives: z.number().step(1).min(1).default(20),
  maxPromotions: z.number().step(1).min(1).default(200),
  maxCandidates: z.number().step(1).min(1).default(500),
  mergeOverlap: z.number().min(0).max(1).default(0.6),
  supersedeOverlap: z.number().min(0).max(1).default(0.3),
  maxRestatements: z.number().step(1).min(1).default(5),
  maxLedgerEntries: z.number().step(1).min(1).default(10),
})

/** Normalized configuration used by the cycle. */
export interface ResolvedConfig {
  minScore: number
  minRecallCount: number
  minUniqueQueries: number
  staleAfterDays: number
  capacityTriggerRatio: number
  intervalHours: number
  maxNarratives: number
  maxPromotions: number
  maxCandidates: number
  mergeOverlap: number
  supersedeOverlap: number
  maxRestatements: number
  maxLedgerEntries: number
}

/**
 * Apply defaults for the optional fields. A supersede threshold above the merge
 * threshold fails loudly: every related candidate would restate its narrative,
 * and no correction could ever retire one.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const {
    minScore = 0.65,
    minRecallCount = 3,
    minUniqueQueries = 2,
    staleAfterDays = 30,
    capacityTriggerRatio = 0.8,
    intervalHours = 6,
    maxNarratives = 20,
    maxPromotions = 200,
    maxCandidates = 500,
    mergeOverlap = 0.6,
    supersedeOverlap = 0.3,
    maxRestatements = 5,
    maxLedgerEntries = 10,
  } = config
  if (supersedeOverlap > mergeOverlap) {
    throw new Error(
      `evolution-dreaming: supersedeOverlap (${supersedeOverlap}) must not exceed mergeOverlap (${mergeOverlap})`,
    )
  }
  return {
    minScore,
    minRecallCount,
    minUniqueQueries,
    staleAfterDays,
    capacityTriggerRatio,
    intervalHours,
    maxNarratives,
    maxPromotions,
    maxCandidates,
    mergeOverlap,
    supersedeOverlap,
    maxRestatements,
    maxLedgerEntries,
  }
}

/**
 * Durable per-scope dreaming. Opens the `evolution_dreams` domain at init,
 * registers the automatic cycle with the heartbeat when one is mounted, and
 * closes the domain through `ctx.effect`.
 */
export class EvolutionDreaming extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, DreamsRecord>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - gates, cadence, and retention bounds.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionDreaming')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain, publish the table handle, and register the automatic cycle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(dreamsDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-dreaming.domainClose')
    this.table = domain.table('records')
    const heartbeat = this.ctx.get('evolutionHeartbeat')
    if (heartbeat === undefined) return
    this.ctx.effect(
      () => heartbeat.register({
        name: DREAMING_TASK_NAME,
        intervalHours: this.resolved.intervalHours,
        run: signal => this.dreamAll(signal),
      }),
      'evolution-dreaming.heartbeatTask',
    )
  }

  /** Read one scope's dreams.
   * @param scopeId - scope identity.
   * @returns a detached copy, or undefined when the scope has never dreamed.
   */
  read(scopeId: EvolutionScopeId): DreamsRecord | undefined {
    const found = this.requireTable().get(storageKey(scopeId))
    return found === undefined ? undefined : structuredClone(found)
  }

  /**
   * The narratives that still answer, newest first. A superseded one keeps its
   * place in the record and its evidence but answers no query, exactly as the
   * claim graph treats a retired claim, so a corrected statement replaces an
   * older one instead of editing it.
   * @param scopeId - scope identity.
   * @returns detached copies of the active promotions.
   */
  promotions(scopeId: EvolutionScopeId): DreamPromotion[] {
    return this.current(scopeId).promotions
      .filter(promotion => promotion.supersededBy === null)
      .map(promotion => structuredClone(promotion))
  }

  /**
   * Read one scope's promotion ledger, newest first, for audit and as the
   * source of the identities {@link rollback} takes.
   * @param scopeId - scope identity.
   * @returns detached copies of the ledger entries.
   */
  ledger(scopeId: EvolutionScopeId): readonly DreamLedgerEntry[] {
    return structuredClone(this.current(scopeId).ledger)
  }

  /**
   * Restore the promotions one ledger entry replaced. The entry holds its own
   * preimage, so nothing can go missing between the write and the rollback: an
   * unknown identity fails before anything is written, and the rollback appends
   * its own entry, which makes it as reversible as the pass it undoes.
   * @param scopeId - scope identity.
   * @param entryId - ledger entry identity, from {@link ledger}.
   * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
   * @returns what the rollback restored and the entry that recorded it.
   */
  async rollback(
    scopeId: EvolutionScopeId,
    entryId: string,
    now: string = new Date().toISOString(),
  ): Promise<DreamRollbackReport> {
    const record = this.current(scopeId)
    const entry = record.ledger.find(candidate => candidate.id === entryId)
    if (entry === undefined) throw new Error(`evolution-dreaming: unknown ledger entry '${entryId}'`)
    const label = `pass '${entryId}'`
    const answering = new Set(record.promotions
      .filter(promotion => promotion.supersededBy === null)
      .map(promotion => promotion.id))
    const restored = entry.before
      .filter(promotion => promotion.supersededBy === null && !answering.has(promotion.id))
      .map(promotion => ({ id: promotion.id, statement: promotion.statement }))
    const reversal: DreamLedgerEntry = {
      id: randomUUID(),
      at: now,
      actor: 'operator',
      action: 'rollback',
      evidence: { promoted: 0, merged: 0, superseded: 0, pruned: 0, rollbackOf: label },
      before: structuredClone(record.promotions),
      after: structuredClone(entry.before),
    }
    await this.write(scopeId, {
      ...record,
      promotions: structuredClone(entry.before),
      ledger: [reversal, ...record.ledger].slice(0, this.resolved.maxLedgerEntries),
      updatedAt: now,
    })
    return { at: now, label, restored, preRollback: reversal.id }
  }

  /**
   * Run one phase for one scope.
   * @param phase - which phase to run.
   * @param scopeId - scope identity.
   * @param sessionIds - sessions whose recorded failures the cycle scans.
   * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
   * @returns what the phase did.
   */
  async run(
    phase: DreamPhase,
    scopeId: EvolutionScopeId,
    sessionIds: readonly string[],
    now: string = new Date().toISOString(),
  ): Promise<DreamPhaseReport> {
    const staged = phase === 'light' ? this.stage(scopeId, sessionIds) : this.lastStaged(scopeId)
    if (phase === 'light') {
      return this.phaseReport(phase, scopeId, staged, {})
    }
    if (phase === 'rem') return await this.summarize(scopeId, staged, now)
    return await this.promote(scopeId, staged, now)
  }

  /**
   * Run the complete cycle: light, then REM, then deep.
   * @param scopeId - scope identity.
   * @param sessionIds - sessions whose recorded failures the cycle scans.
   * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
   * @returns what each phase did.
   */
  async dream(
    scopeId: EvolutionScopeId,
    sessionIds: readonly string[],
    now: string = new Date().toISOString(),
  ): Promise<DreamReport> {
    const light = await this.run('light', scopeId, sessionIds, now)
    const rem = await this.run('rem', scopeId, sessionIds, now)
    const deep = await this.run('deep', scopeId, sessionIds, now)
    return {
      scopeId,
      scanned: light.scanned,
      staged: light.staged,
      promoted: deep.promoted,
      merged: deep.merged,
      superseded: deep.superseded,
      pruned: deep.pruned,
      refused: deep.refused,
      phases: [light, rem, deep],
    }
  }

  /** One phase's report, with the movement counts the phase did not produce left at zero. */
  private phaseReport(
    phase: DreamPhase,
    scopeId: EvolutionScopeId,
    staged: readonly DreamCandidate[],
    movement: Partial<Pick<DreamPhaseReport, 'promoted' | 'merged' | 'superseded' | 'pruned' | 'refused'>>,
  ): DreamPhaseReport {
    return {
      phase,
      scopeId,
      scanned: staged.length,
      staged: staged.length,
      promoted: 0,
      merged: 0,
      superseded: 0,
      pruned: 0,
      refused: [],
      ...movement,
    }
  }

  /**
   * Dream every workspace the registry knows. A missing registry makes this a
   * no-op rather than a failure: the automatic cycle is optional infrastructure,
   * while an explicit `run` or `dream` call always works.
   * @param signal - aborts between workspaces at plugin teardown.
   */
  async dreamAll(signal?: AbortSignal): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry')
    const profile = this.ctx.get('evolutionMemory') === undefined ? undefined : 'workspace'
    if (registry === undefined || profile === undefined) return
    for (const workspace of registry.list()) {
      if (signal?.aborted === true) return
      await this.dream(
        // The scope namespace matches what the memory-context plugin composes.
        `${profile}:${String(workspace.id)}` as EvolutionScopeId,
        workspace.sessionIds.map(id => String(id)),
      )
    }
  }

  /**
   * Light phase: gather and deduplicate the scope's recorded failures and its
   * episodic notes. Either source may be absent; an episodic note restating a
   * recorded failure folds into the same candidate, so raw session material
   * reaches the REM phase through the same consolidation path.
   */
  private stage(scopeId: EvolutionScopeId, sessionIds: readonly string[]): DreamCandidate[] {
    const byId = new Map<string, DreamCandidate>()
    const add = (
      statement: string,
      tool: string | null,
      count: number,
      sessions: number,
      firstAt: string,
      lastAt: string,
      provenance: DreamProvenance,
    ): void => {
      const id = narrativeId(statement)
      if (id.length === 0) return
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, { id, statement, tool, count, sessions, firstAt, lastAt, provenance })
        return
      }
      byId.set(id, {
        ...existing,
        count: existing.count + count,
        sessions: Math.max(existing.sessions, sessions),
        firstAt: existing.firstAt < firstAt ? existing.firstAt : firstAt,
        lastAt: existing.lastAt > lastAt ? existing.lastAt : lastAt,
        provenance: mergeProvenance(existing.provenance, provenance),
      })
    }
    const feedback = this.ctx.get('evolutionFeedback')
    if (feedback !== undefined) {
      for (const entry of feedback.summary(sessionIds, this.resolved.maxCandidates)) {
        add(entry.message, entry.tool, entry.count, entry.sessions, entry.firstAt, entry.lastAt, 'attributed')
      }
    }
    // Episodic notes re-stage while retention keeps them: the deep phase's
    // gate refuses a candidate resting only on notes, exactly as it refuses a
    // failure the feedback seam reported once. One note is one sighting;
    // sightings on distinct days are the independent contexts the deep phase
    // gates on, so a note repeated across days can promote only once a recorded
    // failure restates it, and until then it re-scores with decayed recency
    // rather than being tracked as consumed.
    const sightings = new Map<string, { statement: string; count: number; days: Set<string>; firstAt: string; lastAt: string }>()
    for (const note of this.ctx.get('evolutionMemory')?.read(scopeId)?.episodic ?? []) {
      const id = narrativeId(note.text)
      if (id.length === 0) continue
      const held = sightings.get(id)
      if (held === undefined) {
        sightings.set(id, {
          statement: note.text,
          count: 1,
          days: new Set([note.day]),
          firstAt: note.addedAt,
          lastAt: note.addedAt,
        })
        continue
      }
      held.count += 1
      held.days.add(note.day)
      if (note.addedAt < held.firstAt) {
        held.firstAt = note.addedAt
        held.statement = note.text
      }
      if (note.addedAt > held.lastAt) held.lastAt = note.addedAt
    }
    for (const seen of sightings.values()) {
      add(seen.statement, null, seen.count, seen.days.size, seen.firstAt, seen.lastAt, 'unattributed')
    }
    const staged = [...byId.values()]
    this.stageCache.set(storageKey(scopeId), staged)
    return staged
  }

  /** REM phase: derive the themes of the staged candidates and record them. */
  private async summarize(
    scopeId: EvolutionScopeId,
    staged: readonly DreamCandidate[],
    now: string,
  ): Promise<DreamPhaseReport> {
    const themes = new Map<string, { candidates: number; bestScore: number }>()
    for (const candidate of staged) {
      const key = candidate.tool ?? candidate.id
      const score = this.score(candidate, scopeId, now).score
      const held = themes.get(key) ?? { candidates: 0, bestScore: 0 }
      themes.set(key, { candidates: held.candidates + 1, bestScore: Math.max(held.bestScore, score) })
    }
    const narrative: DreamNarrative = {
      at: now,
      scanned: staged.length,
      staged: staged.length,
      themes: [...themes.entries()]
        .map(([key, held]) => ({ key, ...held }))
        .sort((left, right) => right.bestScore - left.bestScore || (left.key < right.key ? -1 : 1)),
      promoted: 0,
      pruned: 0,
    }
    const record = this.current(scopeId)
    await this.write(scopeId, {
      ...record,
      narratives: [narrative, ...record.narratives].slice(0, this.resolved.maxNarratives),
      updatedAt: now,
    })
    return this.phaseReport('rem', scopeId, staged, {})
  }

  /** Deep phase: score, gate, promote, relate, and decay. */
  private async promote(
    scopeId: EvolutionScopeId,
    staged: readonly DreamCandidate[],
    now: string,
  ): Promise<DreamPhaseReport> {
    const record = this.current(scopeId)
    const refused = new Map<DreamRefusalReason, number>()
    const qualified: QualifiedCandidate[] = []
    for (const candidate of staged) {
      const { score, signals } = this.score(candidate, scopeId, now)
      const decision = decidePromotion({
        provenance: candidate.provenance,
        score,
        count: candidate.count,
        sessions: candidate.sessions,
      }, this.resolved)
      if (!decision.promote) {
        refused.set(decision.reason, (refused.get(decision.reason) ?? 0) + 1)
        continue
      }
      qualified.push({ candidate, score, signals })
    }
    const outcome = evolveNarratives(record.promotions, qualified, this.resolved, now)
    // The cycle prunes stale promotions on every pass, and the capacity ratio
    // additionally trims the survivors to the hard bound when it is crossed.
    const staleBefore = Date.parse(now) - this.resolved.staleAfterDays * 86_400_000
    const fresh = outcome.promotions.filter(promotion => Date.parse(promotion.promotedAt) >= staleBefore)
    const overCapacity = outcome.promotions.length > this.resolved.maxPromotions * this.resolved.capacityTriggerRatio
    const kept = overCapacity ? fresh.slice(0, this.resolved.maxPromotions) : fresh
    const pruned = outcome.promotions.length - kept.length
    if (outcome.promoted + outcome.merged + outcome.superseded + pruned > 0) {
      // The preimage is what this pass replaced, so a rollback restores the
      // narratives the pass folded, retired, or dropped.
      const entry: DreamLedgerEntry = {
        id: randomUUID(),
        at: now,
        actor: 'dreaming',
        action: 'promote',
        evidence: {
          promoted: outcome.promoted,
          merged: outcome.merged,
          superseded: outcome.superseded,
          pruned,
          rollbackOf: null,
        },
        before: structuredClone(record.promotions),
        after: structuredClone(kept),
      }
      await this.write(scopeId, {
        ...record,
        promotions: kept,
        ledger: [entry, ...record.ledger].slice(0, this.resolved.maxLedgerEntries),
        updatedAt: now,
      })
    }
    return this.phaseReport('deep', scopeId, staged, {
      promoted: outcome.promoted,
      merged: outcome.merged,
      superseded: outcome.superseded,
      pruned,
      refused: [...refused.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => left.reason.localeCompare(right.reason)),
    })
  }

  /** Score one candidate against the scope's existing memory. */
  private score(candidate: DreamCandidate, scopeId: EvolutionScopeId, now: string) {
    const memory = this.ctx.get('evolutionMemory')?.read(scopeId)
    // The lessons family is an artifact array, so the words the relevance
    // signal compares against are the statements, not the array's shell.
    const known = memory === undefined
      ? ''
      : [
        memory.instructions,
        ...memory.agentLessons.map(artifact => artifact.statement),
        memory.userProfile,
      ].join('\n')
    return scoreCandidate({
      relevance: conceptOverlap(candidate.statement, known),
      count: candidate.count,
      sessions: candidate.sessions,
      firstAt: candidate.firstAt,
      lastAt: candidate.lastAt,
      concepts: countConcepts(candidate.statement),
      now: Date.parse(now),
    })
  }

  /** Candidates the last light phase staged for this scope. */
  private lastStaged(scopeId: EvolutionScopeId): DreamCandidate[] {
    return this.stageCache.get(storageKey(scopeId)) ?? this.stage(scopeId, [])
  }

  /** The scope's record, or an empty one. */
  private current(scopeId: EvolutionScopeId): DreamsRecord {
    return this.requireTable().get(storageKey(scopeId))
      ?? { narratives: [], promotions: [], ledger: [], updatedAt: new Date(0).toISOString() }
  }

  /** Persist one scope's record, inserting the first one and updating after. */
  private async write(scopeId: EvolutionScopeId, record: DreamsRecord): Promise<void> {
    const table = this.requireTable()
    const key = storageKey(scopeId)
    if (table.get(key) === undefined) {
      await table.put(key, structuredClone(record))
      return
    }
    await table.update(key, () => structuredClone(record))
  }

  private requireTable(): KvTable<string, DreamsRecord> {
    /* v8 ignore next -- callers await service init through the plugin lifecycle. */
    if (this.table === undefined) throw new Error('evolution-dreaming: the domain is not open')
    return this.table
  }

  /** Candidates staged by the most recent light phase, per scope. */
  private readonly stageCache = new Map<string, DreamCandidate[]>()
}

export default EvolutionDreaming
