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
  /** Claims with their evidence, lineage, and belief, in insertion order. */
  claims: readonly Claim[]
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

/** Whether a claim still stands, or a superseding claim retired it. */
export type ClaimStatus = 'active' | 'retired'

/**
 * One source's evidence about one claim. Repeats from a source raise `count`
 * and `lastAt` only: a source attests a claim once no matter how often it is
 * re-read, so evidence can never be multiplied by re-observation.
 */
export interface ClaimEvidence {
  /** Identity of the evidence's source, unique within the claim: a session id, a path, or a label. */
  source: string
  /** Strength of this evidence in [0, 1], fixed at the source's first attestation. */
  quality: number
  /** Trust in this source in [0, 1], fixed at the source's first attestation. */
  reliability: number
  /** ISO-8601 instant this source first attested the claim. */
  firstAt: string
  /** ISO-8601 instant this source last attested it. */
  lastAt: string
  /** Times this source attested it; a repeat never adds independent support. */
  count: number
}

/** Caller-supplied evidence about one claim, before the store fixes its instants. */
export interface ClaimEvidenceInput {
  /** Identity of the evidence's source; an empty source is refused. */
  source: string
  /** Strength in [0, 1], defaulting to `1`: taken at face value. */
  quality?: number
  /** Source trust in [0, 1], defaulting to `1`. */
  reliability?: number
}

/**
 * One asserted fact with its evidence, its lineage, and its belief. `id` is
 * the normalized statement, so the same fact spelled the same way is one
 * claim; a claim's statement never changes, and a corrected statement is a
 * second claim that supersedes the first.
 */
export interface Claim {
  /** Stable identity: the normalized statement, unique within its scope. */
  id: string
  /** Statement as first asserted. */
  statement: string
  /** Whether this claim still stands. */
  status: ClaimStatus
  /** Identity of the claim that retired this one, or null while active. */
  retiredBy: string | null
  /** Belief in [0, 1], derived from the six fields below; never stored alone. */
  confidence: number
  /** Strongest supporting evidence in [0, 1]; `0` with no support. */
  evidenceQuality: number
  /** Most trusted supporting source in [0, 1]; `0` with no support. */
  sourceReliability: number
  /** Distinct sources supporting this claim. */
  independentSupport: number
  /** Distinct sources contradicting this claim. */
  contradictionCount: number
  /** ISO-8601 instant of the newest evidence, or the creation instant with none. */
  recency: string
  /** Supporting evidence, one entry per source. */
  supportedBy: readonly ClaimEvidence[]
  /** Contradicting evidence, one entry per source. */
  contradictedBy: readonly ClaimEvidence[]
  /** Traces the claim was observed in: session ids, which are the identity `dsh-evolution-trace` keys a trace by. */
  observedIn: readonly string[]
  /** Claims this one retires, which are marked `retired` and name it in `retiredBy`. */
  supersedes: readonly string[]
  /** Claims this one was derived from. */
  derivedFrom: readonly string[]
  /** Skills or policies that consume this claim. */
  usedBy: readonly string[]
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 instant of the last evidence or edge change. */
  updatedAt: string
}

/**
 * One claim to record, with the edges its caller knows. Every list is merged
 * into what the claim already holds, so recording the same assertion again
 * adds evidence rather than replacing it.
 */
export interface ClaimAssertion {
  /** Short statement of the fact; blank statements are refused. */
  statement: string
  /** Evidence supporting the claim. */
  supportedBy?: readonly ClaimEvidenceInput[]
  /** Evidence contradicting it. */
  contradictedBy?: readonly ClaimEvidenceInput[]
  /** Traces the claim was observed in: session ids, the identity a trace is keyed by. */
  observedIn?: readonly string[]
  /** Claims this one supersedes, retiring them. */
  supersedes?: readonly string[]
  /** Claims this one derives from. */
  derivedFrom?: readonly string[]
  /** Skills or policies consuming this claim. */
  usedBy?: readonly string[]
}

/** Outcome of one recorded claim batch. */
export interface ClaimObserveResult {
  /** Claims this batch created. */
  added: number
  /** Claims that already existed and gained evidence or edges. */
  updated: number
  /** Claims this batch retired through `supersedes`. */
  retired: number
  /** Assertions dropped because their statement was blank or the cap was reached. */
  skipped: number
}
