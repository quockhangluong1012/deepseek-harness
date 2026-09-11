/**
 * The workspace-memory domain declaration: record schema and the
 * `defineDomain` spec the store opens. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-workspace-memory/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  WorkspaceContextItem,
  WorkspaceMemoryExtraction,
  WorkspaceMemoryRecord,
  WorkspaceOutput,
} from './types.ts'

/** One attached context item at the durable boundary. */
export const workspaceContextItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    id: z.string(),
    label: z.string(),
    text: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    addedAt: z.string(),
  }),
  z.object({
    kind: z.literal('file'),
    id: z.string(),
    label: z.string(),
    path: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    addedAt: z.string(),
  }),
])

/** One produced-file index entry at the durable boundary. */
export const workspaceOutput = z.object({
  path: z.string(),
  tool: z.string(),
  sessionId: z.string(),
  at: z.string(),
})

/** Extraction provenance at the durable boundary. */
export const workspaceMemoryExtraction = z.object({
  at: z.string(),
  sessionId: z.string(),
  provider: z.string(),
  model: z.string(),
  inputBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

/**
 * Durable shape of one workspace-memory record. Compatible reshapes add an
 * optional or defaulted field, never a version bump.
 */
export const workspaceMemoryRecord = z.object({
  description: z.string(),
  instructions: z.string(),
  memory: z.string(),
  memoryUpdatedAt: z.string().nullable(),
  contextItems: z.array(workspaceContextItem),
  outputs: z.array(workspaceOutput),
  lastExtraction: workspaceMemoryExtraction.nullable(),
  updatedAt: z.string(),
})

/** One stored record, inferred from {@link workspaceMemoryRecord}. */
export type WorkspaceMemoryRecordRow = z.infer<typeof workspaceMemoryRecord>

/**
 * The workspace-memory domain spec: one `records` table keyed by
 * `WorkspaceId`. `per-record` because records are independent. Invalid
 * records fail the domain open loudly: Instructions are user-authored, not
 * disposable derived data. No global slot, no migration facility.
 */
export const workspaceMemoryDomainSpec = defineDomain({
  name: 'workspace_memory',
  version: 1,
  layout: 'per-record',
  tables: {
    records: domainTable<WorkspaceId, WorkspaceMemoryRecord>(
      workspaceMemoryRecord as unknown as z.ZodType<WorkspaceMemoryRecord>,
    ),
  },
})

export type { WorkspaceContextItem, WorkspaceMemoryExtraction, WorkspaceMemoryRecord, WorkspaceOutput }
