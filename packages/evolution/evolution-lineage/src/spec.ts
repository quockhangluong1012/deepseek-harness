/**
 * The evolution-lineage domain declaration: durable dependency-versioned
 * experiment envelopes with their measured triples and outcomes. Zod
 * validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-lineage/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ExperimentEnvelope } from './types.ts'

/** Durable shape of one experiment envelope. */
export const experimentEnvelopeRow = z.object({
  experimentId: z.string(),
  skill: z.string(),
  hypothesis: z.string().optional(),
  candidate: z.string(),
  operator: z.string().optional(),
  tasks: z.array(z.string()),
  metrics: z.object({
    pass: z.boolean(),
    tokens: z.number(),
    wallTimeMs: z.number(),
  }),
  outcome: z.enum(['improved', 'regressed', 'inconclusive']),
  regressions: z.array(z.string()),
  rejectedReason: z.string().optional(),
  lessons: z.string().optional(),
  dependencies: z.object({
    prompt: z.string().optional(),
    skill: z.string().optional(),
    retriever: z.string().optional(),
    evaluator: z.string().optional(),
    model: z.string().optional(),
    tool: z.string().optional(),
    env: z.string().optional(),
  }),
  seeds: z.array(z.number()),
  at: z.string(),
})

/** One stored envelope, inferred from {@link experimentEnvelopeRow}. */
export type ExperimentEnvelopeRow = z.infer<typeof experimentEnvelopeRow>

/**
 * The evolution-lineage domain spec: one `experiments` table keyed by
 * experiment identity. `per-record` because experiments are independent.
 * Invalid rows fail the domain open loudly: the envelopes drive
 * apples-to-apples comparability decisions.
 */
export const lineageDomainSpec = defineDomain({
  name: 'evolution_lineage',
  version: 1,
  layout: 'per-record',
  tables: {
    experiments: domainTable<string, ExperimentEnvelope>(experimentEnvelopeRow),
  },
})
