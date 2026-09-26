/**
 * The evolution-lineage domain declaration: durable dependency-versioned
 * experiment envelopes with their measured triples and outcomes. Zod
 * validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-lineage/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ExperimentEnvelope, PolicyRevision } from './types.ts'

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

/** Durable shape of one versioned policy revision. */
export const policyRevisionRow = z.object({
  policy: z.string(),
  version: z.number().int().min(1),
  digest: z.string(),
  parentDigest: z.string().nullable(),
  diff: z.object({
    addedLines: z.number().int().min(0),
    removedLines: z.number().int().min(0),
  }),
  benchmark: z.string().optional(),
  body: z.string(),
  at: z.string(),
})

/** One stored revision, inferred from {@link policyRevisionRow}. */
export type PolicyRevisionRow = z.infer<typeof policyRevisionRow>

/**
 * The evolution-lineage domain spec: one `experiments` table keyed by
 * experiment identity and one `revisions` table keyed by policy identity and
 * revision number. `per-record` because experiments and revisions are
 * independent. Invalid rows fail the domain open loudly: the envelopes drive
 * apples-to-apples comparability decisions, and a dropped revision would break
 * a policy's chain.
 */
export const lineageDomainSpec = defineDomain({
  name: 'evolution_lineage',
  version: 2,
  // Version 1 held only `experiments`; `revisions` arrives empty on first
  // write, so a vouched-for v1 document opens unchanged.
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    experiments: domainTable<string, ExperimentEnvelope>(experimentEnvelopeRow),
    revisions: domainTable<string, PolicyRevision>(policyRevisionRow),
  },
})
