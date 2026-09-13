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
 * @module @deepseek-ai/dsh-evolution-graph
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-llm'
import { EvolutionScopeId, storageKey, truncateUtf8 } from '@deepseek-ai/dsh-evolution-memory'
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
  provider: string | undefined
  model: string | undefined
}

/**
 * Resolve defaults for the optional fields. A half-set extraction route fails
 * loudly: a fork that cannot name a model would otherwise skip silently.
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
    provider,
    model,
  } = config
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('evolution-graph: provider and model must be set together')
  }
  return { maxNodes, maxEdges, maxQueryLimit, maxInputBytes, maxOutputTokens, timeoutMs, provider, model }
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
 * Durable per-scope knowledge graph. Opens the `evolution_graph` domain at
 * init and closes it through `ctx.effect`.
 */
export class EvolutionGraph extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, GraphRecord>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - Host context carrying the storage domain.
   * @param config - caps, query bounds, and the extraction route.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionGraph')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(graphDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-graph.domainClose')
    this.table = domain.table('records')
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
