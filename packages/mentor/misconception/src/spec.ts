/**
 * The mentor-misconception domain declaration: one durable pipeline per
 * learner and misconception. Zod validates the shipped rows at the durability
 * boundary, because a pipeline that opens wrong steers what a learner is
 * taught next.
 * @module @deepseek-ai/dsh-misconception/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MISCONCEPTION_STAGES } from './pipeline.ts'

/** Durable shape of the exercise one pipeline stage assigned. */
export const exerciseRow = z.object({
  exerciseId: z.string(),
  misconceptionId: z.string(),
  objective: z.string(),
  prompt: z.string(),
})

/** Durable shape of one learner's pipeline for one misconception. */
export const misconceptionPipelineRow = z.object({
  misconceptionId: z.string(),
  learnerId: z.string(),
  patternId: z.string(),
  thesis: z.string(),
  stage: z.enum(MISCONCEPTION_STAGES),
  evidence: z.array(z.string()),
  exercise: exerciseRow.nullable().default(null),
  caseId: z.string().nullable().default(null),
  attempt: z.string().nullable().default(null),
  detectedAt: z.string(),
  updatedAt: z.string(),
})

/** One stored row, inferred from {@link misconceptionPipelineRow}. */
export type MisconceptionPipelineRow = z.infer<typeof misconceptionPipelineRow>

/**
 * The mentor-misconception domain: a `pipelines` table keyed by the derived
 * misconception identity. `per-record` because each learner's cycle advances
 * on its own. Invalid rows fail the domain open loudly: the row carries the
 * stage that decides what the learner is taught next.
 */
export const misconceptionDomainSpec = defineDomain({
  name: 'mentor_misconception',
  version: 1,
  layout: 'per-record',
  tables: {
    pipelines: domainTable<string, MisconceptionPipelineRow>(misconceptionPipelineRow),
  },
})
