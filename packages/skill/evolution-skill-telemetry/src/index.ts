/**
 * Evolution skill telemetry (`ctx.evolutionSkillTelemetry`): per-skill
 * use/view/patch counters with creation provenance, pinning, and lifecycle
 * state over the `evolution_skill_usage` domain. Bundled and hub skills are
 * excluded from every write.
 *
 * Reads are synchronous from the domain's validated memory. Marks seed the
 * record on first touch and resolve without writing when nothing changes.
 * Stored objects never leak by reference.
 * @module @deepseek-ai/dsh-evolution-skill-telemetry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-skill'
import { skillUsageDomainSpec } from './spec.ts'
import { skillUtility } from './utility.ts'
import type { SkillUtility } from './utility.ts'
import type {
  ConsolidationCostRow,
  SkillCreationEvidence,
  SkillLifecycleState,
  SkillTrustFailure,
  SkillUsageRecord,
  SkillVersion,
} from './types.ts'

export type {
  ConsolidationCostRow,
  RepeatedOutput,
  SkillCreationEvidence,
  SkillLifecycleState,
  SkillSessionOutcome,
  SkillTrustFailure,
  SkillTrustState,
  SkillUsageRecord,
  SkillVersion,
} from './types.ts'
export { skillUtility } from './utility.ts'
export type { SkillUtility } from './utility.ts'
export { skillUsageDomainSpec, skillVersionRow } from './spec.ts'

/** Produced outputs of one path needed before skill creation counts as warranted. */
export const SKILL_CREATION_OUTPUT_THRESHOLD = 3

/**
 * Count produced outputs as skill-creation evidence. Two outputs are similar
 * when their normalized path matches — case-folded, with `\` and `/` treated
 * alike and trailing separators ignored — so repeated rewrites of one artifact
 * count, while file content is never read or quoted. Reaching
 * {@link SKILL_CREATION_OUTPUT_THRESHOLD} similar outputs is the counted
 * trigger for proposing a skill; no vendor-reported repetition number feeds it.
 * @param paths - produced-file paths in observation order.
 * @returns the repeated paths plus whether any reached the threshold.
 */
export function skillCreationEvidence(paths: readonly string[]): SkillCreationEvidence {
  const groups = new Map<string, { path: string; count: number }>()
  for (const path of paths) {
    const key = normalizeOutputPath(path)
    const found = groups.get(key)
    if (found === undefined) groups.set(key, { path, count: 1 })
    else found.count += 1
  }
  const repeated = [...groups.values()]
    .filter(entry => entry.count >= SKILL_CREATION_OUTPUT_THRESHOLD)
    .sort((left, right) => right.count - left.count)
  return { repeated, fires: repeated.length > 0 }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-skill usage and curation-state owner. */
    evolutionSkillTelemetry: EvolutionSkillTelemetry
  }
}

/**
 * Report whether a skill source is excluded from telemetry and managed
 * writes. Bundled skills ship with the product and hub skills arrive from
 * sharing; neither is locally curated.
 * @param source - discovery source from the skill catalog.
 * @returns whether writes for this source must be skipped.
 */
export function isExcludedSkillSource(source: string): boolean {
  return source === 'bundled' || source.startsWith('hub')
}

/**
 * Normalize one produced path the way {@link skillCreationEvidence} groups
 * it: case-folded, with `\` and `/` treated alike and trailing separators
 * ignored. One function defines the shape so the evidence counter and the
 * proposal merge key can never drift apart.
 * @param path - produced-file path in observation order.
 * @returns the grouping key.
 */
function normalizeOutputPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Build the candidate merge key for one skill proposal from the produced
 * paths its evidence fired on. The same outputs always produce the same key
 * regardless of observation order, so re-staging the proposal while it is
 * pending bumps its recurrence instead of duplicating it.
 * @param paths - produced-file paths the evidence fired on.
 * @returns the merge key to stage the proposal under.
 */
export function skillProposalMergeKey(paths: readonly string[]): string {
  if (paths.length === 0) throw new Error('evolution skill telemetry needs at least one path for a proposal merge key')
  return `skill-create:${[...paths].map(normalizeOutputPath).sort().join('\n')}`
}

/** Deployment choices for the telemetry store. */
export interface Config {
  /** Sessions retained per skill for failure correlation, newest first. */
  maxSessionIds?: number
  /** Independently observed successes that promote a provisional skill to trusted. */
  trustPromotionSessions?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  maxSessionIds: z.number().step(1).min(1).default(20),
  trustPromotionSessions: z.number().step(1).min(1).default(2),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  maxSessionIds: number
  trustPromotionSessions: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { maxSessionIds = 20, trustPromotionSessions = 2 } = config
  return { maxSessionIds, trustPromotionSessions }
}

