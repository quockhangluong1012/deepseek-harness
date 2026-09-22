/**
 * The evolution-evaluator-health domain declaration: durable recorded
 * verdicts. Zod validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-evaluator-health/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { EvaluatorRun } from './types.ts'

/** Durable shape of one recorded verdict. */
export const evaluatorRunRow = z.object({
  id: z.string(),
  skill: z.string(),
  unanimous: z.boolean(),
  status: z.enum(['gated', 'evaluated']),
  approved: z.boolean(),
  approving: z.array(z.string()),
  dissenting: z.array(z.string()),
  // Absent on version-1 verdicts, recorded before ground truths could be attached.
  judgment: z.object({
    agrees: z.boolean(),
    independent: z.boolean(),
    at: z.string(),
  }).nullable().optional(),
  at: z.string(),
})

/** One stored verdict, inferred from {@link evaluatorRunRow}. */
export type EvaluatorRunRow = z.infer<typeof evaluatorRunRow>

/**
 * The evolution-evaluator-health domain spec: one `runs` table keyed by
 * verdict identity. `per-record` because verdicts are independent. Invalid
 * rows fail the domain open loudly: health facts back evaluator decisions, not
 * disposable derived data. Version 2 adds the later ground-truth judgment to a
 * verdict; version-1 verdicts read as unjudged.
 */
export const evaluatorHealthDomainSpec = defineDomain({
  name: 'evolution_evaluator_health',
  version: 2,
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    runs: domainTable<string, EvaluatorRun>(evaluatorRunRow),
  },
})
