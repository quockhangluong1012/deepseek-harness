/**
 * The evolution-graph domain declaration: durable per-scope nodes and edges.
 * Zod validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-graph/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { GraphRecord } from './types.ts'

/** One entity node at the durable boundary. */
export const graphNode = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string().nullable(),
})

/** One directed relation at the durable boundary. */
export const graphEdge = z.object({
  from: z.string(),
  relation: z.string(),
  to: z.string(),
  firstAt: z.string(),
  lastAt: z.string(),
  count: z.number().int().nonnegative(),
})

/** One source's evidence about one claim at the durable boundary. */
export const claimEvidence = z.object({
  source: z.string(),
  quality: z.number().min(0).max(1),
  reliability: z.number().min(0).max(1),
  firstAt: z.string(),
  lastAt: z.string(),
  count: z.number().int().min(1),
})

/** One claim with its evidence, lineage, and belief at the durable boundary. */
export const claim = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  status: z.enum(['active', 'retired']),
  retiredBy: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  evidenceQuality: z.number().min(0).max(1),
  sourceReliability: z.number().min(0).max(1),
  independentSupport: z.number().int().min(0),
  contradictionCount: z.number().int().min(0),
  recency: z.string(),
  supportedBy: z.array(claimEvidence),
  contradictedBy: z.array(claimEvidence),
  observedIn: z.array(z.string()),
  supersedes: z.array(z.string()),
  derivedFrom: z.array(z.string()),
  usedBy: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * Durable per-scope knowledge graph at the durable boundary. `claims` is
 * defaulted because the claim layer landed after records were already
 * written: a graph stored as nodes and edges alone opens unchanged instead of
 * failing its schema.
 */
export const graphRecordSchema = z.object({
  nodes: z.array(graphNode),
  edges: z.array(graphEdge),
  claims: z.array(claim).default([]),
  updatedAt: z.string(),
})

/** One stored record, inferred from {@link graphRecordSchema}. */
export type GraphRecordRow = z.infer<typeof graphRecordSchema>

/**
 * The evolution-graph domain spec: one `records` table keyed by scope.
 * Invalid records fail the domain open loudly: a lost edge count would
 * silently reorder which relation a traversal treats as strongest.
 */
export const graphDomainSpec = defineDomain({
  name: 'evolution_graph',
  version: 1,
  layout: 'per-record',
  tables: {
    records: domainTable<string, GraphRecord>(graphRecordSchema),
  },
})
