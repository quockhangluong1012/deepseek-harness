/**
 * Knowledge-graph memory (`ctx.evolutionGraph`): durable per-scope entities
 * and directed relations, traversed by connection instead of matched by
 * similarity, plus one deterministic extraction that turns text into triples.
 *
 * The graph is an index over what a scope already knows, not a second memory
 * document: it stores only labels, kinds, and relation names, never the
 * sentence a relation was read from. Extraction is one `temperature: 0` call
 * whose output is validated before it is merged, and every traversal is
 * bounded by configured limits.
 *
 * A registered heartbeat task keeps the graph filling on its own: session
 * text is buffered per scope as it is published, and each run extracts one
 * buffered scope at a time and clears what it consumed. An idle scope costs
 * nothing, and text buffered before a restart is lost rather than retried.
 * @module @deepseek-ai/dsh-evolution-graph
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-llm'
import { EvolutionScopeId, storageKey, truncateUtf8, utf8Bytes } from '@deepseek-ai/dsh-evolution-memory'
import { graphDomainSpec } from './spec.ts'
import type {
  GraphAnswer,
  GraphNode,
  GraphReach,
  GraphRecord,
  GraphTriple,
} from './types.ts'

export type * from './types.ts'
export { graphEdge, graphNode, graphDomainSpec, graphRecordSchema } from './spec.ts'

/** Timeout reason code for one extraction run. */
export const EVOLUTION_GRAPH_TIMEOUT = 'EVOLUTION_GRAPH_TIMEOUT'

/** Heartbeat task name carrying the automatic extraction sweep. */
export const EVOLUTION_GRAPH_EXTRACT_TASK = 'evolution-graph-extract'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-scope knowledge graph. */
    evolutionGraph: EvolutionGraph
  }
}

/** Deployment choices for the knowledge graph. */
export interface Config {
  /** Nodes retained per scope; further distinct entities are refused. */
  maxNodes?: number
  /** Relations retained per scope; further distinct relations are refused. */
  maxEdges?: number
  /** Results one answer, expansion, or lookup may return. */
  maxQueryLimit?: number
  /** Text budget for one extraction call in UTF-8 bytes. */
  maxInputBytes?: number
  /** Output-token cap for one extraction call. */
  maxOutputTokens?: number
  /** Deadline for one extraction call in milliseconds. */
  timeoutMs?: number
  /** Hours between two heartbeat extraction runs. */
  intervalHours?: number
  /**
   * Scope-identity namespace placed before the workspace key, shared with the
   * reviewer, the brief injector, and the controller so they read and write
   * one scope (`profile: default` in `packages/bundle/web-app/cordis.patch.yml`).
   */
  profile?: string
  /** Provider route for extraction; set together with `model`. */
  provider?: string
  /** Model id for extraction; set together with `provider`. */
  model?: string
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  maxNodes: z.number().step(1).min(1).default(500),
  maxEdges: z.number().step(1).min(1).default(2000),
  maxQueryLimit: z.number().step(1).min(1).default(20),
  maxInputBytes: z.number().step(1).min(1).default(131072),
  maxOutputTokens: z.number().step(1).min(1).default(1024),
  timeoutMs: z.number().step(1).min(1).default(60000),
  intervalHours: z.number().step(1).min(1).default(6),
  // `EvolutionScopeId` builds `<profile>:<workspace>`, so a profile that is
  // empty or holds ':' can never name a scope. Refuse it at load: accepted at
  // load, it would instead empty the reader's graph every time.
  profile: z.string().pattern(/^[^:]+$/).default('default'),
  provider: z.string(),
  model: z.string(),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  maxNodes: number
  maxEdges: number
  maxQueryLimit: number
  maxInputBytes: number
  maxOutputTokens: number
  timeoutMs: number
  intervalHours: number
  profile: string
  provider: string | undefined
  model: string | undefined
}

