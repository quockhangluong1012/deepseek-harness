/**
 * Usage ledger (`ctx.usageLedger`): folds every live session's billed LLM
 * attempts into durable per-day and per-day-per-model counters and serves
 * range summaries to the dashboard's Remote face.
 *
 * One billed attempt is one provider usage sample on an
 * `assistant/message` or `assistant/attempt` event — retries count, because
 * each sample represents tokens a previous request already spent. A step's
 * route arrives with its settled message, possibly after earlier attempts,
 * so per-step buckets hold samples until `step/end` and re-attribute
 * unknown-routed samples when the message lands.
 *
 * The ledger is disposable derived data over the durable session logs: the
 * whole state (counters plus per-session fold cursors) persists as one
 * atomic document, every write is fail-soft, and a corrupt document backs
 * aside while the next backfill rebuilds it. Per-session cursors plus
 * child-owned event ranges keep restarts and forks from double-counting.
 * @module @deepseek-ai/dsh-usage-ledger
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  UNKNOWN_ROUTE,
  addSample,
  cacheHitAvg,
  dayKeyUTC7,
  isUsageRange,
  messageRoute,
  moveSample,
  normalizeSample,
  sampleOfAttempt,
  sampleOfMessage,
  summarizeLedger,
  sweepRetention,
  type NormalizedSample,
} from './aggregate.ts'
import { LEDGER_KEY, usageDashboardDomainSpec, type UsageLedgerState } from './spec.ts'
import type { UsageRange, UsageSummary } from './types.ts'

export type * from './types.ts'
// The UTC+7 calendar and window math surfaces beside the ledger so other
// surfaces (the evolution journey) bucket on the same days instead of
// re-deriving the zone offset.
export { dayKeyUTC7, dayStartUTC7, daysOfRange, isUsageRange, windowStartOfRange } from './aggregate.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the durable usage-ledger counters. */
    usageLedger: UsageLedger
  }

  interface Events {
    /**
     * Today's rolling cache-hit share (all routes, UTC+7 day) dropped below
     * {@link Config.cacheHitAlertThreshold} after at least
     * {@link Config.cacheHitAlertMinRequests} billed requests. Edge-triggered:
     * fires once per healthy-to-unhealthy crossing, not on every request
     * while the day is already below threshold. Ephemeral (not logged to any
     * session): a live listener observes it, or re-derives the same rate any
     * time from {@link UsageLedger.summary}.
     * @param data - the day, its rate, the crossed threshold, and its request count.
     * @mode emit
     */
    'usage/cache-hit-low'(data: CacheHitLowEvent): void
  }
}

/** Payload of {@link Events['usage/cache-hit-low']}. */
export interface CacheHitLowEvent {
  /** Calendar day (UTC+7) the rate was computed for. */
  readonly day: string
  /** The share that crossed below threshold, in `[0, 1]`. */
  readonly cacheHitAvg: number
  /** The configured {@link Config.cacheHitAlertThreshold} that was crossed. */
  readonly threshold: number
  /** Today's billed request count at the moment of the crossing. */
  readonly requests: number
}

/** Deployment choices for the ledger's durability. */
export interface Config {
  /**
   * Calendar days (UTC+7) of counters to keep, counting today. Older day
   * and model rows are pruned on every durable write.
   */
  readonly retentionDays: number
  /** Folded session events that force a durable write between mandatory points. */
  readonly writeEveryEvents: number
  /** Longest time (milliseconds) a dirty ledger may stay unwritten between mandatory points. */
  readonly writeIntervalMs: number
  /**
   * Emit `usage/cache-hit-low` when today's rolling cache-hit share (all
   * routes) drops below this fraction (`0`-`1`). Unset disables the alert
   * entirely — the ledger still tracks the rate, nothing watches it.
   */
  readonly cacheHitAlertThreshold?: number
  /**
   * Minimum billed requests today before the alert can fire, so a thin
   * early-day sample cannot trip it. Meaningful only alongside
   * {@link cacheHitAlertThreshold}.
   */
  readonly cacheHitAlertMinRequests: number
}

