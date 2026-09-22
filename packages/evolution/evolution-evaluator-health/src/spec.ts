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
  at: z.string(),
})

/** One stored verdict, inferred from {@link evaluatorRunRow}. */
export type EvaluatorRunRow = z.infer<typeof evaluatorRunRow>

/**
 * The evolution-evaluator-health domain spec: one `runs` table keyed by
 * verdict identity. `per-record` because verdicts are independent. Invalid
 * rows fail the domain open loudly: health facts back evaluator decisions, not
 * disposable derived data.
 */
export const evaluatorHealthDomainSpec = defineDomain({
  name: 'evolution_evaluator_health',
  version: 1,
  layout: 'per-record',
  tables: {
    runs: domainTable<string, EvaluatorRun>(evaluatorRunRow),
  },
})
