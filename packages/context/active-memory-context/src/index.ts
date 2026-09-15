/**
 * Active memory sub-agent: before each eligible turn, searches past sessions
 * in the same workspace for content relevant to what the user just asked,
 * and splices matching snippets into `agent/pre-step` ahead of the model's
 * response — proactive retrieval instead of the user having to ask for it.
 * @module @deepseek-ai/dsh-active-memory-context
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
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
import { renderActiveMemoryBrief } from './render.ts'

export { escapeFrameBody, renderActiveMemoryBrief } from './render.ts'

/** Source of one active-memory brief message: a scored search result, never a user-authored message. */
export interface ActiveMemorySource {
  kind: 'active-memory'
  form: 'search-result'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'active-memory': ActiveMemorySource
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'active-memory-context'

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
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().step(1).min(1).required(),
  topK: z.number().step(1).min(1).default(5),
  relevanceThreshold: z.number().min(0).max(1).default(0.7),
  turnInterval: z.number().step(1).min(1).default(1),
  // `EvolutionScopeId` builds `<profile>:<workspace>`, so a profile that is
  // empty or holds ':' can never name a scope. Refuse it at load: accepted at
  // load, it would instead empty the graph leg every turn.
  profile: z.string().pattern(/^[^:]+$/).default('default'),
  graphDepth: z.number().step(1).min(1).default(1),
  graphLimit: z.number().step(1).min(1).default(5),
})

/** Plugin configuration with every optional field resolved. */
export interface ResolvedConfig {
  maxBytes: number
  topK: number
  relevanceThreshold: number
  turnInterval: number
  profile: string
  graphDepth: number
  graphLimit: number
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
    profile: config.profile ?? 'default',
    graphDepth: config.graphDepth ?? 1,
    graphLimit: config.graphLimit ?? 5,
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
 * Register the pre-step active-memory search for the lifetime of `ctx`.
 * @param ctx - plugin context; listeners dispose with it.
 * @param config - byte cap, result bounds, and search cadence.
 */
export function apply(ctx: Context, config: Config): void {
  const { maxBytes, topK, relevanceThreshold, turnInterval, profile, graphDepth, graphLimit } = resolveConfig(config)
  const workspaceBySession = new Map<string, WorkspaceId | null>()
  const turnsBySession = new Map<string, number>()
  const searchedForTurn = new Map<string, number>()

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/start') return
    const key = String(session.id)
    turnsBySession.set(key, (turnsBySession.get(key) ?? 0) + 1)
  })
  ctx.on('session/disposed', (session: Session) => {
    const key = String(session.id)
    workspaceBySession.delete(key)
    turnsBySession.delete(key)
    searchedForTurn.delete(key)
  })
  ctx.effect(() => () => {
    workspaceBySession.clear()
    turnsBySession.clear()
    searchedForTurn.clear()
  }, 'active-memory-context.cache')

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
   * channel is unavailable or the session has no resolvable scope.
   */
  const search = async (
    session: Session,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly SemanticSessionSearchHit[]> => {
    const scopeIds = await scopeSessionIds(session)
    if (scopeIds === undefined) return []
    const others = scopeIds.filter(id => id !== session.id)
    if (others.length === 0) return []
    let page: { items: readonly SemanticSessionSearchHit[] }
    try {
      page = await ctx.sessionQuery.searchSessionsSemantic(
        { query, sessionFilters: [{ kind: 'id', values: others }], limit: topK },
        { signal },
      )
    } catch (error) {
      if (error instanceof SessionQueryError) return []
      throw error
    }
    return page.items.filter(hit => hit.score >= relevanceThreshold)
  }

  /**
   * Search the scope's other sessions by the labels of the entities the graph
   * reaches from the turn's own words, so a turn about one known subject also
   * finds the sessions connected to it rather than only the ones that read like
   * it. Hits come back unscored: relevance here is a connection, not a distance.
   *
   * Fail-soft throughout — an unmounted, older, or failing graph yields no
   * results instead of blocking the turn.
   */
  const searchGraph = async (
    session: Session,
    query: string,
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
      const reached = graph.expand(scope, seed.label, graphDepth, graphLimit)
      labels = [...new Set([seed.label, ...reached.map(entry => entry.node.label)])].slice(0, graphLimit)
    } catch {
      return []
    }
    const others = workspace.sessionIds.filter(id => id !== session.id)
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
        if (error instanceof SessionQueryError) continue
        throw error
      }
    }
    return hits
  }

  ctx.on('agent/pre-step', async (input, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || input.signal.aborted) return decision
    const key = String(input.agent.session.id)
    const turn = turnsBySession.get(key) ?? 0
    if (!isSearchTurn(turn, turnInterval)) return decision
    if (searchedForTurn.get(key) === turn) return decision
    const query = input.messages.map(textOf).join('\n').trim()
    if (query.length === 0) return decision
    searchedForTurn.set(key, turn)
    const vectorHits = await search(input.agent.session, query, input.signal)
    const graphHits = await searchGraph(input.agent.session, query)
    // Both legs rank the same corpus, so the fusion is what makes a session
    // both channels agree on outrank one only a single channel found.
    const fused = fuseSessionRankings(vectorHits, graphHits)
    if (fused.length === 0) return decision
    const rendered = renderActiveMemoryBrief(fused, maxBytes)
    if (rendered === undefined) return decision
    const brief = createUserMessage({
      content: [{ type: 'text', text: rendered }],
      source: { kind: 'active-memory', form: 'search-result' },
    })
    return { ...decision, messages: [...decision.messages, brief] }
  })
}