/** Validated deployment choices; every tunable is explicit, none defaulted silently. */
export const Config: z<Config> = z.object({
  retentionDays: z.number().step(1).min(1).required(),
  writeEveryEvents: z.number().step(1).min(1).required(),
  writeIntervalMs: z.number().step(1).min(1).required(),
  cacheHitAlertThreshold: z.number().min(0).max(1),
  cacheHitAlertMinRequests: z.number().step(1).min(1).default(20),
})

/** Samples of one step awaiting their route and their `step/end` retirement. */
interface StepBucket {
  /** Attributed route once a settled message names it. */
  route?: { provider: string; model: string }
  /** Validated samples in arrival order, each with its own UTC+7 day. */
  samples: Array<{ day: string; sample: NormalizedSample }>
}

/** Unknown-route attribution for samples whose step never settles with a route. */
const UNKNOWN_ATTRIBUTION = { provider: UNKNOWN_ROUTE, model: UNKNOWN_ROUTE }

/**
 * The usage-ledger service. Opens the `usage_dashboard` domain at init,
 * backfills live sessions from their cursors, folds live events as they
 * commit, and serves range summaries.
 * @param ctx - Host context carrying sessions and the storage domain.
 * @param config - retention and write-behind choices from the composition.
 */
export class UsageLedger extends Service {
  static inject = ['sessions', 'storageDomain']

  static Config: z<Config> = Config

  private table?: KvTable<string, UsageLedgerState>
  private ledger: UsageLedgerState = { cursors: {}, daily: {}, models: {} }
  private readonly steps = new Map<Session, Map<string, StepBucket>>()
  private pendingEvents = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Day the alert last checked; a new day starts healthy until proven otherwise. */
  private cacheAlertDay: string | undefined
  /** Whether {@link cacheAlertDay}'s rate was at-or-above threshold at the last check. */
  private cacheAlertHealthy = true

  /**
   * @param ctx - Host context carrying sessions and the storage domain.
   * @param config - retention and write-behind choices from the composition.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'usageLedger')
    ctx.on('session/event', (session, event) => { this.observe(session, event) })
    // The live-to-cold moment persists whatever the throttle still holds,
    // while the domain is guaranteed open — unlike process teardown, whose
    // disposers race the domain close.
    ctx.on('session/disposed', (session) => {
      this.steps.delete(session)
      void this.flush()
    })
  }

  /** Open the domain, adopt its state, and backfill live sessions from their cursors. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(usageDashboardDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'usage-ledger: domain close')
    this.table = domain.table('ledger')
    const stored = this.table.get(LEDGER_KEY)
    this.ledger = stored === undefined ? { cursors: {}, daily: {}, models: {} } : structuredClone(stored)
    for (const session of this.ctx.sessions.list()) this.backfill(session)
    sweepRetention(this.ledger, Date.now(), this.config.retentionDays)
    await this.flush()
  }

  /**
   * Dashboard summary for one filter range.
   * @param range - the requested window (`today` by dashboard default).
   * @param signal - caller cancellation.
   * @returns totals, per-day buckets, and the per-model table.
   */
  summary(range: UsageRange, signal: AbortSignal): Promise<UsageSummary> {
    signal.throwIfAborted()
    if (!isUsageRange(range)) {
      throw new RemoteError('gateway/bad-request', `unknown usage range "${String(range)}"`, {})
    }
    return Promise.resolve(summarizeLedger(this.ledger, range, Date.now()))
  }

  /**
   * Fold one session's child-owned events past the cursor. The cursor is
   * read fresh per event, so a live event folded by {@link observe} while
   * the backfill walks is never folded twice.
   * @param session - the live session to backfill.
   */
  private backfill(session: Session): void {
    for (const event of session.ownEvents()) {
      const cursor = this.ledger.cursors[session.id] ?? -1
      if (event.seq <= cursor) continue
      this.fold(session, event)
      this.ledger.cursors[session.id] = event.seq
    }
  }

