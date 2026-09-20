/**
 * Evolution feedback store (`ctx.evolutionFeedback`): failing tool results
 * observed per session, deduplicated into counted observations, and aggregated
 * on demand into the natural-language feedback the learning loop reads.
 *
 * Nothing here calls a model. The plugin observes `session/event` as it is
 * delivered, records only failing `tool/result` events whose tool call it
 * actually saw, and stays silent for every successful call. Observation is
 * bounded twice: one message is clipped to `maxMessageChars`, and one session
 * retains `maxEntries` observations newest-first.
 * @module @deepseek-ai/dsh-evolution-feedback
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { truncateUtf8 } from '@deepseek-ai/dsh-evolution-memory'
import { feedbackDomainSpec } from './spec.ts'
import type {
  FeedbackActionability,
  FeedbackEntry,
  FeedbackEvidenceStatus,
  FeedbackRecord,
  FeedbackSignal,
  FeedbackSummaryEntry,
  ReflectionAnalysis,
  ReflectionRecord,
  StructuredReflection,
} from './types.ts'

export type * from './types.ts'
export { feedbackEntry, feedbackDomainSpec, feedbackRecordSchema, reflectionRecordSchema } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-session failure-observation store. */
    evolutionFeedback: EvolutionFeedback
  }
}

/** Deployment choices for observation recording. */
export interface Config {
  /** Whether failing tool results are observed at all; reads stay available either way. */
  enabled?: boolean
  /** Observations retained per session, newest first. */
  maxEntries?: number
  /** Character budget for one recorded failure message. */
  maxMessageChars?: number
  /** Distinct sessions reporting one failure before it triggers a review. */
  triggerReviewSessions?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxEntries: z.number().step(1).min(1).default(100),
  maxMessageChars: z.number().step(1).min(1).default(500),
  triggerReviewSessions: z.number().step(1).min(1).default(2),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  enabled: boolean
  maxEntries: number
  maxMessageChars: number
  triggerReviewSessions: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { enabled = true, maxEntries = 100, maxMessageChars = 500, triggerReviewSessions = 2 } = config
  return { enabled, maxEntries, maxMessageChars, triggerReviewSessions }
}

/** Decisiveness of a signal for a state transition, highest first. */
const ACTIONABILITY_RANK: Record<FeedbackActionability, number> = {
  observe_only: 1,
  ranking_only: 2,
  trigger_review: 3,
}

/** Strength of the attribution evidence, highest first. */
const EVIDENCE_RANK: Record<FeedbackEvidenceStatus, number> = { actionable_partial: 1, complete: 2 }

/**
 * The identity one aggregated failure merges under: its tool and its message.
 * A failure whose call was never observed keeps the empty prefix, which no
 * named tool produces, so it never merges into an attributed failure.
 * @param tool - failing tool, or null when the call was not observed.
 * @param message - normalized failure message.
 * @returns the merge key.
 */
function mergeKeyOf(tool: string | null, message: string): string {
  return `${tool ?? ''}\u0000${message}`
}

/**
 * Join the visible text of one content-block list. Non-text blocks contribute
 * nothing, so a failing result carrying only an image records an empty
 * message rather than a serialized block.
 * @param content - the failing block's content list.
 * @returns the newline-joined text blocks.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .map(part => (part.type === 'text' ? part.text : ''))
    .filter(text => text.length > 0)
    .join('\n')
}

/**
 * Per-session failure-observation store. Opens the `evolution_feedback` domain
 * at init and closes it through `ctx.effect`.
 */