function freshRecord(): SkillUsageRecord {
  return {
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    lastUsedAt: null,
    sessionIds: [],
    sessionOutcomes: [],
    lastViewedAt: null,
    lastPatchedAt: null,
    createdAt: new Date().toISOString(),
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
  }
}

/** Version-table key separator: one NUL, so no skill-name prefix collides. */
const VERSION_KEY_SEPARATOR = String.fromCharCode(0)

/**
 * Invalidate the trust evidence of a record whose artifact changed. The skill
 * returns to provisional until independent observations re-earn it, and only
 * sessions newer than the newest one seen here count toward that.
 * @param record - the record being changed.
 * @returns the record with trust reset.
 */
function resetTrust(record: SkillUsageRecord): SkillUsageRecord {
  return {
    ...record,
    trust: 'provisional',
    trustObservedSessions: [],
    trustAnchorSessionId: record.sessionIds[0] ?? null,
  }
}

/**
 * Durable per-skill telemetry store. Opens the `evolution_skill_usage`
 * domain at init and closes it through `ctx.effect`. A passive
 * `tools/post-execute` observer counts successful `skill`-tool loads as
 * uses; views, patches, provenance, pins, and states arrive through the
 * explicit marks below.
 */
export class EvolutionSkillTelemetry extends Service {
  static inject = ['storageDomain', 'skills']

  private table?: KvTable<string, SkillUsageRecord>
  private versionTable?: KvTable<string, SkillVersion>
  private readonly resolved: ResolvedConfig
  private consolidationCostRow?: ConsolidationCostRow

  /**
   * @param ctx - Host context carrying the storage domain and skill registry.
   * @param config - correlation bound for the per-skill session list.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionSkillTelemetry')
    this.resolved = resolveConfig(config)
    ctx.on('tools/post-execute', async (
      exec: ToolExecution,
      result: ToolExecutionResult,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      const decision = await next()
      if (exec.name === 'skill') {
        const name = (exec.arguments as { name?: unknown }).name
        if (typeof name === 'string') {
          try {
            if (result.isError) await this.markFailed(name)
            else await this.markUsed(name, undefined, exec.agent?.session.id)
          } catch (error) {
            this.ctx.logger.warn(`evolution skill telemetry use recording failed for '${name}': ${String(error)}`)
          }
        }
      }
      return decision
    })
  }

  /** Open the domain and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(skillUsageDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-skill-telemetry.domainClose')
    this.table = domain.table('records')
    this.versionTable = domain.table('versions')
  }

  /**
   * Read one skill's record.
   * @param name - skill name.
   * @returns a detached copy, or undefined when never touched.
   */
  read(name: string): SkillUsageRecord | undefined {
    const found = this.requireTable().get(name)
    return found === undefined ? undefined : structuredClone(found)
  }

  /**
   * List every tracked skill with its record.
   * @returns name/record pairs with detached copies.
   */
  entries(): { name: string; usage: SkillUsageRecord }[] {
    return [...this.requireTable().entries()].map(([name, record]) => ({ name, usage: structuredClone(record) }))
  }

  /**
   * Count one successful model load. Bundled and hub skills resolve to no
   * record: the observer still delegates, only the write is skipped.
   * @param name - skill name.
   * @param source - catalog source when the caller already resolved it.
   * @param sessionId - loading session, recorded so a later pass can pull the
   *   failures observed while this skill was in play. Omitted by callers with
   *   no session, which leaves the recorded list untouched.
   * @returns the stored record, or undefined for excluded sources.
   */
  async markUsed(name: string, source?: string, sessionId?: string): Promise<SkillUsageRecord | undefined> {
    if (isExcludedSkillSource(source ?? await this.lookupSource(name))) return undefined
    const now = new Date().toISOString()
    return this.write(name, record => ({
      ...record,
      useCount: record.useCount + 1,
      lastOutcome: 'ok',
      lastUsedAt: now,
      sessionIds: sessionId === undefined
        ? record.sessionIds
        : [sessionId, ...record.sessionIds.filter(id => id !== sessionId)].slice(0, this.resolved.maxSessionIds),
    }))
  }

