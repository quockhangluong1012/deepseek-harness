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
  // Written since the `failureCount`/`lastOutcome` counters landed, and
  // declared here because the domain re-parses every record it opens: a
  // schema without them drops both counters on the next start, which is what
  // the curator's failure-rate rule and §22's failure-spike signal read.
  failureCount: z.number().int().nonnegative().optional(),
  lastOutcome: z.enum(['ok', 'failed']).optional(),
  sessionIds: z.array(z.string()).default([]),
  sessionOutcomes: z.array(z.object({
    sessionId: z.string(),
    outcome: z.enum(['ok', 'failed']),
  })).default([]),
  lastViewedAt: z.string().nullable(),
  lastPatchedAt: z.string().nullable(),
  createdAt: z.string(),
  // `suspect` arrives with the §22 evidence rung; a committed record carries a
  // state already, and a record written before the member existed opens as
  // `active` rather than failing the domain open.
  state: z.enum(['active', 'suspect', 'stale', 'archived']).default('active'),
  pinned: z.boolean(),
  createdBy: z.enum(['agent', 'foreground']).nullable(),
  absorbedInto: z.string().nullable(),
  archivedAt: z.string().nullable(),
  // Records written before the evidence rung existed are `active` and carry no
  // suspect instant, so the default keeps them open unchanged.
  suspectAt: z.string().nullable().default(null),
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