export class EvolutionFeedback extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, FeedbackRecord>
  private reflections?: KvTable<string, ReflectionRecord>
  private readonly resolved: ResolvedConfig
  /** Tool name per in-flight call, dropped when its result arrives or its turn ends. */
  private readonly pending = new Map<string, string>()
  /** One write chain per session, so observations of one step cannot race. */
  private readonly chains = new Map<string, Promise<void>>()

  /**
   * @param ctx - Host context carrying the storage domain.
   * @param config - observation switch and bounds.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionFeedback')
    this.resolved = resolveConfig(config)
  }

  /**
   * Open the domain and start observing failing tool results.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(feedbackDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-feedback.domainClose')
    this.table = domain.table('records')
    this.reflections = domain.table('reflections')
    if (!this.resolved.enabled) return
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onEvent(session, event)
    })
  }

  /**
   * Read one session's recorded failures.
   * @param sessionId - session identity.
   * @returns a detached copy, newest first, or an empty list when absent.
   */
  entries(sessionId: string): readonly FeedbackEntry[] {
    const record = this.requireTable().get(sessionId)
    return record === undefined ? [] : structuredClone([...record.entries])
  }

  /**
   * Aggregate the given sessions' failures by tool and message, most-observed
   * first. Distinct sessions that reported a failure are counted, so a
   * failure seen once in four sessions outranks four repeats in one.
   * @param sessionIds - sessions to aggregate, in caller order.
   * @param limit - maximum entries returned.
   * @returns the aggregated failures, newest-highest-count first.
   */
  summary(sessionIds: readonly string[], limit: number): FeedbackSummaryEntry[] {
    return this.aggregate(sessionIds).slice(0, limit)
  }

  /**
   * Grade the given sessions' failures by how decisive each is for a state
   * transition, most decisive first. A failure whose own call was never
   * observed carries no attribution, so it only observes; an attributable
   * failure seen in `triggerReviewSessions` distinct sessions triggers a
   * review, and fewer sessions rank without deciding. Grading happens before
   * the limit, so a decisive signal is never truncated away by a count-ranked
   * one.
   * @param sessionIds - sessions to aggregate, in caller order.
   * @param limit - maximum signals returned.
   * @returns the graded signals, decisive first.
   */
  signals(sessionIds: readonly string[], limit: number): FeedbackSignal[] {
    return this.graded(sessionIds).slice(0, limit)
  }

  /**
   * Reflect the given sessions' failures as structured reflections, most
   * decisive first: the ledger-derived half (symptom, violated expectation,
   * observed behavior, confidence) merged with the analyst-supplied half
   * (root cause, corrected strategy, and friends) when one was recorded.
   * Analytic fields stay null until `recordReflection` states them, so a
   * reader never mistakes missing analysis for measured fact.
   * @param sessionIds - sessions to aggregate, in caller order.
   * @param limit - maximum reflections returned.
   * @returns the structured reflections, decisive first.
   */
  reflect(sessionIds: readonly string[], limit: number): StructuredReflection[] {
    // One session is one observed context: a repeated id must not double its
    // counts, and an unknown id reports nothing.
    const distinct = [...new Set(sessionIds)]
    return this.graded(distinct).slice(0, limit).map(signal => {
      const stored = this.requireReflections().get(signal.mergeKey)
      return {
        failureId: signal.mergeKey,
        symptom: signal.message,
        violatedExpectation: signal.tool === null
          ? 'a tool result arrives without an error'
          : `the ${signal.tool} call succeeds`,
        rootCause: stored?.rootCause ?? null,
        contributingFactors: this.reporters(distinct, signal.mergeKey),
        whatWorked: null,
        whatFailed: {
          count: signal.count,
          sessions: signal.sessions,
          firstAt: signal.firstAt,
          lastAt: signal.lastAt,
        },
        correctedStrategy: stored?.correctedStrategy ?? null,
        confidence: signal.evidenceStatus === 'actionable_partial'
          ? 0.25
          : 0.5 + 0.5 * Math.min(1, signal.sessions / this.resolved.triggerReviewSessions),
        reusableWhen: stored?.reusableWhen ?? null,
        antiPattern: stored?.antiPattern ?? null,
        candidateTest: stored?.candidateTest ?? null,
      }
    })
  }

  /**
   * List the sessions that reported one failure, sorted. A repeated session
   * id in the input reports once: one session is one observed context.
   * @param sessionIds - sessions to scan, in caller order.
   * @param mergeKey - tool-and-message identity, as `signals` reports it.
   * @returns the reporting session ids, sorted.
   */
  private reporters(sessionIds: readonly string[], mergeKey: string): string[] {
    const table = this.requireTable()
    const reporters: string[] = []
    for (const sessionId of new Set(sessionIds)) {
      const entries = table.get(sessionId)?.entries ?? []
      if (entries.some(entry => mergeKeyOf(entry.tool, entry.message) === mergeKey)) {
        reporters.push(sessionId)
      }
    }
    return reporters.sort()
  }

  /**
   * Read one failure's recorded analysis.
   * @param mergeKey - tool-and-message identity, as `signals` reports it.
   * @returns the stored analysis, or undefined when none was recorded.
   */
  reflection(mergeKey: string): ReflectionRecord | undefined {
    const stored = this.requireReflections().get(mergeKey)
    return stored === undefined ? undefined : structuredClone(stored)
  }

  /**
   * Record an analyst's reading of one failure, merging the supplied fields
   * over any analysis already stored. Omitted fields keep their stored value,
   * so a partial reading never blanks an earlier one.
   * @param mergeKey - tool-and-message identity, as `signals` reports it.
   * @param analysis - analytic fields to state; every field is optional.
   * @returns the stored record after the merge.
   */
  async recordReflection(mergeKey: string, analysis: Partial<ReflectionAnalysis>): Promise<ReflectionRecord> {
    const now = new Date().toISOString()
    const table = this.requireReflections()
    const previous = table.get(mergeKey)
    const merged: ReflectionRecord = {
      rootCause: analysis.rootCause ?? previous?.rootCause ?? null,
      correctedStrategy: analysis.correctedStrategy ?? previous?.correctedStrategy ?? null,
      reusableWhen: analysis.reusableWhen ?? previous?.reusableWhen ?? null,
      antiPattern: analysis.antiPattern ?? previous?.antiPattern ?? null,
      candidateTest: analysis.candidateTest ?? previous?.candidateTest ?? null,
      updatedAt: now,
    }
    await table.put(mergeKey, merged)
    return structuredClone(merged)
  }

  /**
   * Grade the given sessions' failures by how decisive each is for a state
   * transition, most decisive first. The one grading every read path starts
   * from; callers slice it to their limit.
   * @param sessionIds - sessions to aggregate, in caller order.
   * @returns every graded signal, decisive first.
   */
  private graded(sessionIds: readonly string[]): FeedbackSignal[] {
    const graded = this.aggregate(sessionIds).map((entry): FeedbackSignal => {
      const evidenceStatus: FeedbackEvidenceStatus = entry.tool === null ? 'actionable_partial' : 'complete'
      const actionability: FeedbackActionability = evidenceStatus === 'actionable_partial'
        ? 'observe_only'
        : entry.sessions >= this.resolved.triggerReviewSessions ? 'trigger_review' : 'ranking_only'
      return {
        ...entry,
        actionability,
        evidenceStatus,
        mergeKey: mergeKeyOf(entry.tool, entry.message),
      }
    })
    return graded
      .sort((left, right) => EVIDENCE_RANK[right.evidenceStatus] - EVIDENCE_RANK[left.evidenceStatus]
        || ACTIONABILITY_RANK[right.actionability] - ACTIONABILITY_RANK[left.actionability]
        || right.sessions - left.sessions
        || right.count - left.count
        || Date.parse(right.lastAt) - Date.parse(left.lastAt))
  }

  /**
   * Merge the given sessions' failures by tool and message, most-observed
   * first. The one aggregation both read paths start from.
   * @param sessionIds - sessions to aggregate, in caller order.
   * @returns every aggregated failure, ordered by count then recency.
   */
  private aggregate(sessionIds: readonly string[]): FeedbackSummaryEntry[] {
    const table = this.requireTable()
    const merged = new Map<string, FeedbackSummaryEntry>()
    for (const sessionId of sessionIds) {
      const record = table.get(sessionId)
      if (record === undefined) continue
      for (const entry of record.entries) {
        const key = mergeKeyOf(entry.tool, entry.message)
        const existing = merged.get(key)
        if (existing === undefined) {
          merged.set(key, { ...entry, sessions: 1 })
          continue
        }
        existing.count += entry.count
        existing.sessions += 1
        if (entry.firstAt < existing.firstAt) existing.firstAt = entry.firstAt
        if (entry.lastAt > existing.lastAt) existing.lastAt = entry.lastAt
      }
    }
    return [...merged.values()]
      .sort((left, right) => right.count - left.count || Date.parse(right.lastAt) - Date.parse(left.lastAt))
  }

  /** Route one delivered event into the pending-call table or a recorded failure. */
  private onEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'tool/call') {
      this.pending.set(String(event.data.callId), event.data.name)
      return
    }
    if (event.type === 'turn/end') {
      this.pending.clear()
      return
    }
    if (event.type !== 'tool/result') return
    const block = event.data.message.content[0]
    if (block.isError !== true) return
    const callId = String(event.data.message.source.callId)
    const tool = this.pending.get(callId) ?? null
    this.pending.delete(callId)
    const message = textOf(block.content) || event.data.error?.code || ''
    this.enqueue(String(session.id), tool, message)
  }

  /**
   * Queue one observation behind the same session's other writes. Tool results
   * of one step arrive together, so the read-then-write decision inside
   * {@link record} must not race with itself; the chain drops its map entry
   * once it settles as the tail, so a session that stops failing leaves nothing
   * behind.
   */
  private enqueue(sessionId: string, tool: string | null, message: string): void {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(() => this.record(sessionId, tool, message)).catch((error: unknown) => {
      this.ctx.logger.warn(`evolution feedback could not record a failure: ${String(error)}`)
    })
    this.chains.set(sessionId, next)
    void next.finally(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId)
    })
  }

  /** Merge one observation into its session's record, counting a repeat. */
  private async record(sessionId: string, tool: string | null, message: string): Promise<void> {
    const text = truncateUtf8(message.replace(/\s+/g, ' ').trim(), this.resolved.maxMessageChars)
    const now = new Date().toISOString()
    const entry: FeedbackEntry = { tool, message: text, count: 1, firstAt: now, lastAt: now }
    const table = this.requireTable()
    const maxEntries = this.resolved.maxEntries
    if (table.get(sessionId) === undefined) {
      await table.put(sessionId, { entries: [entry], updatedAt: now })
      return
    }
    await table.update(sessionId, (record) => {
      const at = record.entries.findIndex(candidate => candidate.tool === tool && candidate.message === text)
      if (at === -1) {
        return { entries: [entry, ...record.entries].slice(0, maxEntries), updatedAt: now }
      }
      const seen = record.entries[at] as FeedbackEntry
      const rest = record.entries.filter((_, index) => index !== at)
      return { entries: [{ ...seen, count: seen.count + 1, lastAt: now }, ...rest], updatedAt: now }
    })
  }

  private requireTable(): KvTable<string, FeedbackRecord> {
    if (this.table === undefined) throw new Error('evolution feedback is not started yet')
    return this.table
  }

  private requireReflections(): KvTable<string, ReflectionRecord> {
    if (this.reflections === undefined) throw new Error('evolution feedback is not started yet')
    return this.reflections
  }
}

export default EvolutionFeedback
