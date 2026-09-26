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

/**
 * Durable per-scope knowledge graph at the durable boundary. Zod ignores
 * undeclared keys, so a version-1 record's `claims` array is dropped on read
 * rather than failing the schema.
 */
export const graphRecordSchema = z.object({
  nodes: z.array(graphNode),
  edges: z.array(graphEdge),
  updatedAt: z.string(),
})

/** One stored record, inferred from {@link graphRecordSchema}. */
export type GraphRecordRow = z.infer<typeof graphRecordSchema>

/**
 * The evolution-graph domain spec: one `records` table keyed by scope.
 * Invalid records fail the domain open loudly: a lost edge count would
 * silently reorder which relation a traversal treats as strongest.
 *
 * Version 2 drops the claim layer: `evolution-memory` owns lesson belief
 * (`LessonArtifact`), so the graph keeps entities and relations only. A bare
 * bump would read every stored scope as an absent record, so version 1 is
 * declared compatible; its `claims` rows are dropped on read rather than
 * migrated, and the next write stamps version 2.
 */
export const graphDomainSpec = defineDomain({
  name: 'evolution_graph',
  version: 2,
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    records: domainTable<string, GraphRecord>(graphRecordSchema),
  },
})
