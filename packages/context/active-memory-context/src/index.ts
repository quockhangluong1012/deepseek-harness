/**
 * Active memory sub-agent: before each eligible turn, searches past sessions
 * in the same workspace for content relevant to what the user just asked,
 * and splices matching snippets into `agent/pre-step` ahead of the model's
 * response — proactive retrieval instead of the user having to ask for it.
 * With `taskAwarePolicy` on, the turn's recorded task class selects the §39
 * configuration `ctx.evolutionRetrieval` recommends instead of the mount's own.
 * When `agent-context` is mounted, the compiler records logged briefs as untrusted
 * deltas until compaction clears their placement.
 * @module @deepseek-ai/dsh-active-memory-context
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ContextItem } from '@deepseek-ai/dsh-agent-context'
import type {} from '@deepseek-ai/dsh-compaction'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GraphNode, GraphReach } from '@deepseek-ai/dsh-evolution-graph'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { SemanticSessionSearchHit, SessionSearchHit } from '@deepseek-ai/dsh-session-query'
import { fuseSessionRankings, SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  applyRetrievalPolicy,
  type RetrievalPolicyApplication,
  type RetrievalRecommendation,
} from './policy.ts'
import { renderActiveMemoryBrief } from './render.ts'

export { quoteRecalledText, renderActiveMemoryBrief } from './render.ts'
export { applyRetrievalPolicy } from './policy.ts'
export type {
  AppliedRetrievalDimension,
  RecommendedRetrievalConfiguration,
  RetrievalDimension,
  RetrievalPolicyApplication,
  RetrievalRecommendation,
  UnappliedRetrievalDimension,
} from './policy.ts'

/**
 * One eligible turn's retrieval, as the brief records it: the search result
 * the model saw, and — when the task-aware policy ran — the §39 dimensions the
 * recommendation put it on. The policy rides this message's own durable log
 * record, so the log says how the brief was retrieved.
 */
export interface ActiveMemorySource {
  kind: 'active-memory'
  form: 'search-result'
  /**
   * The applied §39 retrieval policy, present only when the mount enabled
   * `taskAwarePolicy` and a recommendation was consulted for the turn. Absent
   * means the turn ran the mount's own configuration, which is also what every
   * turn ran before this field existed.
   */
  policy?: RetrievalPolicyApplication
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** @persistenceAttribution */
    'active-memory': ActiveMemorySource
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'active-memory-context'

/** Retrieval lanes the injector may run on an eligible turn. */
export const ESCALATION_MODES = ['both', 'graph-first'] as const

/** Which retrieval lanes run before the vector leg spends an embedding call. */
export type EscalationMode = typeof ESCALATION_MODES[number]

/** Plugin configuration: brief cap, result bounds, and search cadence. */
export interface Config {
  /** Cap on the complete emitted text including the frame. */
  maxBytes: number
  /** Candidate results ranked per search, before the relevance threshold. Defaults to 5. */
  topK?: number
  /**
   * Minimum cosine similarity a hit must clear to be worth injecting, in the
   * configured embedding model's own vector space. A nearest-neighbor search
   * always returns its closest candidates even when none are truly relevant,
   * so this is what tells an off-topic turn apart from an on-topic one.
   * Recalibrate after switching embedding providers or models. Defaults to 0.7.
   */
  relevanceThreshold?: number
  /** Turns between active-memory searches. Defaults to 1 (every turn). */
  turnInterval?: number
  /**
   * Which lanes run on an eligible turn. `both` runs the vector and graph
   * legs every turn; `graph-first` runs the local graph leg first and spends
   * the vector leg's embedding call only when the graph leg returns nothing.
   * Defaults to `both`, which preserves the historical behavior.
   */
  escalation?: EscalationMode
  /**
   * Scope-identity namespace the graph leg reads, which must match the profile
   * the scope's graph was extracted under — a mismatch reads an empty graph and
   * silently degrades to the vector leg. Defaults to 'default'.
   */
  profile?: string
  /** Hops the graph leg expands from the entity it matched. Defaults to 1. */
  graphDepth?: number
  /**
   * Bound the graph leg spends three ways on one turn: how many of the turn's
   * leading words the entity scan tries, how many entities one `expand` may
   * return, and how many labels that expansion may then seed searches with.
   * Defaults to 5.
   */
  graphLimit?: number
  /**
   * Consult the §39 configuration `ctx.evolutionRetrieval` recommends for the
   * turn's task class and run it, instead of the configuration this mount's own
   * fields spell. The dimensions the injector owns — lane, scope, graph depth,
   * threshold — take the recommended value; the rest are recorded unapplied.
   * Defaults to false: a mount that has not opted in retrieves exactly what it
   * retrieved before this policy existed.
   */
  taskAwarePolicy?: boolean
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().step(1).min(1).required(),
  topK: z.number().step(1).min(1).default(5),
  relevanceThreshold: z.number().min(0).max(1).default(0.7),
  turnInterval: z.number().step(1).min(1).default(1),
  escalation: z.union([...ESCALATION_MODES]).default('both'),
  // `EvolutionScopeId` builds `<profile>:<workspace>`, so a profile that is
  // empty or holds ':' can never name a scope. Refuse it at load: accepted at
  // load, it would instead empty the graph leg every turn.
  profile: z.string().pattern(/^[^:]+$/).default('default'),
  graphDepth: z.number().step(1).min(1).default(1),
  graphLimit: z.number().step(1).min(1).default(5),
  taskAwarePolicy: z.boolean().default(false),
})