  /**
   * Count one failed `skill`-tool load. Successful loads arrive through
   * {@link markUsed}; this is the failure half, called by the same
   * `tools/post-execute` observer. Exclusion matches {@link markUsed}.
   * @param name - skill name.
   * @param source - catalog source when the caller already resolved it.
   * @returns the stored record, or undefined for excluded sources.
   */
  async markFailed(name: string, source?: string): Promise<SkillUsageRecord | undefined> {
    if (isExcludedSkillSource(source ?? await this.lookupSource(name))) return undefined
    return this.write(name, record => ({
      ...record,
      failureCount: (record.failureCount ?? 0) + 1,
      lastOutcome: 'failed',
    }))
  }

  /**
   * Count one human view. Exclusion matches {@link markUsed}.
   * @param name - skill name.
   * @param source - catalog source when the caller already resolved it.
   * @returns the stored record, or undefined for excluded sources.
   */
  async markViewed(name: string, source?: string): Promise<SkillUsageRecord | undefined> {
    if (isExcludedSkillSource(source ?? await this.lookupSource(name))) return undefined
    const now = new Date().toISOString()
    return this.write(name, record => ({ ...record, viewCount: record.viewCount + 1, lastViewedAt: now }))
  }

  /**
   * Count one skill-management mutation. Exclusion matches {@link markUsed}.
   * The mutation may have changed the body, so the per-session outcome
   * evidence clears with it: those outcomes describe the artifact that just
   * changed, and the utility reading starts over rather than crediting the new
   * body with the old body's results.
   * @param name - skill name.
   * @param source - catalog source when the caller already resolved it.
   * @returns the stored record, or undefined for excluded sources.
   */
  async markPatched(name: string, source?: string): Promise<SkillUsageRecord | undefined> {
    if (isExcludedSkillSource(source ?? await this.lookupSource(name))) return undefined
    const now = new Date().toISOString()
    return this.write(name, record => ({
      ...resetTrust(record),
      patchCount: record.patchCount + 1,
      lastPatchedAt: now,
      sessionOutcomes: [],
    }))
  }

  /**
   * Record model authorship of a skill body. The model wrote this skill
   * through `skill_manage`, so its standing is provisional until evidence or
   * `/curator adopt` vouches for it. Resolves without writing when the record
   * already carries both facts.
   * @param name - skill name.
   * @returns the stored record.
   */
  async markAgentCreated(name: string): Promise<SkillUsageRecord> {
    const current = this.requireTable().get(name)
    if (current !== undefined && current.createdBy === 'agent' && current.trust === 'provisional') {
      return structuredClone(current)
    }
    return this.write(name, record => ({ ...resetTrust(record), createdBy: 'agent' }))
  }

  /**
   * Adopt one model-authored skill into user-directed standing. Only records
   * carrying model authorship move; everything else rejects, and clocks never
   * reset.
   * @param name - skill name.
   * @returns the stored record with user-directed provenance.
   */
  async markAdopted(name: string): Promise<SkillUsageRecord> {
    const current = this.requireTable().get(name)
    if (current === undefined) throw new Error(`evolution skill telemetry has no record for '${name}'`)
    if (current.createdBy !== 'agent') {
      throw new Error(`evolution skill telemetry cannot adopt '${name}' without model authorship`)
    }
    return this.write(name, record => ({ ...record, createdBy: 'foreground' }))
  }

  /**
   * Record one trust observation for a skill. A failure with attribution
   * demotes the skill and restamps the anchor; a success counts only when its
   * session is newer than that anchor and has not been counted yet, so
   * evidence gathered before a fix cannot promote the skill again. Either way
   * the session's outcome is recorded for §40's utility reading. Excluded
   * sources resolve to no record, and an observation that changes nothing
   * writes nothing.
   * @param name - skill name.
   * @param outcome - the observed outcome.
   * @param sessionId - the session that loaded this skill.
   * @param failure - attribution evidence, used only for `'failure'`.
   * @returns the stored record, or undefined for excluded sources.
   */
  async recordTrustObservation(
    name: string,
    outcome: 'success' | 'failure',
    sessionId: string,
    failure?: SkillTrustFailure,
  ): Promise<SkillUsageRecord | undefined> {
    if (isExcludedSkillSource(await this.lookupSource(name))) return undefined
    if (outcome === 'failure') {
      return this.write(name, record => this.withOutcome({
        ...resetTrust(record),
        trustFailures: record.trustFailures + 1,
        lastTrustFailure: failure ?? record.lastTrustFailure,
      }, sessionId, 'failed'))
    }
    const current = this.requireTable().get(name)
    if (current !== undefined) {
      const observed = this.observed(current, sessionId)
      if (observed === current) return structuredClone(current)
    }
    return this.write(name, record => this.observed(record, sessionId))
  }

