/**
 * Retrieval-aware evolution (`ctx.evolutionRetrieval`): the §39 candidate
 * retrieval dimensions recorded as configurations, the sessions that ran under
 * each, and the effectiveness derived by joining those sessions to the graded
 * outcomes the shipped evidence stores already record. A configuration is
 * judged by downstream task success, never by retrieval precision, and nothing
 * here calls a model.
 * @module @deepseek-ai/dsh-evolution-retrieval
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  configurationKey,
  effectivenessRows,
  gradesOf,
  rankConfigurations,
  recommendConfiguration,
} from './retrieval.ts'
import { retrievalDomainSpec } from './spec.ts'
import type {
  RetrievalAttribution,
  RetrievalAttributionInput,
  RetrievalEffectiveness,
  RetrievalRankingEntry,
  RetrievalTaskClass,
  SessionGrade,
  SkillEvidenceEntry,
} from './types.ts'

export type * from './types.ts'
export {
  configurationKey,
  effectivenessRows,
  gradesOf,
  rankConfigurations,
  recommendConfiguration,
  scoreOf,
  updatedEffectiveness,
} from './retrieval.ts'
export { retrievalAttributionRow, retrievalConfigurationRow, retrievalDomainSpec } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Retrieval configurations per session, and the effectiveness measured from task success. */
    evolutionRetrieval: EvolutionRetrieval
  }
}

/**
 * Deployment choices for the recommendation's evidence gate: how much graded
 * evidence one configuration needs on one task class.
 */
export interface Config {
  /**
   * Graded sessions a configuration needs on a task class before it may be
   * recommended. Defaults to 5: one binary grade per session is coarse, and at
   * five the score's confidence factor saturates while its 1-pass/1-fail prior
   * is under a third of the estimate, so the rank reflects the sessions rather
   * than the prior or the sample count.
   */
  minimumSessions?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  minimumSessions: z.number().step(1).min(1).default(5),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  /** Graded sessions a configuration needs before it may be recommended. */
  minimumSessions: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const { minimumSessions = 5 } = config
  return { minimumSessions }
}

/**
 * The slice of `ctx.evolutionSkillTelemetry` this store reads: per-skill
 * session evidence. Declared here rather than imported so the store keeps no
 * hard dependency on the telemetry package — a deployment without one derives
 * its effectiveness from the feedback store alone.
 */
interface TelemetrySeam {
  /**
   * List every skill's usage record.
   * @returns the records, in the store's own order.
   */
  entries(): readonly SkillEvidenceEntry[]
}

/**
 * The slice of `ctx.evolutionFeedback` this store reads: graded failure
 * signals per session.
 */
interface FeedbackSeam {
  /**
   * Grade the given sessions' failures by how decisive each is for a state
   * transition, most decisive first.
   * @param sessionIds - sessions to aggregate.
   * @param limit - maximum signals returned.
   * @returns the graded signals, decisive first.
   */
  signals(sessionIds: readonly string[], limit: number): readonly { readonly evidenceStatus: 'complete' | 'actionable_partial' }[]
}

/**
 * Whether a context value offers the telemetry read this store joins on.
 * Absent and foreign values answer false instead of throwing, so a missing —
 * or older — store degrades to no task-class evidence rather than failing a
 * read.
 * @param value - the value read from `ctx.get('evolutionSkillTelemetry')`.
 * @returns whether the value can list skill usage records.
 */
function isTelemetrySeam(value: unknown): value is TelemetrySeam {
  return typeof Reflect.get(Object(value), 'entries') === 'function'
}

/**
 * Whether a context value offers the feedback read this store joins on.
 * @param value - the value read from `ctx.get('evolutionFeedback')`.
 * @returns whether the value can grade sessions' failures.
 */
function isFeedbackSeam(value: unknown): value is FeedbackSeam {
  return typeof Reflect.get(Object(value), 'signals') === 'function'
}

