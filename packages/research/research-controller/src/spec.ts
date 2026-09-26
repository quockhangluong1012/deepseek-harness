/**
 * The research domain declaration: the durable run record and the
 * `defineDomain` spec the controller opens. Zod validates the shipped format
 * at the durability boundary. A field a stage has not filled is stored as
 * `null`, never omitted, so a stored run round-trips exactly.
 * @module @deepseek-ai/dsh-research-controller/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ResearchRunId, ResearchRunRecord } from './types.ts'

/** Every stage of the loop at the durable boundary. */
const stage = z.enum([
  'question',
  'decompose',
  'research-plan',
  'search',
  'source-triage',
  'claim-extraction',
  'evidence',
  'contradiction-search',
  'synthesis',
  'epistemic-review',
])

/** One answer statement at the durable boundary. */
const answerStatement = z.object({
  statement: z.string().min(1),
  claims: z.array(z.string()),
})

/** The six epistemic buckets of a final answer at the durable boundary. */
const answer = z.object({
  documented: z.array(answerStatement),
  observation: z.array(answerStatement),
  interpretation: z.array(answerStatement),
  inference: z.array(answerStatement),
  hypothesis: z.array(answerStatement),
  unresolved: z.array(answerStatement),
})

/** One stage's durable state. */
const stageRecord = z.object({
  stage,
  status: z.enum(['pending', 'produced', 'failed']),
  output: z.array(z.string()),
  evidence: z.array(z.string()),
  claims: z.array(z.string()),
  provider: z.string().nullable(),
  startedAt: z.string(),
  settledAt: z.string().nullable(),
  failure: z.string().nullable(),
})

/**
 * Durable shape of one research run. Invalid records fail the domain open
 * loudly: a run whose stage order or answer buckets are unreadable would let a
 * consumer treat an unsettled answer as settled.
 */
export const researchRun = z.object({
  runId: z.string().min(1),
  sessionId: z.string(),
  taskId: z.string(),
  taskClass: z.enum(['conversational', 'coding', 'research', 'operations']),
  question: z.string(),
  stages: z.array(stageRecord),
  answer: answer.nullable(),
  startedAt: z.string(),
  settledAt: z.string().nullable(),
})

/** One stored run, inferred from {@link researchRun}. */
export type ResearchRunRow = z.infer<typeof researchRun>

/**
 * The research domain spec: one `runs` table keyed by `ResearchRunId`.
 * `per-record` because runs are independent.
 */
export const researchDomainSpec = defineDomain({
  name: 'research',
  version: 1,
  layout: 'per-record',
  tables: {
    runs: domainTable<ResearchRunId, ResearchRunRecord>(researchRun),
  },
})
