/**
 * Dreaming consolidation (`ctx.evolutionDreaming`): the three-phase cycle that
 * turns repeated observations into durable scope memory.
 *
 * Light gathers failure observations and stages what survives deduplication.
 * REM summarizes the staged candidates as themes and writes the narrative.
 * Deep is the only phase that writes durable memory: it scores every candidate
 * with the six-signal composite, promotes those that clear all three gates, and
 * drops promotions the decay rule has outlived.
 *
 * The cycle consumes the feedback seam and publishes into its own domain, so a
 * scope's promoted dreams are never a second writer on the model-owned lessons
 * document.
 * @module @deepseek-ai/dsh-evolution-dreaming
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-evolution-feedback'
import type {} from '@deepseek-ai/dsh-evolution-heartbeat'
import type {} from '@deepseek-ai/dsh-evolution-memory'
import type {} from '@deepseek-ai/dsh-workspace'
import type { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import { storageKey } from '@deepseek-ai/dsh-evolution-memory'
import { countConcepts, scoreCandidate } from './signals.ts'
import { dreamsDomainSpec } from './spec.ts'
import type {
  DreamCandidate,
  DreamNarrative,
  DreamPhase,
  DreamPhaseReport,
  DreamPromotion,
  DreamReport,
  DreamsRecord,
} from './types.ts'

export type * from './types.ts'
export { DREAM_WEIGHTS, FREQUENCY_HALF_POINT, countConcepts, scoreCandidate } from './signals.ts'
export type { CandidateEvidence, DreamSignals } from './signals.ts'
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
}

/**
 * Apply defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    minScore: config.minScore ?? 0.65,
    minRecallCount: config.minRecallCount ?? 3,
    minUniqueQueries: config.minUniqueQueries ?? 2,
    staleAfterDays: config.staleAfterDays ?? 30,
    capacityTriggerRatio: config.capacityTriggerRatio ?? 0.8,
    intervalHours: config.intervalHours ?? 6,
    maxNarratives: config.maxNarratives ?? 20,
    maxPromotions: config.maxPromotions ?? 200,
    maxCandidates: config.maxCandidates ?? 500,
  }
}

/** Identity and content of one staged candidate. */
function candidateId(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Distinct-concept overlap between a statement and the text a scope already
 * holds. This is the relevance signal without an embedding provider; a
 * deployment that mounts one gets the same number from a semantic comparison
 * instead, and the composite is unchanged either way.
 */
function lexicalRelevance(statement: string, known: string): number {
  const left = new Set(statement.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])
  const right = new Set(known.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / new Set([...left, ...right]).size
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
      return { phase, scopeId, scanned: staged.length, staged: staged.length, promoted: 0, pruned: 0 }
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
      pruned: deep.pruned,
      phases: [light, rem, deep],
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

  /** Light phase: gather and deduplicate the scope's recorded failures. */
  private stage(scopeId: EvolutionScopeId, sessionIds: readonly string[]): DreamCandidate[] {
    const feedback = this.ctx.get('evolutionFeedback')
    if (feedback === undefined) {
      this.stageCache.set(storageKey(scopeId), [])
      return []
    }
    const summary = feedback.summary(sessionIds, this.resolved.maxCandidates)
    const byId = new Map<string, DreamCandidate>()
    for (const entry of summary) {
      const id = candidateId(entry.message)
      if (id.length === 0) continue
      const existing = byId.get(id)
      if (existing !== undefined) {
        byId.set(id, {
          ...existing,
          count: existing.count + entry.count,
          sessions: Math.max(existing.sessions, entry.sessions),
          firstAt: existing.firstAt < entry.firstAt ? existing.firstAt : entry.firstAt,
          lastAt: existing.lastAt > entry.lastAt ? existing.lastAt : entry.lastAt,
        })
        continue
      }
      byId.set(id, {
        id,
        statement: entry.message,
        tool: entry.tool,
        count: entry.count,
        sessions: entry.sessions,
        firstAt: entry.firstAt,
        lastAt: entry.lastAt,
      })
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
    return { phase: 'rem', scopeId, scanned: staged.length, staged: staged.length, promoted: 0, pruned: 0 }
  }

  /** Deep phase: score, gate, promote, and decay. */
  private async promote(
    scopeId: EvolutionScopeId,
    staged: readonly DreamCandidate[],
    now: string,
  ): Promise<DreamPhaseReport> {
    const record = this.current(scopeId)
    const known = new Set(record.promotions.map(promotion => promotion.id))
    const qualified: DreamPromotion[] = []
    for (const candidate of staged) {
      if (known.has(candidate.id)) continue
      const { score, signals } = this.score(candidate, scopeId, now)
      if (score < this.resolved.minScore) continue
      if (candidate.count < this.resolved.minRecallCount) continue
      if (candidate.sessions < this.resolved.minUniqueQueries) continue
      qualified.push({
        id: candidate.id,
        statement: candidate.statement,
        tool: candidate.tool,
        score,
        signals,
        promotedAt: now,
      })
    }
    const merged = [...qualified, ...record.promotions]
    // The cycle prunes stale promotions on every pass, and the capacity ratio
    // additionally trims the survivors to the hard bound when it is crossed.
    const staleBefore = Date.parse(now) - this.resolved.staleAfterDays * 86_400_000
    const fresh = merged.filter(promotion => Date.parse(promotion.promotedAt) >= staleBefore)
    const overCapacity = merged.length > this.resolved.maxPromotions * this.resolved.capacityTriggerRatio
    const kept = overCapacity ? fresh.slice(0, this.resolved.maxPromotions) : fresh
    const pruned = merged.length - kept.length
    if (qualified.length > 0 || pruned > 0) {
      await this.write(scopeId, { ...record, promotions: kept, updatedAt: now })
    }
    return {
      phase: 'deep',
      scopeId,
      scanned: staged.length,
      staged: staged.length,
      promoted: qualified.length,
      pruned,
    }
  }

  /** Score one candidate against the scope's existing memory. */
  private score(candidate: DreamCandidate, scopeId: EvolutionScopeId, now: string) {
    const memory = this.ctx.get('evolutionMemory')?.read(scopeId)
    const known = memory === undefined
      ? ''
      : [memory.instructions, memory.agentLessons, memory.userProfile].join('\n')
    return scoreCandidate({
      relevance: known.length === 0 ? 0 : lexicalRelevance(candidate.statement, known),
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
      ?? { narratives: [], promotions: [], updatedAt: new Date(0).toISOString() }
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
