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
  portfolio: z.array(z.string()),
  novelOperators: z.array(z.string()),
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
  winnerOperator: z.string().nullable(),
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
 * The identity of one experiment: what a run tried, independent of when it ran
 * or what it measured. Two runs with the same key ask the same question of the
 * same body through the same mutation lineup, so the second one can read the
 * first one's outcome instead of paying to rediscover it.
 * @param parts - the hypothesis one run poses.
 * @returns the key, stable under scenario and operator ordering.
 */
export function experimentKey(parts: {
  skill: string
  evidence: string
  scenarios: readonly string[]
  portfolio: readonly string[]
  bodySha: string
  provider: string
  model: string
}): string {
  return JSON.stringify([
    parts.skill,
    parts.evidence,
    [...parts.scenarios].sort(),
    [...parts.portfolio].sort(),
    parts.bodySha,
    parts.provider,
    parts.model,
  ])
}

/** One recorded outcome, named in the terms a run report uses. */
const OUTCOME_TEXT: Record<ExperimentRecord['outcome'], string> = {
  staged: 'it staged a promotion',
  regressed: 'its winner was dominated by an approved result',
  unconfirmed: 'its winner lost a repeat comparison',
  'holdout-rejected': 'its winner was dominated by the baseline on the holdout',
  'no-improvement': 'nothing beat the baseline',
  skipped: 'it could not be evaluated',
}

/**
 * Name what an earlier run of the same experiment decided, for the reason a
 * later run reports when it refuses to repeat it.
 * @param record - the earlier run's ledger row.
 * @returns the outcome in prose.
 */
export function describeOutcome(record: ExperimentRecord): string {
  return OUTCOME_TEXT[record.outcome]
}

/**
 * Whether a recorded run reached evaluation. A run that never scored a
 * baseline recorded no result, so it is not memory: repeating it is the only
 * way to get the answer it failed to produce.
 * @param row - one ledger row.
 * @returns true when the run measured something.
 */
export function hasResult(row: ExperimentRecord): boolean {
  return row.baseline !== null
}

/**
 * Find the newest recorded run of one experiment.
 * @param rows - one scope's ledger rows, newest first.
 * @param key - experiment identity, from {@link experimentKey}.
 * @returns the earlier run that measured something, or undefined when this experiment is new.
 */
export function repeatedExperiment(rows: readonly ExperimentRecord[], key: string): ExperimentRecord | undefined {
  return rows.find(row => hasResult(row) && experimentKey(row) === key)
}

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