/** Plugin configuration with every optional field resolved. */
export interface ResolvedConfig {
  maxBytes: number
  topK: number
  relevanceThreshold: number
  turnInterval: number
  escalation: EscalationMode
  profile: string
  graphDepth: number
  graphLimit: number
  taskAwarePolicy: boolean
}

/** Which retrieval lane this injector serves: graph-first prefers the graph, `both` runs both. */
export type RetrievalSource = 'graph' | 'hybrid'

/** The §39 retrieval dimensions this injector's resolved mount is running under. */
export interface RetrievalConfigurationInForce {
  /** Retrieval source: the graph leg alone is preferred, or both legs run. */
  source: RetrievalSource
  /** Query expansion: the graph leg expands the turn's words into entity labels. */
  queryExpansion: 'graph-entities'
  /** Lane weights: the reciprocal-rank fusion weighs both legs equally. */
  weights: { vector: number; graph: number }
  /** Reranking: fused ranks are the final order. */
  reranker: 'none'
  /** MMR: the brief keeps fusion order, undiversified. */
  mmr: { enabled: boolean; lambda: number }
  /** Memory scope: the search reads the session's workspace. */
  memoryScope: 'workspace'
  /** Graph depth: hops the graph leg expands from the entity it matched. */
  graphDepth: number
  /** Active-memory threshold: minimum similarity a hit must clear to be injected. */
  threshold: number
}

/**
 * The retrieval configuration a resolved mount runs under, as the §39
 * candidate dimensions. The injector states the dimensions it actually sets:
 * the rest are the shipped choice — unweighted fusion, no reranker, no
 * diversification — which a deployment cannot vary here and the optimizer
 * varies by recording a configuration of its own.
 * @param config - the resolved plugin configuration.
 * @returns the configuration in force, ready to record.
 */
export function inForceConfiguration(config: ResolvedConfig): RetrievalConfigurationInForce {
  return {
    source: config.escalation === 'graph-first' ? 'graph' : 'hybrid',
    queryExpansion: 'graph-entities',
    weights: { vector: 1, graph: 1 },
    reranker: 'none',
    mmr: { enabled: false, lambda: 1 },
    memoryScope: 'workspace',
    graphDepth: config.graphDepth,
    threshold: config.relevanceThreshold,
  }
}

/**
 * Resolve cadence and threshold defaults before the injector registers
 * anything, keeping one owner for the values.
 * @param config - validated plugin configuration.
 * @returns configuration with every field present.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    maxBytes: config.maxBytes,
    topK: config.topK ?? 5,
    relevanceThreshold: config.relevanceThreshold ?? 0.7,
    turnInterval: config.turnInterval ?? 1,
    escalation: config.escalation ?? 'both',
    profile: config.profile ?? 'default',
    graphDepth: config.graphDepth ?? 1,
    graphLimit: config.graphLimit ?? 5,
    taskAwarePolicy: config.taskAwarePolicy ?? false,
  }
}

/**
 * Required host services. `sessionQuery` is a hard requirement — mounting
 * this plugin is asking for session-query-backed active memory, so a
 * deployment that forgets to mount the query service fails loudly at load
 * instead of the injector silently never firing.
 */
