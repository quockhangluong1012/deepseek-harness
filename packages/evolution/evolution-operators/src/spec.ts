/**
 * The evolution-operators domain declaration: durable per-operator and
 * per-artifact-class mutation statistics, and the instruction proposal each
 * operator and class holds with the verdicts recorded for it. Zod validates
 * the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-operators/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { OperatorInstruction, OperatorStats } from './types.ts'

/** Durable shape of one operator's statistics. */
export const operatorStatsRow = z.object({
  operator: z.string(),
  artifactClass: z.string(),
  attempts: z.number(),
  accepted: z.number(),
  meanDelta: z.number(),
  regressionRate: z.number(),
  lastAt: z.string(),
})

/** Durable shape of one operator's proposed instruction. */
export const operatorInstructionRow = z.object({
  operator: z.string(),
  artifactClass: z.string(),
  instruction: z.string(),
  reason: z.string(),
  proposals: z.number(),
  accepted: z.number(),
  rejected: z.number(),
  lastVerdict: z.string().nullable(),
  at: z.string(),
  decidedAt: z.string().nullable(),
})

/** One stored statistics row, inferred from {@link operatorStatsRow}. */
export type OperatorStatsRow = z.infer<typeof operatorStatsRow>

/** One stored instruction row, inferred from {@link operatorInstructionRow}. */
export type OperatorInstructionRow = z.infer<typeof operatorInstructionRow>

/**
 * The evolution-operators domain spec: a `stats` table keyed by operator and
 * artifact class joined, and an `instructions` table keyed the same way
 * holding the proposal that pair currently carries. `per-record` because each
 * pair is independent. Invalid rows fail the domain open loudly: ranking
 * trusts the numbers it reads.
 */
export const operatorsDomainSpec = defineDomain({
  name: 'evolution_operators',
  version: 1,
  layout: 'per-record',
  tables: {
    stats: domainTable<string, OperatorStats>(operatorStatsRow),
    instructions: domainTable<string, OperatorInstruction>(operatorInstructionRow),
  },
})
