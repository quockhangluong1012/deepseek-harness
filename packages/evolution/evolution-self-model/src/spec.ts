/**
 * The evolution-self-model domain declaration: durable per-skill
 * self-assessments and per-capability pass-rate entries. Zod validates the
 * shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-self-model/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CapabilityEntry, SelfModel } from './types.ts'

/** Durable shape of one skill self-assessment. */
export const selfModelRow = z.object({
  skill: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  uncertainAreas: z.array(z.string()),
  failureModes: z.array(z.string()),
  preferredTools: z.array(z.string()),
  evaluatorBlindspots: z.array(z.string()),
  confidence: z.number(),
  revision: z.number(),
  at: z.string(),
})

/** Durable shape of one capability entry. */
export const capabilityEntryRow = z.object({
  capability: z.string(),
  score: z.number(),
  confidence: z.number(),
  failures: z.array(z.string()),
  coveringSkills: z.array(z.string()),
  observations: z.number(),
  at: z.string(),
})

/** One stored assessment, inferred from {@link selfModelRow}. */
export type SelfModelRow = z.infer<typeof selfModelRow>

/** One stored capability entry, inferred from {@link capabilityEntryRow}. */
export type CapabilityEntryRow = z.infer<typeof capabilityEntryRow>

/**
 * The evolution-self-model domain spec: a `models` table keyed by skill and
 * a `capabilities` table keyed by capability name. `per-record` because
 * assessments and entries are independent. Invalid rows fail the domain open
 * loudly: the self-model steers what the loop learns next.
 */
export const selfModelDomainSpec = defineDomain({
  name: 'evolution_selfmodel',
  version: 1,
  layout: 'per-record',
  tables: {
    models: domainTable<string, SelfModel>(selfModelRow),
    capabilities: domainTable<string, CapabilityEntry>(capabilityEntryRow),
  },
})
