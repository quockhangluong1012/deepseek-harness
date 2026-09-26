/**
 * Immutable session trace projection (`ctx.evolutionTrace`): the structured
 * learning trace of a session, derived from the committed session log — the
 * authoritative raw trace — with ranked root-cause attribution per failed tool
 * call, the §3.1 trajectory items the log records, the per-run execution trace
 * of §5.1 (identity, steps with their §5.2 telemetry, subagents, spend,
 * context, verification, and how the run ended), counterfactual replay over a
 * recorded trace, and compressed learning-trace rows for reflection and
 * evolution.
 *
 * Nothing here calls a model or writes a new domain: the session log already
 * is the immutable raw trace (§3.3 form one), so the store projects it on
 * demand instead of duplicating it. Read paths flush a live session first so a
 * query sees the turns that reached the model, and price the steps they read
 * from the mounted LLM catalog.
 * @module @deepseek-ai/dsh-evolution-trace
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-evolution-memory'
import { project } from './project.ts'
import { routePrices } from './prices.ts'
import { projectRuns } from './runs.ts'
import { replayTrace } from './replay.ts'
import { summarize } from './summarize.ts'
import type { AgentTrace, LearningTraceRow, ReplayArtifact, ReplayReport, TraceRecord } from './types.ts'

export type * from './types.ts'
export { project, sumUsage } from './project.ts'
export { routeKey, routePrices, routesOf } from './prices.ts'
export type { TraceRoute } from './prices.ts'
export { projectRuns } from './runs.ts'
export { replayTrace } from './replay.ts'
export { summarize } from './summarize.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Immutable session trace projection with ranked credit assignment. */
    evolutionTrace: EvolutionTrace
  }
}

/** Deployment choices for trace projection. */
export interface Config {
  /** Character budget for one failure or request gist. */
  maxChars?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  maxChars: z.number().step(1).min(1).default(500),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  maxChars: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const { maxChars = 500 } = config
  return { maxChars }
}

/**
 * Read one session's committed log, flushing a live session first so the
 * projection sees the turns that reached the model.
 * @param ctx - host context carrying session persistence.
 * @param id - session to read.
 * @returns the committed events, or undefined when storage holds no such session.
 */
async function readEvents(ctx: Context, id: SessionId): Promise<readonly SessionEvent[] | undefined> {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) {
    const live = sessions.get(id)
    if (live !== undefined) await sessions.flush(live)
  }
  let handle: SessionHandle
  try {
    handle = await ctx.sessionPersistence.open(id, 'read')
  } catch (error) {
    // Absence is the backend's decision; every other failure (corruption,
    // unsupported format, I/O) stays fail-loud.
    if (error instanceof SessionPersistenceNotFoundError) return undefined
    throw error
  }
  try {
    return (await handle.read(0)).events
  } finally {
    await handle.close()
  }
}

/**
 * Immutable session trace projection. Opens no domain: the session log is the
 * authoritative raw trace, and every read derives the structured form from it.
 */
export class EvolutionTrace extends Service {
  static inject = ['sessionPersistence']

  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying session persistence.
   * @param config - gist character budget.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionTrace')
    this.resolved = resolveConfig(config)
  }

  /**
   * Project one session's committed log into its structured learning trace.
   * @param sessionId - session identity.
   * @returns the structured trace, or undefined when storage holds no such session.
   */
  async trace(sessionId: string): Promise<TraceRecord | undefined> {
    const id = sessionId as SessionId
    const events = await readEvents(this.ctx, id)
    if (events === undefined) return undefined
    return project(String(id), events, this.resolved.maxChars, await routePrices(this.ctx, events))
  }

  /**
   * Project one session's committed log into its runs' execution traces
   * (§5.1 Agent Trace). A log that recorded no task contract holds no run.
   * @param sessionId - session identity.
   * @returns one trace per run, oldest first, or undefined when storage holds no such session.
   */
  async runs(sessionId: string): Promise<readonly AgentTrace[] | undefined> {
    const id = sessionId as SessionId
    const events = await readEvents(this.ctx, id)
    if (events === undefined) return undefined
    return projectRuns(String(id), events, this.resolved.maxChars, await routePrices(this.ctx, events))
  }

  /**
   * Compress the given sessions into learning-trace rows, most decisive first:
   * most failures, then retries, then billed tokens, then newest. Absent
   * sessions contribute nothing.
   * @param sessionIds - sessions to compress, in caller order.
   * @param limit - maximum rows returned.
   * @returns the compressed rows, decisive first.
   */
  async summary(sessionIds: readonly string[], limit: number): Promise<LearningTraceRow[]> {
    const rows: LearningTraceRow[] = []
    for (const sessionId of sessionIds) {
      const record = await this.trace(sessionId)
      if (record === undefined) continue
      const row = summarize(record)
      if (row !== undefined) rows.push(row)
    }
    return rows
      .sort((left, right) =>
        right.failures - left.failures
        || right.retries - left.retries
        || right.tokens - left.tokens
        || (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
        || left.sessionId.localeCompare(right.sessionId))
      .slice(0, limit)
  }

  /**
   * Replay one stored trace: reconstruct the context each step ran under,
   * restore the artifact the retrievals named, and compare a baseline artifact
   * against a candidate over the same trace (§16, §17). The recorded tool
   * results are the substrate, so the replay is keyless and re-invokes no
   * tool; steps whose recorded output is missing come back unreplayable.
   * @param sessionId - session whose committed trace to replay.
   * @param baseline - artifact revision the recorded run used.
   * @param candidate - artifact revision under consideration.
   * @returns the per-step comparison, or undefined when storage holds no such session.
   */
  async replay(sessionId: string, baseline: ReplayArtifact, candidate: ReplayArtifact): Promise<ReplayReport | undefined> {
    const record = await this.trace(sessionId)
    if (record === undefined) return undefined
    return replayTrace({ trace: record, baseline, candidate })
  }
}

export default EvolutionTrace
