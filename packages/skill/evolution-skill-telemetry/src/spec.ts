/**
 * The evolution-skill-telemetry domain declaration: record schema and the
 * `defineDomain` spec the store opens. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-skill-telemetry/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SkillUsageRecord, SkillVersion } from './types.ts'

/**
 * Durable shape of one skill-usage record. Compatible reshapes add an
 * optional or defaulted field, never a version bump.
 */
export const skillUsageRecord = z.object({
  useCount: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
  patchCount: z.number().int().nonnegative(),
  lastUsedAt: z.string().nullable(),
  sessionIds: z.array(z.string()).default([]),
  lastViewedAt: z.string().nullable(),
  lastPatchedAt: z.string().nullable(),
  createdAt: z.string(),
  state: z.enum(['active', 'stale', 'archived']),
  pinned: z.boolean(),
  createdBy: z.enum(['agent', 'foreground']).nullable(),
  absorbedInto: z.string().nullable(),
  archivedAt: z.string().nullable(),
  trust: z.enum(['provisional', 'trusted']).default('trusted'),
  trustFailures: z.number().int().nonnegative().default(0),
  trustObservedSessions: z.array(z.string()).default([]),
  trustAnchorSessionId: z.string().nullable().default(null),
  lastTrustFailure: z.object({ mergeKey: z.string(), message: z.string(), at: z.string() }).nullable().default(null),
  revision: z.number().int().nonnegative().default(0),
  contentSha: z.string().nullable().default(null),
  parentRevisionSha: z.string().nullable().default(null),
})

/** One stored record, inferred from {@link skillUsageRecord}. */
export type SkillUsageRecordRow = z.infer<typeof skillUsageRecord>

/**
 * Durable shape of one committed body revision. The `versions` table is the
 * skill-artifact registry: every body change through the store commits one
 * row, so lineage is queryable without re-reading files.
 */
export const skillVersionRow = z.object({
  name: z.string(),
  revision: z.number().int().nonnegative(),
  contentSha: z.string(),
  parentRevisionSha: z.string().nullable(),
  at: z.string(),
})

/** One stored history row, inferred from {@link skillVersionRow}. */
export type SkillVersionRow = z.infer<typeof skillVersionRow>

/**
 * The evolution-skill-telemetry domain spec: one `records` table keyed by
 * skill name, one `versions` table keyed by `name\0revision` holding the
 * committed body history. `per-record` because skills are independent. Invalid
 * records fail the domain open loudly: counters back curation decisions, not
 * disposable derived data. No global slot, no migration facility.
 */
export const skillUsageDomainSpec = defineDomain({
  name: 'evolution_skill_usage',
  version: 2,
  // Version 1 stored only per-skill records; the versions table arrives empty
  // on first write, so records written before it existed open unchanged.
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    records: domainTable<string, SkillUsageRecord>(
      skillUsageRecord as unknown as z.ZodType<SkillUsageRecord>,
    ),
    versions: domainTable<string, SkillVersion>(skillVersionRow),
  },
})

export type { SkillVersion }

export type { SkillUsageRecord }
