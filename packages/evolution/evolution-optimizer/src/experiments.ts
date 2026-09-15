/**
 * The evolution-optimizer experiment domain: one durable row per run that
 * reached evaluation, so a later run (or a human) can see what was tried,
 * what it measured, and why it did or did not promote. Zod validates the
 * shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-optimizer/experiments
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ExperimentRecord, ExperimentsQuery } from './types.ts'

/** One measured triple at the durable boundary. */
export const experimentTripleSchema = z.object({
  pass: z.boolean(),
  tokens: z.number().nonnegative(),
  wallTimeMs: z.number().nonnegative(),
})

/** Durability and searchability facts about one optimization run. */
export const experimentRecordSchema = z.object({
  id: z.string(),
  at: z.string(),
  scope: z.string(),
  skill: z.string(),
  evidence: z.string(),
  operators: z.array(z.string()),
  scenarios: z.array(z.string()),
  holdout: z.array(z.string()),
  baseline: experimentTripleSchema.nullable(),
  winner: experimentTripleSchema.nullable(),
  confidence: z.object({
    runs: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
  }).nullable(),
  samples: z.number().int().nonnegative(),
  outcome: z.enum(['staged', 'regressed', 'unconfirmed', 'holdout-rejected', 'no-improvement', 'skipped']),
  reason: z.string().nullable(),
  stagedId: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  bodySha: z.string(),
  winnerSha: z.string().nullable(),
})

/** One stored experiment row, inferred from {@link experimentRecordSchema}. */
export type ExperimentRecordRow = z.infer<typeof experimentRecordSchema>

/**
 * The evolution-optimizer domain spec: one `records` table keyed by
 * experiment id. Invalid records fail the domain open loudly: a dropped
 * outcome would hide a promotion the ledger claims happened.
 */
export const optimizerDomainSpec = defineDomain({
  name: 'evolution_experiments',
  version: 1,
  layout: 'per-record',
  tables: {
    records: domainTable<string, ExperimentRecord>(experimentRecordSchema),
  },
})

/**
 * Select the records a scope must drop to stay within its retention cap.
 * @param rows - every record the scope holds.
 * @param keep - how many newest records the scope keeps.
 * @returns the stale records, oldest first; empty while the cap is met.
 */
export function staleExperiments(rows: readonly ExperimentRecord[], keep: number): readonly ExperimentRecord[] {
  if (rows.length <= keep) return []
  return [...rows]
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id))
    .slice(0, rows.length - keep)
}

/**
 * Select one page from a scope's ledger, newest first.
 * @param rows - every record the ledger holds.
 * @param scope - scope identity the page is limited to.
 * @param query - optional skill filter and page size.
 * @param pageSize - rows returned when the query names no limit.
 * @returns the page, newest first.
 */
export function experimentPage(
  rows: readonly ExperimentRecord[],
  scope: string,
  query: ExperimentsQuery,
  pageSize: number,
): readonly ExperimentRecord[] {
  const skill = query.skill
  return [...rows]
    .filter(row => row.scope === scope && (skill === undefined || row.skill === skill))
    .sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id))
    .slice(0, query.limit ?? pageSize)
}