/**
 * Resolve defaults for the optional fields. A half-set extraction route and a
 * profile that cannot name a scope both fail loudly: a fork that cannot name a
 * model, or whose every read keys a scope that can never exist, would
 * otherwise skip or empty silently.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const {
    maxNodes = 500,
    maxEdges = 2000,
    maxQueryLimit = 20,
    maxInputBytes = 131072,
    maxOutputTokens = 1024,
    timeoutMs = 60000,
    intervalHours = 6,
    profile = 'default',
    provider,
    model,
  } = config
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('evolution-graph: provider and model must be set together')
  }
  // `EvolutionScopeId` builds `<profile>:<workspace>` and refuses both forms,
  // so a mount that accepted one here would fail every scope it built instead.
  if (profile.length === 0) throw new Error('evolution-graph: profile must be non-empty')
  if (profile.includes(':')) {
    throw new Error(`evolution-graph: profile must not contain ':', got ${JSON.stringify(profile)}`)
  }
  return {
    maxNodes,
    maxEdges,
    maxQueryLimit,
    maxInputBytes,
    maxOutputTokens,
    timeoutMs,
    intervalHours,
    profile,
    provider,
    model,
  }
}

/** Outcome of one merged observation batch. */
export interface GraphObserveResult {
  /** Entities added by this batch. */
  addedNodes: number
  /** Relations added by this batch. */
  addedEdges: number
  /** Relations that already existed and had their count raised. */
  reinforcedEdges: number
  /** Triples dropped because a cap was reached or a part was empty. */
  skipped: number
}

/** Outcome of one extraction call. */
export interface GraphExtractResult extends GraphObserveResult {
  /** Triples the model returned and this call accepted for merging. */
  observed: number
}

/**
 * Normalize one entity label into its node identity.
 * @param label - the label as written or extracted.
 * @returns the case-folded, trimmed identity.
 */
export function normalizeNodeId(label: string): string {
  return label.trim().toLowerCase()
}

/**
 * Normalize one relation name.
 * @param relation - the relation as written or extracted.
 * @returns the lower snake-case relation.
 */
export function normalizeRelation(relation: string): string {
  return relation.trim().toLowerCase().replace(/\s+/g, '_')
}

/** Merge key of one directed relation. */
function edgeKey(from: string, relation: string, to: string): string {
  return `${from}\u0000${relation}\u0000${to}`
}

/**
 * Insert or enrich one entity. A first sighting keeps its label and returns
 * true; a later sighting keeps the first label but gains the kind it lacked.
 * @param nodes - the scope's nodes, mutated in place.
 * @param id - normalized node identity.
 * @param label - the label as written.
 * @param kind - the kind this observation carries, or null.
 * @returns whether a new node was inserted.
 */
function upsertNode(nodes: Map<string, GraphNode>, id: string, label: string, kind: string | null): boolean {
  const existing = nodes.get(id)
  if (existing === undefined) {
    nodes.set(id, { id, label: label.trim(), kind })
    return true
  }
  if (existing.kind === null && kind !== null) nodes.set(id, { ...existing, kind })
  return false
}

/**
 * The slice of `ctx.evolutionHeartbeat` this producer registers with. It is
 * declared here rather than imported so the graph keeps no dependency on the
 * heartbeat package: the engine is optional infrastructure, and the graph must
 * work — with `extract` callable directly — when nothing mounts one.
 */
interface HeartbeatSeam {
  /**
   * Register one periodic task.
   * @param task - identity, cadence, and the work to run.
   * @returns the disposer removing the task.
   */
  register(task: {
    name: string
    intervalHours: number
    run: (signal: AbortSignal) => Promise<void> | void
  }): () => void
}

/**
 * Whether a context value offers the heartbeat seam this producer calls.
 * Absent and foreign values answer false instead of throwing.
 * @param value - the value read from `ctx.get('evolutionHeartbeat')`.
 * @returns whether the value can register a task.
 */
function isHeartbeatSeam(value: unknown): value is HeartbeatSeam {
  return typeof Reflect.get(Object(value), 'register') === 'function'
}

