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
import type { FeedbackEntry, FeedbackRecord, FeedbackSummaryEntry } from './types.ts'

export type * from './types.ts'
export { feedbackEntry, feedbackDomainSpec, feedbackRecordSchema } from './spec.ts'

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
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxEntries: z.number().step(1).min(1).default(100),
  maxMessageChars: z.number().step(1).min(1).default(500),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  enabled: boolean
  maxEntries: number
  maxMessageChars: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { enabled = true, maxEntries = 100, maxMessageChars = 500 } = config
  return { enabled, maxEntries, maxMessageChars }
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
    const table = this.requireTable()
    const merged = new Map<string, FeedbackSummaryEntry>()
    for (const sessionId of sessionIds) {
      const record = table.get(sessionId)
      if (record === undefined) continue
      for (const entry of record.entries) {
        const key = `${entry.tool ?? ''}\u0000${entry.message}`
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
      .slice(0, limit)
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
}

export default EvolutionFeedback