  /**
   * Observe one committed session event: fold usage samples, retire step
   * buckets, persist at turn boundaries, and advance the cursor.
   * @param session - the session that committed the event.
   * @param event - the committed event.
   */
  private observe(session: Session, event: SessionEvent): void {
    if (!session.isOwnSeq(event.seq)) return
    this.fold(session, event)
    if (event.type === 'step/end') this.steps.get(session)?.delete(stepKey(event.data.turn, event.data.step))
    this.ledger.cursors[session.id] = event.seq
    this.pendingEvents += 1
    if (event.type === 'turn/end' || this.pendingEvents >= this.config.writeEveryEvents) {
      void this.flush()
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, this.config.writeIntervalMs)
    }
  }

  /**
   * Fold one event's usage sample into the counters (cursor moves in
   * {@link observe}; backfill moves its own below).
   * @param session - the session that committed the event.
   * @param event - the committed event.
   */
  private fold(session: Session, event: SessionEvent): void {
    if (event.type === 'assistant/message') {
      const sample = sampleOfMessage(event)
      if (sample === undefined) return
      const normalized = normalizeSample(sample)
      if (normalized === undefined) return
      this.foldAttempt(session, stepKey(event.data.turn, event.data.step), normalized, event.time, messageRoute(event.data.message))
    } else if (event.type === 'assistant/attempt') {
      const sample = sampleOfAttempt(event)
      if (sample === undefined) return
      const normalized = normalizeSample(sample)
      if (normalized === undefined) return
      this.foldAttempt(session, stepKey(event.data.turn, event.data.step), normalized, event.time, undefined)
    }
  }

  /**
   * Count one validated sample under its step's route, moving earlier
   * unknown-routed samples when the step's first route arrives with it.
   * @param session - the owning session for step-bucket scope.
   * @param key - the `turn:step` bucket key.
   * @param sample - the validated sample.
   * @param time - the event's epoch milliseconds for UTC+7 day bucketing.
   * @param route - the step's route when this sample settles it.
   */
  private foldAttempt(
    session: Session,
    key: string,
    sample: NormalizedSample,
    time: number,
    route: { provider: string; model: string } | undefined,
  ): void {
    const day = dayKeyUTC7(time)
    let buckets = this.steps.get(session)
    if (buckets === undefined) {
      buckets = new Map()
      this.steps.set(session, buckets)
    }
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { samples: [] }
      buckets.set(key, bucket)
    }
    bucket.samples.push({ day, sample })
    if (route !== undefined && bucket.route === undefined) {
      for (const prior of bucket.samples.slice(0, -1)) {
        moveSample(this.ledger, prior.day, UNKNOWN_ATTRIBUTION, route, prior.sample)
      }
      bucket.route = route
    }
    const effective = bucket.route ?? UNKNOWN_ATTRIBUTION
    addSample(this.ledger, day, effective.provider, effective.model, sample)
    this.checkCacheHitAlert(day)
  }

  /**
   * Emit `usage/cache-hit-low` on a healthy-to-unhealthy crossing of today's
   * rolling cache-hit share. A no-op when the alert is unconfigured or the
   * day has not yet reached {@link Config.cacheHitAlertMinRequests}.
   * @param day - the UTC+7 day whose total just changed.
   */
  private checkCacheHitAlert(day: string): void {
    const threshold = this.config.cacheHitAlertThreshold
    if (threshold === undefined) return
    if (day !== this.cacheAlertDay) {
      this.cacheAlertDay = day
      this.cacheAlertHealthy = true
    }
    const row = this.ledger.daily[day]
    if (row === undefined || row.requests < this.config.cacheHitAlertMinRequests) return
    const rate = cacheHitAvg(row.cacheReadTokens, row.inputTokens)
    const healthy = rate >= threshold
    if (!healthy && this.cacheAlertHealthy) {
      this.ctx.emit('usage/cache-hit-low', { day, cacheHitAvg: rate, threshold, requests: row.requests })
    }
    this.cacheAlertHealthy = healthy
  }

  /**
   * Persist the ledger unless it is clean. Fail-soft: a lost write only
   * costs a longer backfill on the next boot, because the in-memory
   * counters stay ahead and the cursors move with them.
   */
  private async flush(): Promise<void> {
    this.pendingEvents = 0
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.table === undefined) return
    sweepRetention(this.ledger, Date.now(), this.config.retentionDays)
    try {
      await this.table.put(LEDGER_KEY, structuredClone(this.ledger))
    } catch (error) {
      this.ctx.logger.warn(`usage-ledger: durable write failed and will retry on the next flush: ${String(error)}`)
    }
  }
}

/**
 * Bucket key of one step's samples.
 * @param turn - the turn number.
 * @param step - the step number.
 * @returns the `turn:step` key.
 */
function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

export default UsageLedger