/**
 * The slice of `ctx.workspaceRegistry` this producer reads: the workspace
 * roster and, per entry, the id its scope is keyed by and the sessions it
 * owns. Declared here rather than imported so the graph keeps no dependency on
 * the workspace package.
 */
interface WorkspaceSeam {
  /**
   * @returns the workspaces in registry order.
   */
  list(): readonly { id: string; sessionIds: readonly SessionId[] }[]
}

/**
 * Whether a context value offers the workspace roster this producer reads.
 * Absent and foreign values answer false instead of throwing.
 * @param value - the value read from `ctx.get('workspaceRegistry')`.
 * @returns whether the value publishes a workspace roster.
 */
function isWorkspaceSeam(value: unknown): value is WorkspaceSeam {
  return typeof Reflect.get(Object(value), 'list') === 'function'
}

/**
 * One live session's route source, as this producer reads it.
 */
interface SessionRouteSource {
  /**
   * @returns the route the session's latest request ran on, or undefined when it has made none.
   */
  requestHeader(): { config: { provider: string; model: string } } | undefined
}

/**
 * The slice of `ctx.sessions` this producer reads: the live session a buffered
 * batch asks for its request route. Declared here rather than imported so the
 * graph keeps no dependency on a service it can run without, and read through
 * `ctx.get` rather than `ctx.sessions` so a mount that provides none resolves
 * no route instead of throwing out of the sweep.
 */
interface SessionsSeam {
  /**
   * @param id - the session to look up.
   * @returns the live session, or undefined when none holds that id.
   */
  get(id: SessionId): SessionRouteSource | undefined
}

/**
 * Whether a context value offers the session lookup this producer reads.
 * Absent and foreign values answer false instead of throwing.
 * @param value - the value read from `ctx.get('sessions')`.
 * @returns whether the value can look a session up.
 */
function isSessionsSeam(value: unknown): value is SessionsSeam {
  return typeof Reflect.get(Object(value), 'get') === 'function'
}

/** One scope's unextracted text and the sessions it was observed in. */
interface PendingScope {
  /** Scope identity the batch will be extracted into. */
  scope: EvolutionScopeId
  /** Sessions the batch's text came from, in first-seen order. */
  sessionIds: SessionId[]
  /** Buffered message texts, oldest first. */
  texts: string[]
  /** Total UTF-8 size of `texts`. */
  bytes: number
}

/**
 * Durable per-scope knowledge graph. Opens the `evolution_graph` domain at
 * init, closes it through `ctx.effect`, and registers the heartbeat task that
 * extracts the scopes it has buffered text for.
 */
