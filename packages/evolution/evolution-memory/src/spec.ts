/**
 * The evolution-memory domain declaration: record schema and the
 * `defineDomain` spec the store opens. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-memory/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  EvolutionContextItem,
  EvolutionExtraction,
  EvolutionMemoryRecord,
  EvolutionOutput,
  EvolutionScopeId,
  StagedResolution,
  StagedWrite,
} from './types.ts'

/** Shared shape of one context item identity: label, observed size, and instant. */
const contextItemIdentity = {
  id: z.string(),
  label: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  addedAt: z.string(),
}

/** One attached context item at the durable boundary. */
export const evolutionContextItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string(), ...contextItemIdentity }),
  z.object({ kind: z.literal('file'), path: z.string(), ...contextItemIdentity }),
])

/** One produced-file index entry at the durable boundary. */
export const evolutionOutput = z.object({
  path: z.string(),
  tool: z.string(),
  sessionId: z.string(),
  at: z.string(),
})

/** Extraction provenance at the durable boundary. */
export const evolutionExtraction = z.object({
  at: z.string(),
  sessionId: z.string(),
  provider: z.string(),
  model: z.string(),
  origin: z.enum(['foreground', 'background_review', 'user-edit', 'rebuild']),
  inputBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

/**
 * JSON payload of one staged write. `z.json()` enforces the lossless JSON
 * boundary the record must round-trip through; the store reuses this same
 * declaration to refuse a non-JSON payload at the write boundary.
 */
export const stagedWritePayload = z.json()

/** One staged write at the durable boundary. */
export const stagedWrite = z.object({
  id: z.string(),
  kind: z.enum(['memory', 'skill']),
  op: z.string(),
  payload: stagedWritePayload,
  originSessionId: z.string(),
  createdAt: z.string(),
  gist: z.string(),
})

/** One decided staged entry at the durable boundary. */
export const stagedResolution = z.object({
  id: z.string(),
  kind: z.enum(['memory', 'skill']),
  op: z.string(),
  gist: z.string(),
  decision: z.enum(['approved', 'rejected']),
  at: z.string(),
  originSessionId: z.string(),
})

/**
 * Durable shape of one evolution-memory record. Compatible reshapes add an
 * optional or defaulted field, never a version bump.
 */
export const evolutionMemoryRecord = z.object({
  instructions: z.string(),
  agentLessons: z.string(),
  userProfile: z.string(),
  instructionsUpdatedAt: z.string().nullable().default(null),
  lessonsUpdatedAt: z.string().nullable().default(null),
  profileUpdatedAt: z.string().nullable().default(null),
  memoryUpdatedAt: z.string().nullable(),
  contextItems: z.array(evolutionContextItem),
  outputs: z.array(evolutionOutput),
  lastExtraction: evolutionExtraction.nullable(),
  staged: z.array(stagedWrite),
  resolutions: z.array(stagedResolution).default([]),
  updatedAt: z.string(),
})

/** One stored record, inferred from {@link evolutionMemoryRecord}. */
export type EvolutionMemoryRecordRow = z.infer<typeof evolutionMemoryRecord>

/**
 * The evolution-memory domain spec: one `records` table keyed by scope id.
 * `per-record` because scopes are independent. Invalid records fail the
 * domain open loudly: instructions are user-authored, not disposable derived
 * data. No global slot, no migration facility.
 */
export const evolutionMemoryDomainSpec = defineDomain({
  name: 'evolution_memory',
  version: 1,
  layout: 'per-record',
  tables: {
    records: domainTable<EvolutionScopeId, EvolutionMemoryRecord>(
      evolutionMemoryRecord as unknown as z.ZodType<EvolutionMemoryRecord>,
    ),
  },
})

export type {
  EvolutionContextItem,
  EvolutionExtraction,
  EvolutionMemoryRecord,
  EvolutionOutput,
  EvolutionScopeId,
  StagedResolution,
  StagedWrite,
}