export const inject = ['workspaceRegistry', 'sessionQuery']

/**
 * Decide whether a search on the configured cadence is due on `turn`. A
 * session with no observed `turn/start` yet counts as turn 0 and reads as
 * its first turn, mirroring `dsh-evolution-memory-context`'s nudge cadence.
 * @param turn - observed `turn/start` count for the session; 0 before the first.
 * @param interval - turns between searches, from the validated config (at least 1).
 * @returns true when this turn falls on the interval.
 */
export function isSearchTurn(turn: number, interval: number): boolean {
  return Math.max(turn, 1) % interval === 0
}

/**
 * Concatenate every text part of one message's content.
 * @param message - a proposed step message.
 * @returns the message's plain-text content, or an empty string when it carries none.
 */
function textOf(message: UserMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function activeMemoryItem(message: UserMessage): ContextItem | undefined {
  const source = message.source as { kind?: string } | undefined
  if (source?.kind !== 'active-memory') return undefined
  return { id: String(message.id), text: textOf(message), relevance: 1 }
}

/**
 * The slice of `ctx.evolutionGraph` this plugin reads: label lookup and bounded
 * expansion. Declared here rather than imported so active memory keeps no hard
 * dependency on the graph package — the engine is optional infrastructure, and
 * a deployment without one falls back to the vector leg alone.
 */
interface GraphSeam {
  /**
   * Find entities whose label contains a query.
   * @param scopeId - scope identity.
   * @param query - case-insensitive label substring.
   * @param limit - maximum entities returned.
   * @returns the matching entities, most-connected first.
   */
  find(scopeId: EvolutionScopeId, query: string, limit: number): GraphNode[]
  /**
   * Expand one entity's neighborhood breadth-first.
   * @param scopeId - scope identity.
   * @param subject - subject label, matched by normalized identity.
   * @param depth - maximum hops, at least 1.
   * @param limit - maximum reached entities.
   * @returns the reached entities, origin first.
   */
  expand(scopeId: EvolutionScopeId, subject: string, depth: number, limit: number): GraphReach[]
}

/**
 * Whether a context value offers the graph reads this leg calls. Absent and
 * foreign values answer false instead of throwing, so a missing — or older —
 * graph degrades to the vector leg rather than failing the turn.
 * @param value - the value read from `ctx.get('evolutionGraph')`.
 * @returns whether the value can look entities up and expand them.
 */
function isGraphSeam(value: unknown): value is GraphSeam {
  return typeof Reflect.get(Object(value), 'find') === 'function'
    && typeof Reflect.get(Object(value), 'expand') === 'function'
}

/**
 * The slice of `ctx.evolutionRetrieval` this plugin records into. Declared
 * here rather than imported so active memory keeps no dependency on the
 * retrieval package: a deployment without one records nothing, exactly as it
 * already runs without a graph.
 */
interface RetrievalLedger {
  /**
   * Record the configuration one session ran under.
   * @param input - the configuration in force and the session it served.
   * @returns resolution once the attribution is durable.
   */
  record(input: { configuration: RetrievalConfigurationInForce; sessionId: string }): Promise<unknown>
}

/**
 * Whether a context value offers the one write this plugin makes. Absent and
 * foreign values answer false instead of throwing.
 * @param value - the value read from `ctx.get('evolutionRetrieval')`.
 * @returns whether the value can record an attribution.
 */
function isRetrievalLedger(value: unknown): value is RetrievalLedger {
  return typeof Reflect.get(Object(value), 'record') === 'function'
}

/**
 * The slice of `ctx.evolutionRetrieval` the task-aware policy reads: the
 * configuration the store recommends for one task class. A separate seam from
 * {@link RetrievalLedger} because it is a separate concern — a store that
 * records but cannot recommend (or the reverse) still serves whichever half it
 * has — and because reading it is guarded by its own check.
 */
interface RetrievalRecommender {
  /**
   * The configuration to run for one task class, above the store's evidence gate.
   * @param taskClass - the task class to recommend for.
   * @returns the recommended configuration with the score behind its rank, or
   *   undefined while no configuration has enough evidence on that class.
   */
  recommend(taskClass: string): (RetrievalRecommendation & { score: number }) | undefined
}

/**
 * Whether a context value can recommend a retrieval configuration. Absent and
 * foreign values answer false instead of throwing, so an unmounted — or older —
 * store falls back to the mount's own configuration rather than failing a turn.
 * @param value - the value read from `ctx.get('evolutionRetrieval')`.
 * @returns whether the value can recommend a configuration for a task class.
 */
function isRetrievalRecommender(value: unknown): value is RetrievalRecommender {
  return typeof Reflect.get(Object(value), 'recommend') === 'function'
}

/**
 * The slice of `ctx.evolutionSkillTelemetry` the task-aware policy reads: which
 * skills recorded a session. The skill name is the task class both that store
 * and `ctx.evolutionRetrieval` grade a session on, so this is the recorded
 * classification the policy consults rather than a guess from the turn's text.
 */
interface SkillTelemetrySeam {
  /**
   * List every skill's usage record.
   * @returns the records, in the store's own order.
   */
  entries(): readonly {
    /** Skill name — the task class its sessions served. */
    readonly name: string
    /** The usage record, narrowed to the one read this policy joins on. */
    readonly usage: {
      /** Sessions that loaded the skill. */
      readonly sessionIds: readonly string[]
    }
  }[]
}

/**
 * Whether a context value can name the skills a session loaded. Absent and
 * foreign values answer false instead of throwing, so a deployment without the
 * telemetry store derives no task class and runs the mount's configuration.
 * @param value - the value read from `ctx.get('evolutionSkillTelemetry')`.
 * @returns whether the value can list skill usage records.
 */
function isSkillTelemetry(value: unknown): value is SkillTelemetrySeam {
  return typeof Reflect.get(Object(value), 'entries') === 'function'
}

/**
 * The slice of one `ctx.workspaceRegistry` entry this plugin keys its work by:
 * the id a scope identity is built from and the sessions it owns. Declared here
 * rather than imported so only those two reads are depended on.
 */
interface ScopeWorkspace {
  /** Stable record id the evolution scope identity is built from. */
  readonly id: WorkspaceId
  /** Sessions the registry currently accounts to this workspace. */
  readonly sessionIds: readonly SessionId[]
}

/**
 * Scope members besides the turn's own session: a session never surfaces its
 * own just-submitted message as its own "relevant memory".
 * @param ids - every session id in the scope.
 * @param self - the session whose turn is being briefed.
 * @returns the scope without that session.
 */
function otherSessionIds(ids: readonly SessionId[], self: SessionId): SessionId[] {
  return ids.filter(id => id !== self)
}

/**
 * Register the pre-step search and its optional compiler-source provider for
 * the lifetime of `ctx`.
 * @param ctx - plugin context; listeners dispose with it.
 * @param config - byte cap, result bounds, search cadence, and policy switch.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const {
    maxBytes,
    topK,
    relevanceThreshold,
    turnInterval,
    escalation,
    profile,
    graphDepth,
    graphLimit,
    taskAwarePolicy,
  } = resolved
  const workspaceBySession = new Map<string, WorkspaceId | null>()
  const turnsBySession = new Map<string, number>()
  const searchedForTurn = new Map<string, number>()
  const recordedSessions = new Set<string>()
  const activeMemoryItems = new Map<string, Map<string, ContextItem>>()
  const configurationInForce = inForceConfiguration(resolved)

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const key = String(session.id)
    if (event.type === 'turn/start') {
      turnsBySession.set(key, (turnsBySession.get(key) ?? 0) + 1)
      return
    }
    if (event.type === 'compaction/end') {
      activeMemoryItems.delete(key)
      return
    }
    if (event.type !== 'user/message') return
    const item = activeMemoryItem(event.data)
    if (item === undefined) return
    const items = activeMemoryItems.get(key) ?? new Map<string, ContextItem>()
    items.set(item.id, item)
    activeMemoryItems.set(key, items)
  })
  ctx.on('session/disposed', (session: Session) => {
    const key = String(session.id)
    workspaceBySession.delete(key)
    turnsBySession.delete(key)
    searchedForTurn.delete(key)
    recordedSessions.delete(key)
    activeMemoryItems.delete(key)
  })
  ctx.effect(() => () => {
    workspaceBySession.clear()
    turnsBySession.clear()
    searchedForTurn.clear()
    recordedSessions.clear()
    activeMemoryItems.clear()
  }, 'active-memory-context.cache')

  /**
   * Record the retrieval configuration this session runs under, once per
   * session: a side record with no model call and no prompt change, so a store
   * that is unmounted or failing changes neither the search nor the brief. The
   * write is not awaited — the step never waits on a recording — and the
   * session is marked before it returns, since the store's key is the
   * configuration and the session joined and a repeat would upsert the same
   * row anyway.
   */
  const recordConfiguration = (session: Session): void => {
    const key = String(session.id)
    if (recordedSessions.has(key)) return
    const ledger: unknown = ctx.get('evolutionRetrieval')
    if (!isRetrievalLedger(ledger)) return
    recordedSessions.add(key)
    void ledger.record({ configuration: configurationInForce, sessionId: key }).catch((error: unknown) => {
      ctx.logger.debug(`active-memory: retrieval-configuration record degraded (${String(error)})`)
    })
  }

  /**
   * The strongest recommendation the session's recorded task classes have. A
   * session's task classes are the skills whose usage record lists it — the
   * same axis `dsh-evolution-retrieval` grades a session on — so the class
   * comes from recorded evidence rather than from the turn's own text. Classes
   * are consulted in name order and the highest-scoring recommendation wins
   * outright, so a tie goes to the first name.
   *
   * Absent telemetry, an absent or older recommendation store, and a class with
   * no recommendation above the store's evidence gate all answer undefined:
   * the turn then runs the mount's own configuration, which is what makes the
   * policy's fallback the same retrieval the mount would have done anyway.
   */
  const recommendationFor = (
    sessionId: string,
  ): { taskClass: string; recommendation: RetrievalRecommendation & { score: number } } | undefined => {
    const store: unknown = ctx.get('evolutionRetrieval')
    if (!isRetrievalRecommender(store)) return undefined
    const telemetry: unknown = ctx.get('evolutionSkillTelemetry')
    if (!isSkillTelemetry(telemetry)) return undefined
    const classes = telemetry.entries()
      .filter(entry => entry.usage.sessionIds.includes(sessionId))
      .map(entry => entry.name)
      .sort()
    let best: { taskClass: string; recommendation: RetrievalRecommendation & { score: number } } | undefined
    for (const taskClass of classes) {
      const found = store.recommend(taskClass)
      if (found === undefined) continue
      if (best === undefined || found.score > best.recommendation.score) best = { taskClass, recommendation: found }
    }
    return best
  }

  /**
   * Workspace membership already known from an exact session-id match. The
   * whole entry is returned because the graph leg keys its scope by the
   * workspace id, not only by the session list the vector leg filters.
   */
  const memberWorkspace = (session: Session): ScopeWorkspace | undefined => {
    const key = String(session.id)
    const cached = workspaceBySession.get(key)
    if (cached === null) return undefined
    if (cached !== undefined) {
      const workspace = ctx.workspaceRegistry.get(cached)
      if (workspace !== undefined) return workspace
      workspaceBySession.delete(key)
    }
    const found = ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(session.id))
    if (found === undefined) return undefined
    workspaceBySession.set(key, found.id)
    return found
  }

  /** Full membership resolution, falling back to a canonical-cwd match. */
  const scopeSessionIds = async (session: Session): Promise<readonly SessionId[] | undefined> => {
    const key = String(session.id)
    const direct = memberWorkspace(session)
    if (direct !== undefined) return direct.sessionIds
    const cwd = session.header.cwd
    const canonical = cwd === undefined ? undefined : await realpath(cwd).catch(() => undefined)
    const match = canonical === undefined
      ? undefined
      : ctx.workspaceRegistry.list().find(entry => entry.path === canonical)
    if (match === undefined) {
      workspaceBySession.set(key, null)
      return undefined
    }
    workspaceBySession.set(key, match.id)
    return match.sessionIds
  }

  /**
   * Search the scope's other sessions for content relevant to `query`,
   * degrading to no results rather than blocking the turn when the vector
   * channel is unavailable or the session has no resolvable scope. Each
   * degradation is debug-logged.
   * @param session - the session whose workspace scopes the search.
   * @param query - the turn's own text.
   * @param signal - cancellation of the step that asked.
   * @param threshold - minimum similarity a hit must clear: the mount's own
   *   `relevanceThreshold`, or the recommended configuration's.
   * @returns the surviving scored hits, best first.
   */
  const search = async (
    session: Session,
    query: string,
    signal: AbortSignal,
    threshold: number,
  ): Promise<readonly SemanticSessionSearchHit[]> => {
    const scopeIds = await scopeSessionIds(session)
    if (scopeIds === undefined) return []
    const others = otherSessionIds(scopeIds, session.id)
    if (others.length === 0) return []
    let page: { items: readonly SemanticSessionSearchHit[] }
    try {
      page = await ctx.sessionQuery.searchSessionsSemantic(
        { query, sessionFilters: [{ kind: 'id', values: others }], limit: topK },
        { signal },
      )
    } catch (error) {
      if (error instanceof SessionQueryError) {
        ctx.logger.debug(`active-memory: vector leg degraded (${error.code})`)
        return []
      }
      throw error
    }
    return page.items.filter(hit => hit.score >= threshold)
  }

  /**
   * Search the scope's other sessions by the labels of the entities the graph
   * reaches from the turn's own words, so a turn about one known subject also
   * finds the sessions connected to it rather than only the ones that read like
   * it. Hits come back unscored: relevance here is a connection, not a distance.
   *
   * Fail-soft throughout — an unmounted, older, or failing graph yields no
   * results instead of blocking the turn. Each degradation is debug-logged.
   * @param session - the session whose workspace scopes the graph and the search.
   * @param query - the turn's own text.
   * @param depth - hops to expand: the mount's own `graphDepth`, or the
   *   recommended configuration's.
   * @returns the reached sessions, unscored, in label order.
   */
  const searchGraph = async (
    session: Session,
    query: string,
    depth: number,
  ): Promise<readonly SessionSearchHit[]> => {
    const graph: unknown = ctx.get('evolutionGraph')
    if (!isGraphSeam(graph)) return []
    const workspace = memberWorkspace(session)
    if (workspace === undefined) return []
    let labels: string[]
    try {
      // `EvolutionScopeId` refuses an empty key and one containing ':', and the
      // workspace key comes from the registry, which validates neither, so the
      // scope is built inside this guard with every other graph read: a bad
      // workspace key must degrade the leg, not reject the turn.
      const scope = EvolutionScopeId(profile, String(workspace.id))
      // The graph is matched by label, so a whole turn never seeds it: scan the
      // turn's own words instead and let the earliest-mentioned entity win. The
      // budget is `graphLimit` lookups, the same bound the label cap uses.
      const tokens = query.toLowerCase().split(/\s+/).slice(0, graphLimit)
      let seed: GraphNode | undefined
      for (const token of tokens) {
        // `find` matches any label containing the token, so a word under three
        // characters ("a", "in", "is") is a turn's own grammar rather than a
        // name: seeding on it would spend the whole label budget on the most
        // connected label that happens to contain the substring.
        if (token.length < 3) continue
        const found = graph.find(scope, token, 1)
        if (found.length > 0) {
          seed = found[0]
          break
        }
      }
      if (seed === undefined) return []
      // The seam proves `expand` is callable, not that it honors its contract,
      // so reading the reached nodes stays inside the guard as well.
      const reached = graph.expand(scope, seed.label, depth, graphLimit)
      labels = [...new Set([seed.label, ...reached.map(entry => entry.node.label)])].slice(0, graphLimit)
    } catch (error) {
      ctx.logger.debug(`active-memory: graph leg degraded (${String(error)})`)
      return []
    }
    const others = otherSessionIds(workspace.sessionIds, session.id)
    const hits: SessionSearchHit[] = []
    const seen = new Set<string>()
    for (const label of labels) {
      try {
        const page = await ctx.sessionQuery.searchSessions(
          { query: label, sessionFilters: [{ kind: 'id', values: others }], limit: topK },
        )
        // Labels overlap — a session can match two of them in one page each —
        // so the leg keeps the first hit per session and each session enters
        // the fusion's reciprocal-rank sum once. Counting a session again per
        // matching label would outrank genuine two-leg agreement with one leg's
        // repeated evidence.
        for (const item of page.items) {
          const id = String(item.header.id)
          if (seen.has(id)) continue
          seen.add(id)
          hits.push(item)
        }
      } catch (error) {
        if (error instanceof SessionQueryError) {
          ctx.logger.debug(`active-memory: graph label search degraded (${error.code})`)
          continue
        }
        throw error
      }
    }
    return hits
  }

  const activeMemorySources = async (
    session: Session,
    signal: AbortSignal,
  ): Promise<readonly ContextItem[]> => {
    signal.throwIfAborted()
    const key = String(session.id)
    const cached = activeMemoryItems.get(key)
    if (cached !== undefined) return [...cached.values()]
    let surface: { events: readonly SessionEvent[] }
    try {
      surface = await ctx.sessionQuery.readSurface(session.id)
    } catch (error: unknown) {
      ctx.logger.debug(`active-memory: source read degraded (${String(error)})`)
      return []
    }
    signal.throwIfAborted()
    const items = new Map<string, ContextItem>()
    for (const event of surface.events) {
      if (event.type !== 'user/message') continue
      const item = activeMemoryItem(event.data)
      if (item !== undefined) items.set(item.id, item)
    }
    activeMemoryItems.set(key, items)
    return [...items.values()]
  }

  ctx.inject(['agentContext'], (compilerCtx) => {
    compilerCtx.effect(() => compilerCtx.agentContext.register({
      producer: 'active-memory',
      kind: 'memory',
      trust: 'untrusted',
      placement: 'delta',
      maxBytes,
    }, async (agent, signal) => activeMemorySources(agent.session, signal)))
  })

  ctx.on('agent/pre-step', async (input, next): Promise<PreStepDecision> => {
    recordConfiguration(input.agent.session)
    const decision = await next()
    if (decision.kind === 'reject' || input.signal.aborted) return decision
    const key = String(input.agent.session.id)
    const turn = turnsBySession.get(key) ?? 0
    if (!isSearchTurn(turn, turnInterval)) return decision
    if (searchedForTurn.get(key) === turn) return decision
    const query = input.messages.map(textOf).join('\n').trim()
    if (query.length === 0) return decision
    searchedForTurn.set(key, turn)
    // The task-aware policy replaces the mount's own knobs for this turn only
    // when the store recommends a configuration for the turn's recorded task
    // class. Anything less — the policy off, no telemetry, no class, no
    // recommendation above the store's evidence gate — runs the mount's own
    // configuration, which is also what every turn ran before the policy.
    let turnEscalation = escalation
    let turnGraphDepth = graphDepth
    let turnThreshold = relevanceThreshold
    let policy: RetrievalPolicyApplication | undefined
    if (taskAwarePolicy) {
      const found = recommendationFor(key)
      if (found === undefined) {
        ctx.logger.debug(`active-memory: no retrieval recommendation for session ${key}; running the mount's own configuration`)
      } else {
        policy = applyRetrievalPolicy(found.taskClass, found.recommendation, escalation)
        turnEscalation = policy.effective.escalation
        turnGraphDepth = policy.effective.graphDepth
        turnThreshold = policy.effective.threshold
      }
    }
    // The graph leg is local lookups plus text searches — no embedding call —
    // so `graph-first` spends it before the vector leg and skips the vector
    // leg when the graph already connected the turn to a session. A missing,
    // inapplicable, or empty graph leg returns nothing and the vector leg runs
    // exactly as it would have without escalation.
    let vectorHits: readonly SemanticSessionSearchHit[] = []
    let graphHits: readonly SessionSearchHit[] = []
    if (turnEscalation === 'graph-first') {
      graphHits = await searchGraph(input.agent.session, query, turnGraphDepth)
      if (graphHits.length === 0) {
        vectorHits = await search(input.agent.session, query, input.signal, turnThreshold)
      }
    } else {
      vectorHits = await search(input.agent.session, query, input.signal, turnThreshold)
      graphHits = await searchGraph(input.agent.session, query, turnGraphDepth)
    }
    // Both legs rank the same corpus, so the fusion is what makes a session
    // both channels agree on outrank one only a single channel found.
    const fused = fuseSessionRankings(vectorHits, graphHits)
    if (fused.length === 0) return decision
    const rendered = renderActiveMemoryBrief(fused, maxBytes)
    if (rendered === undefined) return decision
    const brief = createUserMessage({
      content: [{ type: 'text', text: rendered }],
      source: {
        kind: 'active-memory',
        form: 'search-result',
        // The applied policy rides the injected message's own durable record,
        // so the log reconstructs which dimensions produced this brief. A turn
        // the policy did not change carries no policy field at all.
        ...policy === undefined ? {} : { policy },
      },
    })
    return { ...decision, messages: [...decision.messages, brief] }
  })
}