export class EvolutionGraph extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, GraphRecord>
  private readonly resolved: ResolvedConfig
  private readonly pending = new Map<string, PendingScope>()

  /**
   * @param ctx - Host context carrying the storage domain.
   * @param config - caps, query bounds, extraction cadence, and the extraction route.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionGraph')
    this.resolved = resolveConfig(config)
  }

  /**
   * Open the domain, publish the table handle, start buffering session text,
   * and register the extraction task when a heartbeat engine is mounted.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(graphDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-graph.domainClose')
    this.table = domain.table('records')
    this.ctx.on('session/event', (session, event) => {
      this.bufferEvent(session.id, event)
    })
    this.ctx.effect(() => () => {
      this.pending.clear()
    }, 'evolution-graph.pendingText')
    const heartbeat: unknown = this.ctx.get('evolutionHeartbeat')
    if (!isHeartbeatSeam(heartbeat)) return
    this.ctx.effect(
      () => heartbeat.register({
        name: EVOLUTION_GRAPH_EXTRACT_TASK,
        intervalHours: this.resolved.intervalHours,
        run: (signal: AbortSignal) => this.extractPending(signal),
      }),
      'evolution-graph.heartbeatTask',
    )
  }

  /**
   * Read one scope's graph.
   * @param scopeId - scope identity.
   * @returns a detached copy, or undefined when the scope has no graph.
   */
  read(scopeId: EvolutionScopeId): GraphRecord | undefined {
    const found = this.requireTable().get(storageKey(scopeId))
    return found === undefined ? undefined : structuredClone(found)
  }

  /**
   * Merge extracted triples into one scope's graph. An entity seen again keeps
   * its first label and gains a kind if it had none; a relation seen again
   * raises its count instead of adding a second edge. Triples are dropped, not
   * thrown on, once a cap is reached or a part normalizes to nothing, and the
   * count of dropped triples is reported back.
   * @param scopeId - scope identity.
   * @param triples - relations to record.
   * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
   * @returns what the batch added, reinforced, and dropped.
   */
  async observe(
    scopeId: EvolutionScopeId,
    triples: readonly GraphTriple[],
    now: string = new Date().toISOString(),
  ): Promise<GraphObserveResult> {
    const current = this.requireTable().get(storageKey(scopeId))
    const record: GraphRecord = current === undefined
      ? { nodes: [], edges: [], updatedAt: now }
      : structuredClone(current)
    const nodes = new Map(record.nodes.map(node => [node.id, node] as const))
    const edges = new Map(record.edges.map(edge => [edgeKey(edge.from, edge.relation, edge.to), edge] as const))
    const result: GraphObserveResult = { addedNodes: 0, addedEdges: 0, reinforcedEdges: 0, skipped: 0 }
    for (const triple of triples) {
      const from = normalizeNodeId(triple.from)
      const to = normalizeNodeId(triple.to)
      const relation = normalizeRelation(triple.relation)
      if (from === '' || to === '' || relation === '') {
        result.skipped += 1
        continue
      }
      const fresh = [from, to].filter(id => !nodes.has(id))
      if (nodes.size + fresh.length > this.resolved.maxNodes) {
        result.skipped += 1
        continue
      }
      if (upsertNode(nodes, from, triple.from, triple.fromKind ?? null)) result.addedNodes += 1
      if (upsertNode(nodes, to, triple.to, triple.toKind ?? null)) result.addedNodes += 1
      const key = edgeKey(from, relation, to)
      const existing = edges.get(key)
      if (existing === undefined) {
        if (edges.size + 1 > this.resolved.maxEdges) {
          result.skipped += 1
          continue
        }
        edges.set(key, { from, relation, to, firstAt: now, lastAt: now, count: 1 })
        result.addedEdges += 1
        continue
      }
      edges.set(key, { ...existing, count: existing.count + 1, lastAt: now })
      result.reinforcedEdges += 1
    }
    await this.write(scopeId, { nodes: [...nodes.values()], edges: [...edges.values()], updatedAt: now })
    return result
  }

  /**
   * Answer one relation query by traversing outward from a subject.
   * @param scopeId - scope identity.
   * @param subject - subject label, matched by normalized identity.
   * @param relation - relation name, matched by normalized identity.
   * @param limit - maximum objects returned, capped by `maxQueryLimit`.
   * @returns the resolved answer, or undefined when the subject is unknown.
   */
  answer(
    scopeId: EvolutionScopeId,
    subject: string,
    relation: string,
    limit: number = this.resolved.maxQueryLimit,
  ): GraphAnswer | undefined {
    const record = this.requireTable().get(storageKey(scopeId))
    if (record === undefined) return undefined
    const id = normalizeNodeId(subject)
    const node = record.nodes.find(candidate => candidate.id === id)
    if (node === undefined) return undefined
    const wanted = normalizeRelation(relation)
    const byId = new Map(record.nodes.map(candidate => [candidate.id, candidate] as const))
    const matched = record.edges
      .filter(edge => edge.from === id && edge.relation === wanted)
      .sort((left, right) => right.count - left.count || left.to.localeCompare(right.to))
    const objects: GraphNode[] = []
    for (const edge of matched) {
      const target = byId.get(edge.to)
      /* v8 ignore next -- observe creates both endpoints with every edge, so a traversal cannot read a dangling one. */
      if (target === undefined) continue
      objects.push(target)
      if (objects.length >= Math.min(limit, this.resolved.maxQueryLimit)) break
    }
    return { subject: node, relation: wanted, objects }
  }

  /**
   * Expand the neighborhood of one entity breadth-first, in both directions,
   * so a caller can navigate connections instead of naming a relation.
   * @param scopeId - scope identity.
   * @param subject - subject label, matched by normalized identity.
   * @param depth - maximum hops, at least 1.
   * @param limit - maximum reached entities, capped by `maxQueryLimit`.
   * @returns the reached entities, origin first, or an empty list when unknown.
   */
  expand(
    scopeId: EvolutionScopeId,
    subject: string,
    depth: number = 1,
    limit: number = this.resolved.maxQueryLimit,
  ): GraphReach[] {
    const record = this.requireTable().get(storageKey(scopeId))
    if (record === undefined) return []
    const id = normalizeNodeId(subject)
    const byId = new Map(record.nodes.map(node => [node.id, node] as const))
    const origin = byId.get(id)
    if (origin === undefined) return []
    const cap = Math.min(limit, this.resolved.maxQueryLimit)
    const hops = Math.max(1, Math.floor(depth))
    const reached: GraphReach[] = [{ node: origin, path: [], depth: 0 }]
    const seen = new Set([id])
    let frontier: { id: string; path: string[] }[] = [{ id, path: [] }]
    for (let level = 1; level <= hops && reached.length < cap; level += 1) {
      const next: { id: string; path: string[] }[] = []
      for (const current of frontier) {
        for (const edge of record.edges) {
          const step = edge.from === current.id
            ? { to: edge.to, relation: edge.relation }
            : edge.to === current.id ? { to: edge.from, relation: edge.relation } : undefined
          if (step === undefined || seen.has(step.to)) continue
          const node = byId.get(step.to)
          /* v8 ignore next -- observe creates both endpoints with every edge, so a traversal cannot read a dangling one. */
          if (node === undefined) continue
          seen.add(step.to)
          const path = [...current.path, step.relation]
          reached.push({ node, path, depth: level })
          next.push({ id: step.to, path })
          if (reached.length >= cap) break
        }
        if (reached.length >= cap) break
      }
      frontier = next
    }
    return reached
  }

  /**
   * Find entities whose label contains a query, most-connected first.
   * @param scopeId - scope identity.
   * @param query - case-insensitive label substring; empty matches every node.
   * @param limit - maximum entities returned, capped by `maxQueryLimit`.
   * @returns the matching entities.
   */
  find(
    scopeId: EvolutionScopeId,
    query: string,
    limit: number = this.resolved.maxQueryLimit,
  ): GraphNode[] {
    const record = this.requireTable().get(storageKey(scopeId))
    if (record === undefined) return []
    const needle = query.trim().toLowerCase()
    // Every node starts at zero so a node no edge mentions still ranks, and no
    // lookup below can miss.
    const degree = new Map<string, number>(record.nodes.map(node => [node.id, 0]))
    for (const edge of record.edges) {
      degree.set(edge.from, (degree.get(edge.from) as number) + edge.count)
      degree.set(edge.to, (degree.get(edge.to) as number) + edge.count)
    }
    return record.nodes
      .filter(node => needle === '' || node.label.toLowerCase().includes(needle))
      .sort((left, right) => (degree.get(right.id) as number) - (degree.get(left.id) as number) || left.id.localeCompare(right.id))
      .slice(0, Math.min(limit, this.resolved.maxQueryLimit))
  }

  /**
   * Extract relations from text and merge them. One `temperature: 0` call
   * returns JSON, which is validated here before anything is stored: a
   * malformed answer rejects rather than storing a partial graph.
   * @param scopeId - scope identity.
   * @param text - source text to read relations from.
   * @param route - provider and model to call.
   * @param signal - caller cancellation.
   * @returns what the extraction observed and merged.
   */
  async extract(
    scopeId: EvolutionScopeId,
    text: string,
    route: { provider: string; model: string },
    signal: AbortSignal,
  ): Promise<GraphExtractResult> {
    using callDeadline = deadline(signal, this.resolved.timeoutMs, EVOLUTION_GRAPH_TIMEOUT)
    const clipped = truncateUtf8(text, this.resolved.maxInputBytes)
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: clipped }],
        source: { kind: 'plugin', plugin: 'dsh-evolution-graph' },
      })],
      system: extractionSystemPrompt(),
      maxTokens: this.resolved.maxOutputTokens,
      temperature: 0,
      purpose: 'evolution-review',
      signal: callDeadline.signal,
    }
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`evolution-graph: extraction failed: ${finish.failure.message}`)
    }
    const blocks = assembler.blocks()
    if (blocks.some(block => block.type === 'tool-call')) {
      throw new Error('evolution-graph: extraction must return text only')
    }
    const answer = blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
    const triples = parseTriples(answer)
    const merged = await this.observe(scopeId, triples)
    return { ...merged, observed: triples.length }
  }

  /**
   * Buffer one observed message's text under the scope that owns its session.
   * Only user and assistant messages carry conversation text: anything else, a
   * message with no text part, a session no workspace owns, and a mount with
   * no workspace roster are all ignored. Text is appended while it fits the
   * `maxInputBytes` budget, dropping the oldest text to make room.
   *
   * A message larger than the whole budget can never be carried, so it is
   * dropped whole — and it never opens an entry of its own: an entry with no
   * text would still resolve a route and pay for an empty call on every run.
   * @param sessionId - the session the event was published from.
   * @param event - the session event to read text from.
   */
  private bufferEvent(sessionId: SessionId, event: SessionEvent): void {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') return
    const message = event.type === 'user/message' ? event.data : event.data.message
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text === '') return
    const registry: unknown = this.ctx.get('workspaceRegistry')
    if (!isWorkspaceSeam(registry)) return
    const workspace = registry.list().find(entry => entry.sessionIds.includes(sessionId))
    if (workspace === undefined) return
    const scope = EvolutionScopeId(this.resolved.profile, workspace.id)
    const size = utf8Bytes(text)
    if (size > this.resolved.maxInputBytes) return
    const key = String(scope)
    const buffered = this.pending.get(key) ?? { scope, sessionIds: [], texts: [], bytes: 0 }
    this.pending.set(key, buffered)
    if (!buffered.sessionIds.includes(sessionId)) buffered.sessionIds.push(sessionId)
    // This text fits the budget on its own, so emptying the batch always
    // satisfies the bound and the loop never reads past its oldest entry.
    while (buffered.bytes + size > this.resolved.maxInputBytes) {
      buffered.bytes -= utf8Bytes(buffered.texts.shift() as string)
    }
    buffered.texts.push(text)
    buffered.bytes += size
  }

  /**
   * Extract and clear every scope with buffered text. Scopes are visited
   * oldest-buffered first and the sweep stops between them when its signal
   * aborts — and the abort joins the failures, so an aborted run reports its
   * aggregated error instead of resolving as a success that spent batches.
   * A scope whose route cannot be resolved, or a mount with no model
   * seam at all, keeps its buffer for a later run instead of spending it.
   *
   * A scope's batch leaves the buffer before its call is awaited, not after:
   * text published while that call is in flight appends to a fresh entry and
   * is picked up by the next run, where clearing the entry afterwards would
   * have dropped it unseen. A call that fails is caught and leaves the batch
   * spent — one bad scope must not starve the others, and the batch is
   * delivered at most once rather than retried forever. The failures are kept
   * and rethrown as one aggregated error once the sweep is over, so the
   * heartbeat stamps the run failed and warns instead of recording a silent
   * success that discarded everything it could not extract.
   * @param signal - the heartbeat's cancellation signal.
   */
  private async extractPending(signal: AbortSignal): Promise<void> {
    if (this.ctx.get('llm') === undefined) return
    const failures: string[] = []
    for (const [key, buffered] of [...this.pending]) {
      if (signal.aborted) {
        failures.push(`${key}: run aborted`)
        break
      }
      const route = this.resolveRoute(buffered.sessionIds)
      if (route === undefined) continue
      const text = buffered.texts.join('\n')
      this.pending.delete(key)
      try {
        await this.extract(buffered.scope, text, route, signal)
      } catch (error) {
        // Isolation without silence: the sweep continues, and this scope's
        // cause travels back to the caller with every other one.
        failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`evolution-graph: extraction failed for ${failures.length} scope(s): ${failures.join('; ')}`)
    }
  }

  /**
   * Resolve the route one buffered scope extracts through: the configured
   * pair when the composition names one, else the request route of the first
   * of its sessions that can report one.
   * @param sessionIds - sessions the buffered batch was observed in.
   * @returns the route to call, or undefined when neither source names one.
   */
  private resolveRoute(sessionIds: readonly SessionId[]): { provider: string; model: string } | undefined {
    if (this.resolved.provider !== undefined && this.resolved.model !== undefined) {
      return { provider: this.resolved.provider, model: this.resolved.model }
    }
    const sessions: unknown = this.ctx.get('sessions')
    if (!isSessionsSeam(sessions)) return undefined
    const header = sessionIds
      .map(id => sessions.get(id)?.requestHeader())
      .find(entry => entry !== undefined)
    return header === undefined
      ? undefined
      : { provider: header.config.provider, model: header.config.model }
  }

  /** Replace one scope's graph, seeding it on the first write. */
  private async write(scopeId: EvolutionScopeId, record: GraphRecord): Promise<void> {
    const table = this.requireTable()
    const key = storageKey(scopeId)
    if (table.get(key) === undefined) {
      await table.put(key, structuredClone(record))
      return
    }
    await table.update(key, () => structuredClone(record))
  }

  private requireTable(): KvTable<string, GraphRecord> {
    if (this.table === undefined) throw new Error('evolution graph is not started yet')
    return this.table
  }
}