  /**
   * Read one skill's utility: uses, assisted and successful tasks, the
   * library-relative gain, and the recorded cost per success. The baseline arm
   * is the other tracked skills' pooled outcomes, because this harness records
   * no skill-free run; see {@link skillUtility} for exactly what the gain does
   * and does not measure.
   * @param name - skill name.
   * @returns the derived reading, or undefined when the skill has no record.
   */
  utility(name: string): SkillUtility | undefined {
    const record = this.requireTable().get(name)
    if (record === undefined) return undefined
    const peers = [...this.requireTable().entries()]
      .filter(([other]) => other !== name)
      .map(([, peer]) => peer)
    return skillUtility(record, peers)
  }

  /**
   * Record a new revision of the SKILL.md body. The store hashes the content
   * itself, so one place defines the shape of `contentSha`; the same bytes
   * again is a no-op, and a real change resets trust and clears the outcome
   * evidence like any other edit.
   * @param name - skill name.
   * @param content - the exact bytes just written to SKILL.md.
   * @returns the stored record, or undefined for excluded sources.
   */
  async markRevised(name: string, content: string): Promise<SkillUsageRecord | undefined> {
    if (isExcludedSkillSource(await this.lookupSource(name))) return undefined
    const contentSha = createHash('sha256').update(content).digest('hex')
    const current = this.requireTable().get(name)
    if (current !== undefined && current.contentSha === contentSha) return structuredClone(current)
    const next = await this.write(name, record => ({
      ...resetTrust(record),
      revision: record.revision + 1,
      parentRevisionSha: record.contentSha,
      contentSha,
      sessionOutcomes: [],
    }))
    await this.appendVersion(name, next.revision, contentSha, next.parentRevisionSha)
    return next
  }

  /**
   * List one skill's committed body revisions, oldest first: the durable
   * artifact registry answering lineage without re-reading files. Excluded
   * sources have no rows, and an absent record reads as an empty list.
   * @param name - skill name.
   * @returns the detached revision history, oldest first.
   */
  versions(name: string): readonly SkillVersion[] {
    const prefix = `${name}${VERSION_KEY_SEPARATOR}`
    return [...this.requireVersionTable().entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => structuredClone(row))
      .sort((left, right) => left.revision - right.revision)
  }

  /**
   * Forget one skill's record and its version history entirely. Purge calls
   * this after removing the skill directory; absent names resolve without
   * writing.
   * @param name - skill name.
   * @returns whether a record was removed.
   */
  async drop(name: string): Promise<boolean> {
    const table = this.requireVersionTable()
    const prefix = `${name}${VERSION_KEY_SEPARATOR}`
    for (const key of [...table.keys()]) {
      if (key.startsWith(prefix)) await table.delete(key)
    }
    return this.requireTable().delete(name)
  }

  /**
   * Apply one success observation, or return the record unchanged when the
   * session cannot count toward promotion. The session's outcome is recorded
   * either way, so a session that cannot promote still counts for utility.
   * @param record - the record being observed.
   * @param sessionId - the session that loaded this skill.
   * @returns the record after the observation.
   */
  private observed(record: SkillUsageRecord, sessionId: string): SkillUsageRecord {
    const observed = this.withOutcome(record, sessionId, 'ok')
    const anchorAt = observed.trustAnchorSessionId === null
      ? -1
      : observed.sessionIds.indexOf(observed.trustAnchorSessionId)
    const at = observed.sessionIds.indexOf(sessionId)
    if (anchorAt !== -1 && (at === -1 || at >= anchorAt)) return observed
    if (observed.trustObservedSessions.includes(sessionId)) return observed
    const trusted = [sessionId, ...observed.trustObservedSessions].slice(0, this.resolved.maxSessionIds)
    return {
      ...observed,
      trustObservedSessions: trusted,
      trust: trusted.length >= this.resolved.trustPromotionSessions ? 'trusted' : observed.trust,
    }
  }

  /**
   * Record one session's graded outcome, newest first and deduplicated by
   * session. Recording the outcome a session already carries is a no-op, so a
   * repeated pass neither reorders the list nor writes.
   * @param record - the record being observed.
   * @param sessionId - the session the outcome belongs to.
   * @param outcome - the graded outcome.
   * @returns the record carrying the outcome.
   */
  private withOutcome(
    record: SkillUsageRecord,
    sessionId: string,
    outcome: 'ok' | 'failed',
  ): SkillUsageRecord {
    if (record.sessionOutcomes.some(entry => entry.sessionId === sessionId && entry.outcome === outcome)) return record
    const kept = record.sessionOutcomes.filter(entry => entry.sessionId !== sessionId)
    return {
      ...record,
      sessionOutcomes: [{ sessionId, outcome }, ...kept].slice(0, this.resolved.maxSessionIds),
    }
  }