/**
 * Retrieve configurations learned from the sessions that ran under them. Opens
 * the `evolution_retrieval` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionRetrieval extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, RetrievalAttribution>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - evidence-gate choice.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionRetrieval')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(retrievalDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-retrieval.domainClose')
    this.table = domain.table('attributions')
  }

  /**
   * Record one session under one retrieval configuration. The attribution key
   * is the configuration and the session joined, so recording the same session
   * again — a resumed session, a retried step — upserts the same row and keeps
   * its first instant instead of counting the session twice.
   * @param input - the configuration in force and the session it served.
   * @returns the stored attribution.
   */
  async record(input: RetrievalAttributionInput): Promise<RetrievalAttribution> {
    const configKey = configurationKey(input.configuration)
    const key = `${configKey}\0${input.sessionId}`
    const table = this.requireTable()
    const stored: RetrievalAttribution = {
      configKey,
      configuration: structuredClone(input.configuration),
      sessionId: input.sessionId,
      at: table.get(key)?.at ?? new Date().toISOString(),
    }
    await table.put(key, stored)
    return structuredClone(stored)
  }

  /**
   * List recorded attributions, optionally for one configuration, newest first
   * with session-id ascending tie-break.
   * @param configKey - optional configuration-key filter.
   * @returns the attributions, detached from the store.
   */
  attributions(configKey?: string): readonly RetrievalAttribution[] {
    const rows = [...this.requireTable().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => configKey === undefined || row.configKey === configKey)
    rows.sort((left, right) =>
      right.at.localeCompare(left.at) || left.sessionId.localeCompare(right.sessionId))
    return rows
  }

  /**
   * The derived effectiveness of every configuration, optionally for one task
   * class, in task-class then configuration-key order.
   * @param taskClass - optional task-class filter.
   * @returns the effectiveness rows, detached from the store.
   */
  effectiveness(taskClass?: RetrievalTaskClass): readonly RetrievalEffectiveness[] {
    const rows = effectivenessRows(this.attributions(), this.grades())
    return taskClass === undefined ? rows : rows.filter(row => row.taskClass === taskClass)
  }

  /**
   * The configuration to run for one task class: the best-ranked configuration
   * with at least `minimumSessions` graded sessions, or undefined while no
   * configuration has that much evidence.
   * @param taskClass - the task class to recommend for.
   * @returns the recommended configuration, or undefined.
   */
  recommend(taskClass: RetrievalTaskClass): RetrievalRankingEntry | undefined {
    return recommendConfiguration(
      rankConfigurations(this.effectiveness(taskClass), taskClass, this.resolved.minimumSessions),
      this.resolved.minimumSessions,
    )
  }

  /**
   * Grade every attributed session from the evidence the mounted stores already
   * recorded: the skill-telemetry store names the task class a session served
   * and its graded outcome, and the feedback store fails a session on the
   * classes it loaded when a tool call in it failed. A session neither store
   * graded contributes nothing.
   * @returns the grades, in session then skill order.
   */
  private grades(): readonly SessionGrade[] {
    const sessions = [...new Set([...this.requireTable().entries()].map(([, row]) => row.sessionId))]
    const telemetry: unknown = this.ctx.get('evolutionSkillTelemetry')
    const feedback: unknown = this.ctx.get('evolutionFeedback')
    const failed = new Set<string>()
    if (isFeedbackSeam(feedback)) {
      for (const sessionId of sessions) {
        if (feedback.signals([sessionId], 1)[0]?.evidenceStatus === 'complete') failed.add(sessionId)
      }
    }
    return gradesOf(sessions, isTelemetrySeam(telemetry) ? telemetry.entries() : [], failed)
  }

  private requireTable(): KvTable<string, RetrievalAttribution> {
    if (this.table === undefined) throw new Error('evolution retrieval store is not started yet')
    return this.table
  }
}

export default EvolutionRetrieval