/**
 * The extraction contract: JSON only, one object with a `triples` array.
 * @returns the fixed instruction text.
 */
export function extractionSystemPrompt(): string {
  return [
    'You extract a knowledge graph from text.',
    'Reply with JSON only, no prose and no code fence, in exactly this form:',
    '{"triples":[{"from":"entity","relation":"relation_name","to":"entity","fromKind":"kind","toKind":"kind"}]}',
    'Rules:',
    '- Entities are the named things the text is about; keep their names as written.',
    '- Relations are short lower snake_case verbs or nouns, such as worked_on, uses, depends_on.',
    '- Read a relation only when the text states it; never infer one.',
    '- Omit credentials, tokens, personal health data, and anything about race, religion, politics, or gender identity.',
    '- With nothing to record, reply {"triples":[]}.',
  ].join('\n')
}

/**
 * Decode one extraction answer. The model output is a wire boundary, so every
 * field is validated here: an unreadable answer throws and nothing is stored.
 * @param raw - the model's text.
 * @returns the accepted triples.
 */
export function parseTriples(raw: string): GraphTriple[] {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let decoded: unknown
  try {
    decoded = JSON.parse(unfenced)
  } catch {
    throw new Error('evolution-graph: extraction did not return JSON')
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('evolution-graph: extraction did not return a JSON object')
  }
  const { triples } = decoded as { triples?: unknown }
  if (!Array.isArray(triples)) throw new Error('evolution-graph: extraction returned no triples array')
  const accepted: GraphTriple[] = []
  for (const entry of triples as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const { from, relation, to, fromKind, toKind } = entry as Record<string, unknown>
    if (typeof from !== 'string' || typeof relation !== 'string' || typeof to !== 'string') continue
    accepted.push({
      from,
      relation,
      to,
      fromKind: typeof fromKind === 'string' ? fromKind : null,
      toKind: typeof toKind === 'string' ? toKind : null,
    })
  }
  return accepted
}

export default EvolutionGraph
