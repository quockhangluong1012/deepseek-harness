/**
 * Public vocabulary of the evolution knowledge graph: entity nodes, directed
 * relations, one extracted triple, and the traversal results a caller reads.
 * @module @deepseek-ai/dsh-evolution-graph/src/types
 */

/** One entity in a scope's knowledge graph. */
export interface GraphNode {
  /** Stable identity: the normalized label, unique within its scope. */
  id: string
  /** Label as first observed. */
  label: string
  /** Entity kind as extracted, or null when the extractor classified none. */
  kind: string | null
}

/** One directed relation between two entities. */
export interface GraphEdge {
  /** Source node identity. */
  from: string
  /** Relation name, normalized to lower snake case. */
  relation: string
  /** Target node identity. */
  to: string
  /** ISO-8601 instant this relation was first observed. */
  firstAt: string
  /** ISO-8601 instant this relation was most recently observed. */
  lastAt: string
  /** Times this exact relation was observed. */
  count: number
}

/** Durable knowledge graph for one scope. */
export interface GraphRecord {
  /** Entity nodes, in insertion order. */
  nodes: readonly GraphNode[]
  /** Directed relations, in insertion order. */
  edges: readonly GraphEdge[]
  /** ISO-8601 instant of the last write. */
  updatedAt: string
}

/** One relation to record, as extracted or as a caller supplies it. */
export interface GraphTriple {
  /** Source entity label. */
  from: string
  /** Relation name. */
  relation: string
  /** Target entity label. */
  to: string
  /** Source entity kind, when the caller knows it. */
  fromKind?: string | null
  /** Target entity kind, when the caller knows it. */
  toKind?: string | null
}

/** Entities related to one subject through one relation. */
export interface GraphAnswer {
  /** The resolved subject node. */
  subject: GraphNode
  /** The traversed relation. */
  relation: string
  /** Resolved objects, most-observed relation first. */
  objects: GraphNode[]
}

/** One reachable entity in a breadth-first expansion. */
export interface GraphReach {
  /** The reached node. */
  node: GraphNode
  /** Relation names on the path from the origin, in traversal order. */
  path: readonly string[]
  /** Hops from the origin; the origin itself is `0`. */
  depth: number
}

/** Deployment choices for the knowledge graph store. */
export interface GraphLimits {
  /** Nodes retained per scope; further distinct entities are refused. */
  maxNodes: number
  /** Relations retained per scope; further distinct relations are refused. */
  maxEdges: number
}

