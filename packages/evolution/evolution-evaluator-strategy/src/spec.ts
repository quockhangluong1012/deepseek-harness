/**
 * The evolution-evaluator-strategy domain declaration: durable per-evaluator
 * and per-task-class trust statistics. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-evaluator-strategy/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { EvaluatorStrategy } from './types.ts'

/** Durable shape of one evaluator's strategy statistics. */
export const evaluatorStrategyRow = z.object({
  evaluator: z.string(),
  taskClass: z.string(),
  samples: z.number(),
  independentSamples: z.number(),
  corroborations: z.number(),
  weight: z.number(),
  lastAt: z.string(),
})

/** One stored statistics row, inferred from {@link evaluatorStrategyRow}. */
export type EvaluatorStrategyRow = z.infer<typeof evaluatorStrategyRow>

/**
 * The evolution-evaluator-strategy domain spec: a `strategies` table keyed by
 * evaluator and task class joined. `per-record` because each
 * evaluator/class pair is independent. Invalid rows fail the domain open
 * loudly: the weight ranking trusts the numbers it reads.
 */
export const evaluatorStrategyDomainSpec = defineDomain({
  name: 'evolution_evaluator_strategy',
  version: 1,
  layout: 'per-record',
  tables: {
    strategies: domainTable<string, EvaluatorStrategy>(evaluatorStrategyRow),
  },
})