  /**
   * Record the cost row of a consolidation-scale run before its fan-out
   * begins, so the curator and command surfaces read one frozen shape of
   * planned spend instead of quoting ad-hoc numbers. Only the latest row is
   * kept; a run that never fans out leaves the previous row untouched.
   * @param row - planned cost facts of the upcoming run.
   */
  recordConsolidationCost(row: ConsolidationCostRow): void {
    this.consolidationCostRow = { ...row }
  }

  /**
   * Read the cost row recorded for the most recent consolidation-scale run.
   * @returns a detached copy of the row, or undefined when no run was recorded.
   */
  readConsolidationCost(): ConsolidationCostRow | undefined {
    return this.consolidationCostRow === undefined ? undefined : { ...this.consolidationCostRow }
  }

  /**
   * Pin or unpin one skill. Pins block automatic transitions and managed
   * deletion; patches stay allowed. Resolves without writing when unchanged.
   * @param name - skill name.
   * @param pinned - new pin state.
   * @returns the stored record.
   */
  async setPinned(name: string, pinned: boolean): Promise<SkillUsageRecord> {
    const current = this.requireTable().get(name)
    if (current !== undefined && current.pinned === pinned) return structuredClone(current)
    return this.write(name, record => ({ ...record, pinned }))
  }

  /**
   * Move one skill through its curation lifecycle. Entering `suspect` or
   * `archived` stamps that state's instant and leaving it clears the instant,
   * so a revival is judged against when the question was raised rather than
   * against any older clean load. The absorption target replaces any previous
   * one, so plain transitions carry none.
   * @param name - skill name.
   * @param state - new lifecycle state.
   * @param absorbedInto - consolidation umbrella, or null when standalone.
   * @returns the stored record.
   */
  async setState(name: string, state: SkillLifecycleState, absorbedInto: string | null = null): Promise<SkillUsageRecord> {
    const now = new Date().toISOString()
    return this.write(name, (record) => {
      const entered = state === 'suspect' && record.state !== 'suspect'
      const left = state !== 'suspect' && record.state === 'suspect'
      const stamped = {
        ...record,
        state,
        absorbedInto,
        suspectAt: entered ? now : left ? null : record.suspectAt,
      }
      if (state === 'archived' && record.state !== 'archived') return { ...stamped, archivedAt: now }
      if (state !== 'archived' && record.state === 'archived') return { ...stamped, archivedAt: null }
      return stamped
    })
  }

  private async lookupSource(name: string): Promise<string> {
    try {
      const found = (await this.ctx.skills.list()).find(skill => skill.name === name)
      return found?.source ?? 'custom'
    } catch {
      // A failing provider must not lose the count: unresolvable skills
      // record under the custom source, which is never excluded.
      return 'custom'
    }
  }

  private async write(name: string, fn: (current: SkillUsageRecord) => SkillUsageRecord): Promise<SkillUsageRecord> {
    const table = this.requireTable()
    if (table.get(name) === undefined) {
      const next = fn(freshRecord())
      await table.put(name, structuredClone(next))
      return structuredClone(next)
    }
    const next = await table.update(name, fn)
    return structuredClone(next)
  }

  private requireTable(): KvTable<string, SkillUsageRecord> {
    if (this.table === undefined) throw new Error('evolution skill telemetry is not started yet')
    return this.table
  }

  private requireVersionTable(): KvTable<string, SkillVersion> {
    if (this.versionTable === undefined) throw new Error('evolution skill telemetry is not started yet')
    return this.versionTable
  }

  /**
   * Append one committed version row to a skill's history.
   * @param name - skill name.
   * @param revision - revision number the row records.
   * @param contentSha - body hash the revision committed.
   * @param parentRevisionSha - body hash the revision replaced, or null.
   */
  private appendVersion(
    name: string,
    revision: number,
    contentSha: string,
    parentRevisionSha: string | null,
  ): Promise<void> {
    return this.requireVersionTable().put(`${name}${VERSION_KEY_SEPARATOR}${revision}`, {
      name,
      revision,
      contentSha,
      parentRevisionSha,
      at: new Date().toISOString(),
    })
  }
}

export default EvolutionSkillTelemetry
